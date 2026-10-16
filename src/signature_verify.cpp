#include "signature_verify.hpp"

#include "jwt.hpp"

extern "C" {
#include <monocypher-ed25519.h>
#include <uECC.h>
}

namespace chdash {

bool ed25519_verify(const Ed25519PublicKey& key, std::string_view message, const uint8_t* signature, size_t signature_size) {
  if (signature == nullptr || signature_size != 64) return false;
  return crypto_ed25519_check(signature, key.data(), reinterpret_cast<const uint8_t*>(message.data()), message.size()) == 0;
}

bool p256_public_key_valid(const P256PublicKey& key) { return uECC_valid_public_key(key.data(), uECC_secp256r1()) == 1; }

bool es256_verify(const P256PublicKey& key, std::string_view message, const uint8_t* signature, size_t signature_size) {
  if (signature == nullptr || signature_size != 64) return false;
  if (!p256_public_key_valid(key)) return false;
  const auto digest = sha256_digest(reinterpret_cast<const uint8_t*>(message.data()), message.size());
  return uECC_verify(key.data(), digest.data(), static_cast<unsigned>(digest.size()), signature, uECC_secp256r1()) == 1;
}

} // namespace chdash
