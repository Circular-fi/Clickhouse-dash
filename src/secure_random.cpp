#include "secure_random.hpp"

#include <cerrno>
#include <stdexcept>

#include <fcntl.h>
#include <unistd.h>
#if defined(__linux__)
#include <sys/random.h>
#endif

namespace chdash {

namespace {

constexpr char kHex[] = "0123456789abcdef";

} // namespace

void secure_random_bytes(uint8_t* out, size_t n) {
  size_t done = 0;
#if defined(__linux__)
  while (done < n) {
    const ssize_t got = ::getrandom(out + done, n - done, 0);
    if (got < 0) {
      if (errno == EINTR) continue;
      break;
    }
    done += static_cast<size_t>(got);
  }
#endif
  if (done < n) {
    const int fd = ::open("/dev/urandom", O_RDONLY | O_CLOEXEC);
    if (fd < 0) throw std::runtime_error("no source of random bytes");
    while (done < n) {
      // The fallback of getrandom: /dev/urandom never blocks, and the analyzer sees a caller that holds a lock.
      const ssize_t got = ::read(fd, out + done, n - done);  // NOLINT(clang-analyzer-unix.BlockInCriticalSection)
      if (got < 0 && errno == EINTR) continue;
      if (got <= 0) {
        ::close(fd);
        throw std::runtime_error("cannot read random bytes");
      }
      done += static_cast<size_t>(got);
    }
    ::close(fd);
  }
}

std::vector<uint8_t> secure_random_bytes(size_t n) {
  std::vector<uint8_t> out(n);
  if (n > 0) secure_random_bytes(out.data(), n);
  return out;
}

std::string random_uuid_v4() {
  uint8_t bytes[16];
  secure_random_bytes(bytes, sizeof(bytes));
  bytes[6] = static_cast<uint8_t>((bytes[6] & 0x0f) | 0x40);  // version 4
  bytes[8] = static_cast<uint8_t>((bytes[8] & 0x3f) | 0x80);  // variant 10
  std::string out;
  out.reserve(36);
  for (size_t i = 0; i < sizeof(bytes); ++i) {
    if (i == 4 || i == 6 || i == 8 || i == 10) out.push_back('-');
    out.push_back(kHex[bytes[i] >> 4]);
    out.push_back(kHex[bytes[i] & 15]);
  }
  return out;
}

std::string random_hex(size_t bytes) {
  const std::vector<uint8_t> raw = secure_random_bytes(bytes);
  std::string out;
  out.reserve(bytes * 2);
  for (const uint8_t b : raw) {
    out.push_back(kHex[b >> 4]);
    out.push_back(kHex[b & 15]);
  }
  return out;
}

} // namespace chdash
