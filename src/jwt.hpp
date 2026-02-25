#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace chdash {

struct JwtClaims {
  std::string query_id; // qid
  std::string host_id;  // hid
  int64_t issued_at_unix = 0; // iat
};

class JwtService {
public:
  // HS256 only.
  explicit JwtService(std::vector<uint8_t> secret);

  std::string sign_cancel_token(const JwtClaims& c) const;
  std::optional<JwtClaims> verify_cancel_token(const std::string& token) const;

private:
  std::vector<uint8_t> secret_;
};

} // namespace chdash
