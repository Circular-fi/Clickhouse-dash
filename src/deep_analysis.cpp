#include "deep_analysis.hpp"

#include "ch_uri.hpp"
#include "sql_scan.hpp"

#include <clickhouse/client.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cctype>
#include <cstdint>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string_view>
#include <utility>

namespace chdash {
namespace {

constexpr size_t kMaxDeepAnalysisLines = 20000;
constexpr size_t kMaxDeepAnalysisBytes = 8 * 1024 * 1024;

std::string trim_copy(std::string_view value) {
  size_t begin = 0;
  while (begin < value.size() && std::isspace(static_cast<unsigned char>(value[begin]))) ++begin;
  size_t end = value.size();
  while (end > begin && std::isspace(static_cast<unsigned char>(value[end - 1]))) --end;
  return std::string(value.substr(begin, end - begin));
}

bool starts_with(std::string_view value, std::string_view prefix) {
  return value.size() >= prefix.size() && value.substr(0, prefix.size()) == prefix;
}

std::string make_deep_query_id(const std::string& query_id, std::string_view phase) {
  static std::atomic<uint64_t> counter{0};
  const auto now = std::chrono::steady_clock::now().time_since_epoch();
  const auto micros = std::chrono::duration_cast<std::chrono::microseconds>(now).count();
  std::ostringstream out;
  out << query_id << "-deep-" << phase << '-' << std::hex
      << static_cast<uint64_t>(micros) << '-' << counter.fetch_add(1, std::memory_order_relaxed);
  return out.str();
}

std::shared_ptr<clickhouse::Client> acquire_runner(
    const std::shared_ptr<ClickHouseClientPool>& pool,
    const std::string& uri,
    std::string* error) {
  return pool ? pool->acquire(
      uri,
      std::chrono::seconds(5),
      std::chrono::milliseconds(0),
      std::chrono::milliseconds(0),
      error)
    : make_client_from_uri(
      uri,
      std::chrono::seconds(5),
      std::chrono::milliseconds(0),
      std::chrono::milliseconds(0),
      error);
}

void append_explain_block(
    const clickhouse::Block& block,
    std::vector<std::string>& lines,
    size_t& total_bytes) {
  if (block.GetColumnCount() == 0 || block.GetRowCount() == 0) return;
  const auto strings = block[0]->As<clickhouse::ColumnString>();
  if (!strings) throw std::runtime_error("ClickHouse EXPLAIN returned a non-String payload.");

  for (size_t row = 0; row < block.GetRowCount(); ++row) {
    const std::string_view value = strings->At(row);
    if (lines.size() >= kMaxDeepAnalysisLines ||
        value.size() > kMaxDeepAnalysisBytes ||
        total_bytes > kMaxDeepAnalysisBytes - value.size()) {
      throw std::runtime_error("Deep Analyze output exceeds the backend safety limit.");
    }
    lines.emplace_back(value);
    total_bytes += value.size();
  }
}

std::vector<std::string> execute_explain(
    clickhouse::Client& client,
    const std::string& sql,
    const std::string& query_id) {
  std::vector<std::string> lines;
  size_t bytes = 0;
  clickhouse::Query query(sql, query_id);
  query.OnData([&](const clickhouse::Block& block) {
    append_explain_block(block, lines, bytes);
  });
  client.Select(query);
  return lines;
}

bool ast_is_select_family(const std::vector<std::string>& lines) {
  for (const auto& line : lines) {
    const std::string value = trim_copy(line);
    if (value.empty()) continue;
    // SELECT, UNION, WITH ... SELECT, and SELECT-family subqueries all have a
    // SelectWithUnionQuery root in the 26.7 AST representation.
    return starts_with(value, "SelectWithUnionQuery") || starts_with(value, "SelectQuery");
  }
  return false;
}

std::string strip_tree_prefix(std::string_view line, size_t* depth, bool* has_connector) {
  static constexpr std::string_view branch_last = u8"└──";
  static constexpr std::string_view branch_mid = u8"├──";

  size_t marker = line.find(branch_last);
  size_t marker_size = branch_last.size();
  if (marker == std::string_view::npos) {
    marker = line.find(branch_mid);
    marker_size = branch_mid.size();
  }

  if (marker != std::string_view::npos) {
    // ClickHouse uses three display columns per tree level. Before the branch
    // marker the cell contains spaces and vertical tree bars; replacing each
    // UTF-8 bar with one display column keeps the depth calculation stable.
    size_t display_columns = 0;
    for (size_t i = 0; i < marker;) {
      if (line.substr(i, 3) == u8"│") {
        ++display_columns;
        i += 3;
      } else {
        ++display_columns;
        ++i;
      }
    }
    *depth = display_columns / 3 + 1;
    *has_connector = true;
    return trim_copy(line.substr(marker + marker_size));
  }

  *depth = 0;
  *has_connector = false;
  return trim_copy(line);
}

void parse_explain_analyze(const std::vector<std::string>& lines, DeepAnalysisResult& result) {
  result.lines = lines;
  bool plan_started = false;
  std::vector<std::string> stack;
  DeepPlanNode* last_node = nullptr;

  for (const auto& raw : lines) {
    const std::string trimmed = trim_copy(raw);
    if (trimmed.empty()) continue;

    if (trimmed == "Query summary:") continue;
    if (starts_with(trimmed, "Time:")) {
      result.summary.time = trim_copy(std::string_view(trimmed).substr(5));
      continue;
    }
    if (starts_with(trimmed, "Read:")) {
      result.summary.read = trim_copy(std::string_view(trimmed).substr(5));
      continue;
    }
    if (starts_with(trimmed, "Peak memory:")) {
      result.summary.peak_memory = trim_copy(std::string_view(trimmed).substr(12));
      continue;
    }
    if (starts_with(trimmed, "Output:")) {
      result.summary.output = trim_copy(std::string_view(trimmed).substr(7));
      plan_started = true;
      continue;
    }

    if (!plan_started) continue;

    size_t depth = 0;
    bool has_connector = false;
    const std::string label = strip_tree_prefix(raw, &depth, &has_connector);
    if (label.empty()) continue;

    const bool is_root = result.nodes.empty() && !has_connector;
    const bool is_node = is_root || has_connector;
    if (!is_node) {
      if (last_node) last_node->details.push_back(label);
      continue;
    }

    DeepPlanNode node;
    node.id = "n" + std::to_string(result.nodes.size());
    node.depth = is_root ? 0 : depth;
    node.label = label;

    if (node.depth > 0) {
      const size_t parent_depth = node.depth - 1;
      if (parent_depth < stack.size()) node.parent_id = stack[parent_depth];
    }

    if (stack.size() <= node.depth) stack.resize(node.depth + 1);
    stack[node.depth] = node.id;
    stack.resize(node.depth + 1);

    result.nodes.push_back(std::move(node));
    last_node = &result.nodes.back();
  }
}

void set_error(DeepAnalysisError* error, int status, std::string code, std::string message) {
  if (!error) return;
  error->http_status = status;
  error->code = std::move(code);
  error->message = std::move(message);
}

} // namespace

bool deep_analysis_candidate_sql(const std::string& sql) {
  const std::string keyword = sql_first_keyword_lower(sql);
  return keyword == "select" || keyword == "with";
}

bool run_deep_analysis(
    const QueryRegistryRecord& record,
    const std::string& runner_uri,
    const std::shared_ptr<ClickHouseClientPool>& client_pool,
    DeepAnalysisResult* result,
    DeepAnalysisError* error) {
  if (!result) {
    set_error(error, 500, "deep_analysis_internal_error", "Deep Analyze result target is missing.");
    return false;
  }
  *result = {};

  if (record.original_sql.empty()) {
    set_error(
        error, 409, "deep_analysis_sql_unavailable",
        "The original SQL is no longer retained in the bounded analysis window.");
    return false;
  }
  if (!deep_analysis_candidate_sql(record.original_sql)) {
    set_error(
        error, 409, "deep_analysis_unsafe_query",
        "Deep Analyze is limited to SELECT-family read queries in V1.");
    return false;
  }

  std::string connect_error;
  auto client = acquire_runner(client_pool, runner_uri, &connect_error);
  if (!client) {
    set_error(
        error, 503, "runner_unavailable",
        connect_error.empty() ? "Cannot connect to the runner context." : connect_error);
    return false;
  }

  try {
    // Defense in depth: let ClickHouse parse the exact original SQL and require
    // a SELECT-family root before EXPLAIN ANALYZE is allowed to execute it.
    const std::string ast_query_id = make_deep_query_id(record.query_id, "ast");
    const auto ast_lines = execute_explain(
        *client,
        "EXPLAIN AST\n" + record.original_sql,
        ast_query_id);
    if (!ast_is_select_family(ast_lines)) {
      set_error(
          error, 409, "deep_analysis_unsafe_query",
          "ClickHouse did not classify the stored query as a SELECT-family statement.");
      return false;
    }

    result->deep_query_id = make_deep_query_id(record.query_id, "run");
    const auto lines = execute_explain(
        *client,
        "EXPLAIN ANALYZE\n" + record.original_sql,
        result->deep_query_id);
    parse_explain_analyze(lines, *result);
    if (result->lines.empty()) {
      set_error(error, 502, "deep_analysis_empty", "ClickHouse returned an empty EXPLAIN ANALYZE result.");
      return false;
    }
    return true;
  } catch (const std::exception& e) {
    if (client_pool) client_pool->invalidate(client);
    set_error(error, 502, "deep_analysis_failed", e.what());
    return false;
  }
}

} // namespace chdash
