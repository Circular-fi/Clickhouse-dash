#pragma once

// The identity token of the access of humans (docs/access.md, contract 11.3). The access gateway authenticates the human
// and gives the server a short JWT in one request header. The server verifies the signature (Ed25519, or ES256),
// `iss`, `aud`, `exp` and the duration `exp - iat` on each request. The token holds no permission: the PDP gives them.
//
// The public keys come from the configuration as PEM text (one or more SubjectPublicKeyInfo blocks) or as a JWK Set (RFC 7517).
// ChDash never fetches a key: a `jku`, `x5u` or `jwk` member of the token header has no effect.
// The header `typ` must be "JWT". The header `kid`, when present, selects the key.

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
  // The `kid` of the key: the `kid` that the JWK declares, or else the JWK thumbprint of the key (RFC 7638, base64url).
  // The header `kid` of a token selects the key with the same `kid`.
  std::string kid;
};

// The keys of a text. When the text starts with "{", it is a JWK Set (RFC 7517): an object with a "keys" array of 1 to 16 keys.
// Each key is kty OKP (crv Ed25519, x) or kty EC (crv P-256, x, y), with an optional `kid`. A key with a private member
// (`d`) or with another kty or crv is an error. The `use` member has no effect. The `alg` member, if present, must agree with the kty.
// Else the text is PEM: each block "-----BEGIN PUBLIC KEY-----" ... "-----END PUBLIC KEY-----" is one Ed25519 key or one
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
  // The tolerance for the clocks (access.identity.clock_skew): `iat` and `nbf` can be this far in the future, and a token
  // is refused only when now > exp + clock_skew_s. 0 means no tolerance.
  int64_t clock_skew_s = 60;
  // The verified tokens that are kept (the SHA-256 of the token, its subject and its exp). 0 = none.
  size_t cache_entries = 4096;
};

struct IdentityResult {
  bool ok = false;
  std::string subject;
  int64_t expires_at = 0;
  // Why the token is refused, for the log (never sent to the client): "missing", "malformed", "algorithm", "kid", "signature",
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
