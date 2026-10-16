#pragma once

// The signature checks of the identity token (docs/access.md): Ed25519 (the JWS algorithm EdDSA, RFC 8037) and ECDSA on
// P-256 with SHA-256 (ES256, RFC 7518). Only public keys go through this unit. The code of the curves is Monocypher (Ed25519)
// and micro-ecc (P-256): this file is the one place that calls them.

#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace chdash {

using Ed25519PublicKey = std::array<uint8_t, 32>;
// The point of a P-256 key without its prefix 0x04: X then Y, 32 bytes each, big-endian.
using P256PublicKey = std::array<uint8_t, 64>;

// True when the 64 bytes are a valid Ed25519 signature of `message` with `key`. A signature with S not in its canonical
// range is refused.
bool ed25519_verify(const Ed25519PublicKey& key, std::string_view message, const uint8_t* signature, size_t signature_size);

// True when `key` is a point of the curve P-256 (not the point at infinity).
bool p256_public_key_valid(const P256PublicKey& key);

// True when the 64 bytes (R then S, 32 bytes each, big-endian: the JWS form) are a valid ES256 signature of `message`.
bool es256_verify(const P256PublicKey& key, std::string_view message, const uint8_t* signature, size_t signature_size);

} // namespace chdash
