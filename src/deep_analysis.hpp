#pragma once

#include "ch_client_pool.hpp"
#include "query_registry.hpp"

#include <cstddef>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace chdash {

struct DeepPlanNode {
  std::string id;
  std::string parent_id;
  size_t depth = 0;
  std::string label;
  std::vector<std::string> details;
};

struct DeepAnalysisSummary {
  std::string time;
  std::string read;
  std::string peak_memory;
  std::string output;
};

struct DeepAnalysisResult {
  std::string deep_query_id;
  DeepAnalysisSummary summary;
  std::vector<DeepPlanNode> nodes;
  std::vector<std::string> lines;
};

struct DeepAnalysisError {
  std::string code;
  std::string message;
  int http_status = 400;
};

// Version 1 limits Deep Analyze to SELECT-family statements.
// The cheap lexical gate runs first.
// ClickHouse EXPLAIN AST parses the query before it runs again.
bool deep_analysis_candidate_sql(const std::string& sql);

// The checks that need no ClickHouse: the SQL is kept and is a SELECT-family statement. False sets `error` (409).
bool deep_analysis_precheck(const QueryRegistryRecord& record, DeepAnalysisError* error);

// Runs the analysis on the connection of the runner. `query_started` receives the id of each ClickHouse statement before the statement starts.
// A cancel can then KILL the statement. A statement that sends nothing for a long time never reaches the checks of a caller that went away.
// A canceled scope (ch_query.hpp) ends the analysis with the code "canceled".
bool run_deep_analysis(
    const QueryRegistryRecord& record,
    const std::string& runner_uri,
    const std::shared_ptr<ClickHouseClientPool>& client_pool,
    DeepAnalysisResult* result,
    DeepAnalysisError* error,
    const std::function<void(const std::string&)>& query_started = {});

} // namespace chdash
