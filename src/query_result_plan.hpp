#pragma once

// How a result of a query is carried to the browser (docs/query.md, "Result transport"): the plan of each column (passed as it is, as the
// text of toString() or toJSONString(), or opaque), the SQL that wraps a statement to make that plan true, the recent plans that DESCRIBE
// gave (kept by the server for the sessions), and the rules that choose when to use them. Pure functions and one cache: no connection.

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

// The recent DESCRIBE plans of complex SELECTs, shared by the sessions that one server runs (Server owns it). The plan type is private to
// query_result_plan.cpp.
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

// ClickHouse may pretty-print complex types returned by DESCRIBE with newlines and indentation: the type on one line, still parseable.
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

// Adds the columns that one block of the answer of DESCRIBE (name, type) holds.
void add_described_columns(const clickhouse::Block& block, ResultPlan* described);
// The plan of each column of a block of the result, by position when the counts agree, else by name; null for a column that the plan lacks.
std::vector<const ResultColumnPlan*> resolve_column_plans(const clickhouse::Block& block, const ResultPlan& plan);
std::string build_projected_expr(const std::string& col_name, const ResultColumnPlan& plan);
// The statement wrapped in a SELECT that converts the columns that need it; the statement itself when none does.
std::string build_transport_wrapper_sql(const std::string& original_sql, const std::vector<std::pair<std::string, ResultColumnPlan>>& columns,
                                        bool* used_wrapper_out = nullptr);
// Whether the message of a failure of the direct path says that a driver could not read a type: the statement is then retried with DESCRIBE.
bool should_retry_with_describe_after_direct_path_error(std::string_view msg);

// ---- the cache ----
std::string describe_cache_key(std::string_view host_id, std::string_view database, std::string_view sql);
std::optional<ResultPlan> get_cached_describe_plan(DescribePlanCache* cache, const std::string& key, size_t max_entries, int ttl_ms);
void put_cached_describe_plan(DescribePlanCache* cache, const std::string& key, ResultPlan plan, size_t max_entries, int ttl_ms);
void invalidate_cached_describe_plan(DescribePlanCache* cache, const std::string& key);

} // namespace chdash
