#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace chdash {

// SHA-256 and a constant-time byte comparison, shared with the MCP key store.
std::array<uint8_t, 32> sha256_digest(const uint8_t* data, size_t len);
bool constant_time_equal(const uint8_t* a, const uint8_t* b, size_t n);

struct JwtClaims {
  std::string query_id; // qid
  std::string host_id;  // hid
  int64_t issued_at_unix = 0; // iat
  int64_t expires_at_unix = 0; // exp
};

struct ExportJwtClaims {
  std::string export_id; // eid
  std::string host_id;   // hid
  int64_t issued_at_unix = 0;
  int64_t expires_at_unix = 0;
};

class JwtService {
public:
  // HS256 internal capabilities only. The panel has no end-user authentication.
  explicit JwtService(std::vector<uint8_t> secret);

  std::string sign_cancel_token(const JwtClaims& c) const;
  std::optional<JwtClaims> verify_cancel_token(
      const std::string& token,
      int64_t now_unix) const;

  std::string sign_export_token(const ExportJwtClaims& c) const;
  std::optional<ExportJwtClaims> verify_export_token(
      const std::string& token,
      int64_t now_unix) const;

private:
  std::vector<uint8_t> secret_;
};

} // namespace chdash
