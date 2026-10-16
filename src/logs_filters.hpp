#pragma once

// The filters of the Logs routes apply once the table is known. The code checks what the request asks (logs_request.hpp) against the columns that the
// table has (otel_caches.hpp, LogsSchema). It writes the result as a WHERE clause. The values that a user wrote are query parameters
// (sql_params.hpp), so the clause never holds a text of a user. The code is pure: it reads no clock (the caller gives `now_ms`) and it does not use ClickHouse.

#include "error_envelope.hpp"
#include "logs_request.hpp"
#include "otel_caches.hpp"
#include "otel_settings.hpp"
#include "sql_params.hpp"

#include <cstdint>
#include <map>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace chdash {
namespace logs {

// ---- the schema of the table ----

// The columns of the table (name -> type) and what it says about its optional columns.
LogsSchema schema_from_columns(const std::map<std::string, std::string>& columns);
// The skipping indexes (type, expression): which of them serve a search of Body. Call only for a table that exists.
void apply_skipping_indexes(LogsSchema* schema, const std::vector<std::pair<std::string, std::string>>& indexes);

// ---- the severity classes of the histogram and the filters ----

struct Severity {
  const char* name;
  int lo;
  int hi;  // inclusive
};

// Histogram classes: error >= 17 (fatal included), warn 13-16, info 9-12, debug below 9 (trace and unset included).
extern const Severity kSeverityClasses[4];
const Severity* severity_class(std::string_view name);

bool valid_hex_id(const std::string& id, size_t max_len);

// ---- the filters ----

// The search never keeps more than this many attribute filters.
constexpr size_t kMaxAttrFilters = 16;

struct LogsQuery {
  int64_t start_ms = 0;
  int64_t end_ms = 0;
  std::string where;  // " AND ..." filters (the allowlist included), no time predicate
  SqlParams params;   // the values of `where`: {pN:String} placeholders; every statement that has the clause sends them
  bool text_search = false;
  bool text_index_backed = false;
  std::string body_mode;  // effective body search mode
};

// False with the 400 answer in *error. `need_range` is false for the route that has no range (the context of a record).
bool build_filters(const OtelSettings& otel, const LogsSchema& schema, const FilterInput& input, int64_t now_ms, bool need_range,
                   LogsQuery* out, ApiError* error);

// The context of one record: only the preset narrows it. Returns the clause (" AND ..."), with its values in *params.
bool build_context_filter(const OtelSettings& otel, const LogsSchema& schema, const ContextRequest& request, const std::string& preset,
                          std::string* where, SqlParams* params, ApiError* error);

}  // namespace logs
}  // namespace chdash
