#pragma once

// What a request of the query library says, and how it is refused: the error of the API (it never holds saved SQL), the readers of the
// fields of a JSON body (each throws a LibraryError that names the field), the text rules, and the If-Match header. No state and no file.

#include "query_library.hpp"

#include <rapidjson/document.h>

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace chdash {
namespace qlib {

int64_t now_ms();

// An API error. The message never contains saved SQL.
struct LibraryError {
  int status = 400;
  std::string code;
  std::string message;
  std::string field;
  std::string reason;
  std::optional<int64_t> revision;
  std::optional<size_t> folders;
  std::optional<size_t> queries;
  std::string load_error;
};

LibraryError validation(std::string field, std::string reason, std::string message);
LibraryError too_large(std::string field, std::string message);
LibraryError not_found(std::string message);
LibraryError host_mismatch(const std::string& field, const std::string& message);

// The one error answer of the API (error_envelope.hpp), with what a client reads to fix the call.
QueryLibraryStore::Response render_error(const LibraryError& e);

// ---- text ----
std::string trim_ascii(std::string_view s);
std::string fold_ascii(std::string_view s);
bool has_control(std::string_view s, bool allow_whitespace);
std::string truncate_utf8(std::string s, size_t max_bytes);

// ---- the fields of a body ----
std::string read_name(const rapidjson::Value* v, const std::string& field);
std::string read_description(const rapidjson::Value* v, const std::string& field);
// null -> root; string -> id (existence checked by the caller).
std::optional<std::string> read_ref(const rapidjson::Value* v, const std::string& field);
std::string read_sql(const rapidjson::Value* v, const std::string& field, size_t max_bytes);
// A body field holding a host id: absent / null -> nullopt (the store then answers "required"); anything but a string is a type error.
std::optional<std::string> read_host_field(const rapidjson::Value* v, const std::string& field);
std::optional<int64_t> read_opt_int(const rapidjson::Value* v, const std::string& field);
rapidjson::Document parse_body(std::string_view body);

// The revision of an If-Match header; nullopt for "*".
std::optional<int64_t> parse_if_match_revision(const std::string& raw);

}  // namespace qlib
}  // namespace chdash
