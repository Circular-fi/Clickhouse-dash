#pragma once

#include "ch_client_pool.hpp"
#include "query_registry.hpp"

#include <cstddef>
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

// V1 deliberately limits Deep Analyze to SELECT-family statements. The cheap
// lexical gate is followed by ClickHouse's own EXPLAIN AST parser before the
// query is actually re-executed.
bool deep_analysis_candidate_sql(const std::string& sql);

bool run_deep_analysis(
    const QueryRegistryRecord& record,
    const std::string& runner_uri,
    const std::shared_ptr<ClickHouseClientPool>& client_pool,
    DeepAnalysisResult* result,
    DeepAnalysisError* error);

} // namespace chdash
