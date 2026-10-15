#pragma once

// The tools of MCP, one function each (docs/mcp.md): the context of the call and the arguments in, the JSON of the answer out. They are
// grouped as the manual groups them: schema (hosts, databases, tables), query (a table, a statement, a plan), observability (services, traces,
// logs, metrics), the API tools and the analysis of the keys. mcp_tools.cpp picks one by the name of the tool.

#include "mcp_tool_support.hpp"

namespace chdash {
namespace mcp_tools {

// schema
std::string tool_list_hosts(Ctx& ctx, const rapidjson::Value& args);
std::string tool_list_databases(Ctx& ctx, const rapidjson::Value& args);
std::string tool_list_tables(Ctx& ctx, const rapidjson::Value& args);
std::string tool_describe_table(Ctx& ctx, const rapidjson::Value& args);
// query
std::string tool_query_table(Ctx& ctx, const rapidjson::Value& args);
std::string tool_run_query(Ctx& ctx, const rapidjson::Value& args);
std::string tool_explain_query(Ctx& ctx, const rapidjson::Value& args);
// observability
std::string tool_list_services(Ctx& ctx, const rapidjson::Value& args);
std::string tool_search_traces(Ctx& ctx, const rapidjson::Value& args);
std::string tool_get_trace(Ctx& ctx, const rapidjson::Value& args);
std::string tool_search_logs(Ctx& ctx, const rapidjson::Value& args);
std::string tool_list_metrics(Ctx& ctx, const rapidjson::Value& args);
std::string tool_query_metric(Ctx& ctx, const rapidjson::Value& args);
// the tools of the table of mcp_api_tools.cpp: one wrapper for all
std::string tool_api(Ctx& ctx, const McpToolInfo& info, const rapidjson::Value& args);
// analysis of the keys (mcp_tools_analysis.cpp)
std::string tool_analysis_my_limits(Ctx& ctx, const rapidjson::Value& args);
std::string tool_analysis_my_usage(Ctx& ctx, const rapidjson::Value& args);
std::string tool_analysis_all_usage(Ctx& ctx, const rapidjson::Value& args);

}  // namespace mcp_tools
}  // namespace chdash
