#pragma once

// The access { } block of the configuration (docs/access.md, contract 11.2). The file must have the block: without it the
// start stops, so nobody gets the open mode by mistake.
//
//   access {
//     mode = "authzen"                 # or "open"
//     identity { header, issuer, audience, public_keys | public_keys_env | public_keys_file, max_age }
//     pdp      { url | url_env | url_file, token_env | token_file, timeout, cache_ttl }
//   }

#include "access_identity.hpp"
#include "telemetry_settings.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace chdash {

enum class AccessMode {
  // No identity and no permission is checked. The start writes a warning.
  Open,
  // The identity token on each request of the pages and of the API, and a decision of the PDP for each action.
  Authzen,
};

struct AccessSettings {
  // The value of an AppConfig that code makes (the tests). The file always names the mode.
  AccessMode mode = AccessMode::Open;
  // identity { }
  std::string header = "X-Identity-Token";
  std::string issuer;
  std::string audience;
  std::vector<IdentityKey> keys;
  int64_t max_age_ms = 5 * 60 * 1000;
  // pdp { }
  std::string pdp_url;
  OtlpEndpoint pdp_endpoint;
  std::string pdp_token;
  int64_t pdp_timeout_ms = 500;
  int64_t pdp_cache_ttl_ms = 30 * 1000;

  bool enforced() const { return mode == AccessMode::Authzen; }
};

} // namespace chdash
