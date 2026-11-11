#pragma once

// The effect of an operation (ProcurAuth 17.3): a hash that binds the service, the action, the resource and the operation.
// Pure code: no I/O, no PDP, no HTTP. It uses the SHA-256 of jwt.hpp and no other crypto.
//
// The hash input is the JSON object {"v":1,"service":S,"action":A,"resource":R,"op":O}. ChDash writes it as JSON text with
// the canonical form of RFC 8785 (JCS), encodes it in UTF-8, and takes the SHA-256 of the bytes. The effect is the text
// "sha256:" and the 64 lower-case hexadecimal digits of the hash. The vectors of ProcurAuth (conformance/vectors/effect.json,
// tests/conformance/effect-vectors.json) test this code.

#include <string>
#include <string_view>

namespace chdash {

// The canonical form (RFC 8785) of one JSON text, under the rules of ProcurAuth 17.3 for `op`:
// - the members of an object sort by the UTF-16 code units of their names;
// - a string has the short escapes, and \u00xx in lower case for the other control characters; no other character is escaped;
// - an integer is the only kind of number: `0`, or digits with no zero at the start, with an optional minus sign. Its value is
//   from -(2^53-1) to 2^53-1. A fraction, an exponent, "-0", and a larger value are not valid;
// - an object with a duplicate name, a string with an unpaired surrogate or with bytes that are not UTF-8, and a text of more than
//   64 levels are not valid.
// The result is false, and `*error` says why, for a text that is not valid. `*out` is not changed then.
bool jcs_canonicalize(std::string_view json, std::string* out, std::string* error);

// The same, and the text must be a JSON object (an `op`).
bool jcs_canonicalize_object(std::string_view json, std::string* out, std::string* error);

// The text of a resource for the effect: the path of the node below the service ("host:prod", "host:prod/database:a%2Fb"), and the
// empty text for the service itself. `path` is the path that access_resource_path gives ("service:<id>/host:<id>...").
std::string approval_resource_text(std::string_view path);

// The effect of an operation. `op_json` is the JSON text of the `op` (an object that follows the rules above). On success,
// `*effect` holds "sha256:" and 64 hexadecimal digits. `*canonical_op` (when it is not null) holds the canonical text of `op`, which is
// the text that the effect covers. The result is false, and `*error` says why, when `op_json` is not valid or when a text is not UTF-8.
bool approval_effect(std::string_view service, std::string_view action, std::string_view resource, std::string_view op_json,
                     std::string* effect, std::string* canonical_op, std::string* error);

// The input of the hash, as the canonical text (the text that the vectors call "canonical"). For the tests.
bool approval_effect_input(std::string_view service, std::string_view action, std::string_view resource, std::string_view op_json,
                           std::string* canonical, std::string* error);

} // namespace chdash
