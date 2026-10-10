#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace chdash {

// The one source of unpredictable values of the server: the identifiers that work as a capability (query_id,
// export_id), the signing secret of the tokens, the MCP secrets and internal token, and the temporary file names.
// The bytes come from the system CSPRNG (getrandom, else /dev/urandom); a failure of both throws std::runtime_error.
// Never a seeded std::mt19937: one observed output gives its seed away, and the next values with it.
void secure_random_bytes(uint8_t* out, size_t n);
std::vector<uint8_t> secure_random_bytes(size_t n);

// A version 4 UUID (RFC 9562: 122 random bits), lower case, with hyphens.
std::string random_uuid_v4();

// `bytes` random bytes as 2 * bytes lower-case hexadecimal digits.
std::string random_hex(size_t bytes);

} // namespace chdash
