#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace chdash {

// This is the one source of unpredictable values of the server.
// The values are the identifiers that work as a capability (query_id, export_id), the signing secret of the tokens, the MCP secrets and internal token, and the temporary file names.
// The bytes come from the system CSPRNG (getrandom, else /dev/urandom). If both fail, the function throws std::runtime_error.
// Never use a seeded std::mt19937. One observed output gives its seed away, and so the next values too.
void secure_random_bytes(uint8_t* out, size_t n);
std::vector<uint8_t> secure_random_bytes(size_t n);

// A version 4 UUID (RFC 9562: 122 random bits). It uses lower-case letters and hyphens.
std::string random_uuid_v4();

// The result is `bytes` random bytes as 2 * bytes lower-case hexadecimal digits.
std::string random_hex(size_t bytes);

} // namespace chdash
