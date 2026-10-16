#pragma once

// The identity token of the access of humans (docs/access.md, contract 11.3). The access gateway authenticates the human
// and gives the server a short JWT in one request header. The server verifies the signature (EdDSA with Ed25519, or ES256),
// `iss`, `aud`, `exp` and the duration `exp - iat` on each request. The token holds no permission: the PDP gives them.
//
// The public keys come from the configuration as PEM text (one or more SubjectPublicKeyInfo blocks). ChDash never fetches a
// key: a `jku`, `x5u` or `jwk` member of the token header has no effect.

#include "signature_verify.hpp"

#include <cstdint>
#include <list>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace chdash {

struct IdentityKey {
  enum class Type { Ed25519, P256 };
  Type type = Type::Ed25519;
  Ed25519PublicKey ed25519{};
  P256PublicKey p256{};
  // The JWK thumbprint of the key (RFC 7638), in base64url: the `kid` that the access gateway writes. For the log and
  // --print-config only: the verification tries each key of the algorithm.
  std::string kid;
};

// The keys of a PEM text: each block "-----BEGIN PUBLIC KEY-----" ... "-----END PUBLIC KEY-----" is one Ed25519 key or one
// P-256 key (uncompressed point). Empty lines are allowed between blocks; other text is an error. On an error, nullopt and
// `error` says what is wrong (without the key text).
std::optional<std::vector<IdentityKey>> parse_identity_public_keys(std::string_view pem, std::string* error);

// The name of the type of a key: "Ed25519" or "P-256".
const char* identity_key_type_name(IdentityKey::Type type);

struct IdentityVerifierOptions {
  std::string issuer;
  std::string audience;
  // exp - iat is at most this (milliseconds; the claims are seconds).
  int64_t max_age_ms = 300 * 1000;
  std::vector<IdentityKey> keys;
  // The tolerance for a clock of the gateway that is in advance: `iat` and `nbf` can be this far in the future. `exp` has
  // no tolerance.
  int64_t clock_skew_s = 60;
  // The verified tokens that are kept (the SHA-256 of the token, its subject and its exp). 0 = none.
  size_t cache_entries = 4096;
};

struct IdentityResult {
  bool ok = false;
  std::string subject;
  int64_t expires_at = 0;
  // Why the token is refused, for the log (never sent to the client): "missing", "malformed", "algorithm", "signature",
  // "issuer", "audience", "expired", "not_yet_valid", "max_age", "subject".
  std::string reason;
};

class IdentityVerifier {
public:
  explicit IdentityVerifier(IdentityVerifierOptions options);

  // Verifies the compact JWS `token` at the time `now_unix` (seconds). A token that was verified before is found in the
  // cache; its `exp` is checked again.
  IdentityResult verify(std::string_view token, int64_t now_unix) const;

  const IdentityVerifierOptions& options() const { return options_; }

private:
  IdentityResult verify_uncached(std::string_view token, int64_t now_unix) const;

  IdentityVerifierOptions options_;
  struct Cached {
    std::string subject;
    int64_t expires_at = 0;
  };
  mutable std::mutex mu_;
  mutable std::unordered_map<std::string, Cached> cache_;
};

} // namespace chdash
