#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace chdash {

// Streaming ZIP64 writer using STORE (no compression). It never retains entry
// payloads. Memory grows only with the small central-directory metadata list.
class Zip64StreamWriter {
public:
  using WriteFn = std::function<bool(const char*, size_t)>;

  explicit Zip64StreamWriter(WriteFn write);

  bool begin_entry(const std::string& name);
  bool write_data(const char* data, size_t size);
  bool write_data(const std::string& data) { return write_data(data.data(), data.size()); }
  bool finish_entry();
  bool finish_archive();

  bool ok() const { return ok_; }
  uint64_t bytes_written() const { return offset_; }
  const std::string& error() const { return error_; }

private:
  struct EntryMeta {
    std::string name;
    uint32_t crc32 = 0;
    uint64_t size = 0;
    uint64_t local_header_offset = 0;
    uint16_t dos_time = 0;
    uint16_t dos_date = 0;
  };

  bool write_bytes(const void* data, size_t size);
  bool write_u16(uint16_t value);
  bool write_u32(uint32_t value);
  bool write_u64(uint64_t value);
  void fail(std::string message);

  WriteFn write_;
  bool ok_ = true;
  bool entry_open_ = false;
  bool finished_ = false;
  uint64_t offset_ = 0;
  uint32_t current_crc_ = 0xffffffffU;
  uint64_t current_size_ = 0;
  EntryMeta current_;
  std::vector<EntryMeta> entries_;
  std::string error_;
};

uint32_t zip_crc32_update(uint32_t state, const char* data, size_t size);

} // namespace chdash
