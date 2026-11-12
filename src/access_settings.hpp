#pragma once

// The access { } block of the configuration (docs/access.md, contract 11.2). The file must have the block: without it the
// start stops, so nobody gets the open mode by mistake.
//
//   access {
//     mode = "authzen"                 # or "open"
//     identity { header, issuer, audience, public_keys | public_keys_env | public_keys_file, max_age, clock_skew }
//     pdp      { url | url_env | url_file, token_env | token_file, timeout, cache_ttl, ca_file, verify }
//     approval { wait, max_command_bytes }     # optional: the approval of a person for an action (ProcurAuth section 17)
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
  int64_t clock_skew_ms = 60 * 1000;
  // pdp { }
  std::string pdp_url;
  // The parts of pdp_url. pdp_endpoint.port is 443 for an https URL without a port.
  OtlpEndpoint pdp_endpoint;
  bool pdp_https = false;
  // https only. An empty file is the store of the system.
  std::string pdp_ca_file;
  bool pdp_verify = true;
  // access.pdp.insecure_link: the file accepts a link to the PDP in clear text (http to a host that is not this machine) or an https link with no
  // check of the certificate (verify = false). Default false: such a link stops the start.
  bool pdp_insecure_link = false;
  // true: use the Resource Search of the PDP to list databases (docs/access.md, "Resource Search"). Default false.
  bool pdp_search = false;
  std::string pdp_token;
  int64_t pdp_timeout_ms = 500;
  int64_t pdp_cache_ttl_ms = 30 * 1000;
  // The deadline of all the requests of one call that goes in more than one request (docs/access.md, "Decisions"). Not less than pdp_timeout_ms.
  int64_t pdp_batch_timeout_ms = 2 * 1000;
  // The highest procurauth_usage_max_seconds of the metadata of the PDP that ChDash accepts (docs/access.md, "Metadata of the PDP").
  int64_t pdp_usage_max_seconds = 120;
  // approval { } (docs/access.md, "Approval of an action"). The capability is always on.
  // The longest wait of one call for a verdict (the cap of the argument wait_s). 0: a call never waits.
  int64_t approval_wait_ms = 15 * 1000;
  // The largest compact JSON text of op and view of a request.
  int64_t approval_max_command_bytes = 16 * 1024;

  bool enforced() const { return mode == AccessMode::Authzen; }
};

} // namespace chdash
