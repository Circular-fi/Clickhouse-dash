#include "mcp_tools.hpp"

#include "mcp_api_tools.hpp"
#include "mcp_scope.hpp"
#include "mcp_tool_support.hpp"
#include "mcp_tools_units.hpp"

namespace chdash {

std::vector<std::string> mcp_data_tables(const McpObservabilityConfig& config, unsigned reads) {
  std::vector<std::string> out;
  const auto add = [&](const std::string& database, const std::string& table) {
    if (!database.empty() && !table.empty()) out.push_back(database + "." + table);
  };
  if ((reads & kMcpReadsTraces) && config.traces) add(config.traces_database, config.traces_table);
  if ((reads & kMcpReadsLogs) && config.logs) add(config.logs_database, config.logs_table);
  if ((reads & kMcpReadsMetrics) && config.metrics) {
    for (const char* kind : {"gauge", "sum", "histogram"}) add(config.metrics_database, config.metrics_prefix + "_" + kind);
  }
  return out;
}

McpToolOutcome McpTools::call_tool(const McpKey& key, const std::string& tool, const rapidjson::Value& arguments,
                                   int64_t) {
  using namespace mcp_tools;
  Ctx ctx = make_ctx(key, config_, db_);
  ctx.api = api_;
  McpToolOutcome outcome;
  try {
    std::string json;
    const McpToolInfo* info = mcp_find_tool(tool);
    if (info && info->api) json = tool_api(ctx, *info, arguments);
    else if (tool == "list_hosts") json = tool_list_hosts(ctx, arguments);
    else if (tool == "list_databases") json = tool_list_databases(ctx, arguments);
    else if (tool == "list_tables") json = tool_list_tables(ctx, arguments);
    else if (tool == "describe_table") json = tool_describe_table(ctx, arguments);
    else if (tool == "query_table") json = tool_query_table(ctx, arguments);
    else if (tool == "list_services") json = tool_list_services(ctx, arguments);
    else if (tool == "search_traces") json = tool_search_traces(ctx, arguments);
    else if (tool == "get_trace") json = tool_get_trace(ctx, arguments);
    else if (tool == "search_logs") json = tool_search_logs(ctx, arguments);
    else if (tool == "list_metrics") json = tool_list_metrics(ctx, arguments);
    else if (tool == "query_metric") json = tool_query_metric(ctx, arguments);
    else if (tool == "run_query") json = tool_run_query(ctx, arguments);
    else if (tool == "explain_query") json = tool_explain_query(ctx, arguments);
    else return mcp_tool_error("unknown_tool", "unknown tool " + tool);
    outcome.json = std::move(json);
  } catch (const ToolFailure& failure) {
    outcome = mcp_tool_error(failure.code, failure.message);
  }
  outcome.host = ctx.host;
  outcome.rows = ctx.rows_out;
  return outcome;
}

} // namespace chdash
