#include "zip_stream.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <ctime>
#include <limits>

namespace chdash {
namespace {

constexpr uint32_t kLocalHeader = 0x04034b50U;
constexpr uint32_t kDataDescriptor = 0x08074b50U;
constexpr uint32_t kCentralHeader = 0x02014b50U;
constexpr uint32_t kZip64End = 0x06064b50U;
constexpr uint32_t kZip64Locator = 0x07064b50U;
constexpr uint32_t kClassicEnd = 0x06054b50U;
constexpr uint16_t kVersion45 = 45;
constexpr uint16_t kFlags = 0x0808U; // UTF-8 + trailing data descriptor.
constexpr uint16_t kStore = 0;
constexpr uint16_t kZip64ExtraId = 0x0001U;

const std::array<uint32_t, 256>& crc_table() {
  static const std::array<uint32_t, 256> table = [] {
    std::array<uint32_t, 256> out{};
    for (uint32_t n = 0; n < 256; ++n) {
      uint32_t c = n;
      for (int k = 0; k < 8; ++k) c = (c & 1U) ? (0xedb88320U ^ (c >> 1U)) : (c >> 1U);
      out[n] = c;
    }
    return out;
  }();
  return table;
}

std::pair<uint16_t, uint16_t> dos_timestamp() {
  const std::time_t now = std::time(nullptr);
  std::tm tm{};
#if defined(_WIN32)
  localtime_s(&tm, &now);
#else
  localtime_r(&now, &tm);
#endif
  const int year = std::max(1980, tm.tm_year + 1900);
  const uint16_t time = static_cast<uint16_t>(
      ((tm.tm_hour & 31) << 11) | ((tm.tm_min & 63) << 5) | ((tm.tm_sec / 2) & 31));
  const uint16_t date = static_cast<uint16_t>(
      (((year - 1980) & 127) << 9) | (((tm.tm_mon + 1) & 15) << 5) | (tm.tm_mday & 31));
  return {time, date};
}

} // namespace

uint32_t zip_crc32_update(uint32_t state, const char* data, size_t size) {
  const auto& table = crc_table();
  uint32_t c = state;
  for (size_t i = 0; i < size; ++i) {
    c = table[(c ^ static_cast<unsigned char>(data[i])) & 0xffU] ^ (c >> 8U);
  }
  return c;
}

Zip64StreamWriter::Zip64StreamWriter(WriteFn write) : write_(std::move(write)) {
  if (!write_) fail("ZIP writer has no output sink");
}

void Zip64StreamWriter::fail(std::string message) {
  ok_ = false;
  if (error_.empty()) error_ = std::move(message);
}

bool Zip64StreamWriter::write_bytes(const void* data, size_t size) {
  if (!ok_) return false;
  if (size == 0) return true;
  if (!write_(static_cast<const char*>(data), size)) {
    fail("ZIP output sink closed");
    return false;
  }
  if (offset_ > std::numeric_limits<uint64_t>::max() - static_cast<uint64_t>(size)) {
    fail("ZIP64 output offset overflow");
    return false;
  }
  offset_ += static_cast<uint64_t>(size);
  return true;
}

bool Zip64StreamWriter::write_u16(uint16_t value) {
  const unsigned char b[2] = {
      static_cast<unsigned char>(value & 0xffU),
      static_cast<unsigned char>((value >> 8U) & 0xffU)};
  return write_bytes(b, sizeof(b));
}

bool Zip64StreamWriter::write_u32(uint32_t value) {
  const unsigned char b[4] = {
      static_cast<unsigned char>(value & 0xffU),
      static_cast<unsigned char>((value >> 8U) & 0xffU),
      static_cast<unsigned char>((value >> 16U) & 0xffU),
      static_cast<unsigned char>((value >> 24U) & 0xffU)};
  return write_bytes(b, sizeof(b));
}

bool Zip64StreamWriter::write_u64(uint64_t value) {
  unsigned char b[8]{};
  for (size_t i = 0; i < 8; ++i) b[i] = static_cast<unsigned char>((value >> (8U * i)) & 0xffU);
  return write_bytes(b, sizeof(b));
}

bool Zip64StreamWriter::begin_entry(const std::string& name) {
  if (!ok_ || finished_) return false;
  if (entry_open_) {
    fail("ZIP entry already open");
    return false;
  }
  if (name.empty() || name.size() > 0xffffU) {
    fail("ZIP entry name is empty or too long");
    return false;
  }

  const auto stamp = dos_timestamp();
  current_ = {};
  current_.name = name;
  current_.local_header_offset = offset_;
  current_.dos_time = stamp.first;
  current_.dos_date = stamp.second;
  current_crc_ = 0xffffffffU;
  current_size_ = 0;

  // ZIP64 local header. The final CRC and 64-bit sizes follow in a data
  // descriptor, allowing the entry to be streamed without seeking.
  if (!write_u32(kLocalHeader) || !write_u16(kVersion45) || !write_u16(kFlags) ||
      !write_u16(kStore) || !write_u16(current_.dos_time) || !write_u16(current_.dos_date) ||
      !write_u32(0) || !write_u32(0xffffffffU) || !write_u32(0xffffffffU) ||
      !write_u16(static_cast<uint16_t>(name.size())) || !write_u16(20) ||
      !write_bytes(name.data(), name.size()) || !write_u16(kZip64ExtraId) ||
      !write_u16(16) || !write_u64(0) || !write_u64(0)) {
    return false;
  }

  entry_open_ = true;
  return true;
}

bool Zip64StreamWriter::write_data(const char* data, size_t size) {
  if (!ok_ || !entry_open_) return false;
  if (size == 0) return true;
  if (!write_bytes(data, size)) return false;
  current_crc_ = zip_crc32_update(current_crc_, data, size);
  current_size_ += static_cast<uint64_t>(size);
  return true;
}

bool Zip64StreamWriter::finish_entry() {
  if (!ok_ || !entry_open_) return false;
  current_.crc32 = current_crc_ ^ 0xffffffffU;
  current_.size = current_size_;

  if (!write_u32(kDataDescriptor) || !write_u32(current_.crc32) ||
      !write_u64(current_.size) || !write_u64(current_.size)) {
    return false;
  }
  entries_.push_back(current_);
  current_ = {};
  current_size_ = 0;
  current_crc_ = 0xffffffffU;
  entry_open_ = false;
  return true;
}

bool Zip64StreamWriter::finish_archive() {
  if (!ok_ || finished_) return false;
  if (entry_open_ && !finish_entry()) return false;

  const uint64_t central_offset = offset_;
  for (const auto& entry : entries_) {
    if (!write_u32(kCentralHeader) ||
        !write_u16(kVersion45) || !write_u16(kVersion45) || !write_u16(kFlags) ||
        !write_u16(kStore) || !write_u16(entry.dos_time) || !write_u16(entry.dos_date) ||
        !write_u32(entry.crc32) || !write_u32(0xffffffffU) || !write_u32(0xffffffffU) ||
        !write_u16(static_cast<uint16_t>(entry.name.size())) || !write_u16(28) ||
        !write_u16(0) || !write_u16(0) || !write_u16(0) || !write_u32(0) ||
        !write_u32(0xffffffffU) || !write_bytes(entry.name.data(), entry.name.size()) ||
        !write_u16(kZip64ExtraId) || !write_u16(24) ||
        !write_u64(entry.size) || !write_u64(entry.size) || !write_u64(entry.local_header_offset)) {
      return false;
    }
  }
  const uint64_t central_size = offset_ - central_offset;
  const uint64_t zip64_end_offset = offset_;
  const uint64_t count = static_cast<uint64_t>(entries_.size());

  if (!write_u32(kZip64End) || !write_u64(44) || !write_u16(kVersion45) || !write_u16(kVersion45) ||
      !write_u32(0) || !write_u32(0) || !write_u64(count) || !write_u64(count) ||
      !write_u64(central_size) || !write_u64(central_offset) ||
      !write_u32(kZip64Locator) || !write_u32(0) || !write_u64(zip64_end_offset) || !write_u32(1) ||
      !write_u32(kClassicEnd) || !write_u16(0) || !write_u16(0) ||
      !write_u16(0xffffU) || !write_u16(0xffffU) || !write_u32(0xffffffffU) ||
      !write_u32(0xffffffffU) || !write_u16(0)) {
    return false;
  }
  finished_ = true;
  return true;
}

} // namespace chdash
