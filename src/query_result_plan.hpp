#pragma once

// This header describes how a query result is sent to the browser (docs/query.md, "Result transport").
// The plan of each column is passed as it is, as the text of toString() or toJSONString(), or as opaque.
// The header has the SQL that wraps a statement to make the plan true, and the recent plans that DESCRIBE gave.
// The server keeps the recent plans for the sessions. The rules choose when to use the plans.
// There are pure functions and one cache, with no connection.

#include <clickhouse/block.h>

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace chdash {

enum class ResultTransportMode {
  Passthrough,
  Stringify,
  Opaque,
};

struct ResultColumnPlan {
  std::string original_type;
  std::string transport_type;
  ResultTransportMode mode = ResultTransportMode::Passthrough;
};


using ResultPlan = std::vector<std::pair<std::string, ResultColumnPlan>>;

// The recent DESCRIBE plans of complex SELECTs. The sessions that one server runs share them. The Server owns the plans.
// The plan type is private to query_result_plan.cpp.
class DescribePlanCache {
 public:
  DescribePlanCache();
  ~DescribePlanCache();
  DescribePlanCache(const DescribePlanCache&) = delete;
  DescribePlanCache& operator=(const DescribePlanCache&) = delete;
  struct Impl;
  std::unique_ptr<Impl> impl;
};

// ---- types ----

// ClickHouse can pretty-print complex types that DESCRIBE returns, with newlines and indentation. The type is on one line, and it is still parseable.
std::string normalize_type_string(std::string s);
bool unwrap_outer_type(std::string_view type, std::string_view outer_name, std::string_view* inner_out);
bool is_top_level_nullable_type(std::string_view type);
bool is_structured_type(std::string_view type);
bool is_bool_type_name(std::string_view type);
ResultTransportMode classify_result_transport(std::string_view type);
const char* transport_mode_name(ResultTransportMode mode);

// ---- text ----
bool icontains(std::string_view hay, std::string_view needle);
bool iequals_ascii(std::string_view a, std::string_view b);
std::string strip_trailing_semicolon_copy(std::string s);

// ---- the plan from DESCRIBE, and the wrapper that makes it true ----

// Adds the columns of one block of the DESCRIBE answer. Each column has a name and a type.
void add_described_columns(const clickhouse::Block& block, ResultPlan* described);
// The plan of each column of a block of the result. The match is by position when the counts agree, and by name otherwise. The result is null for a column that the plan lacks.
std::vector<const ResultColumnPlan*> resolve_column_plans(const clickhouse::Block& block, const ResultPlan& plan);
std::string build_projected_expr(const std::string& col_name, const ResultColumnPlan& plan);
// The statement wrapped in a SELECT that converts the columns that need it. When no column needs it, the result is the statement itself.
std::string build_transport_wrapper_sql(const std::string& original_sql, const std::vector<std::pair<std::string, ResultColumnPlan>>& columns,
                                        bool* used_wrapper_out = nullptr);
// Tells whether the message of a failure of the direct path says that a driver cannot read a type. If so, the statement is retried with DESCRIBE.
bool should_retry_with_describe_after_direct_path_error(std::string_view msg);

// ---- the cache ----
std::string describe_cache_key(std::string_view host_id, std::string_view database, std::string_view sql);
std::optional<ResultPlan> get_cached_describe_plan(DescribePlanCache* cache, const std::string& key, size_t max_entries, int ttl_ms);
void put_cached_describe_plan(DescribePlanCache* cache, const std::string& key, ResultPlan plan, size_t max_entries, int ttl_ms);
void invalidate_cached_describe_plan(DescribePlanCache* cache, const std::string& key);

} // namespace chdash
