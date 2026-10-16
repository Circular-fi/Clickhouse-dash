#include "mcp_scope.hpp"

#include "mcp_api_tools.hpp"

#include <algorithm>

namespace chdash {

const std::vector<McpToolGroup>& mcp_tool_groups() {
  // The groups follow what a person looks for. Examples are the data, the Explorer page, and the System page.
  // Other groups are Observability (traces, logs and metrics), the Query page, free SQL, and the analysis of the keys.
  // A family has at least two tools. So no card is a lone check box.
  //
  // The analysis has one tool only while the usage is off. The page lists the tools that are offered.
  static const std::vector<McpToolGroup> groups = {
      {"data", "Data", "hosts, databases, tables and columns, and the rows of a table that ClickHouse Dash selects"},
      {"explorer", "Explorer", "the Explorer page: catalog, tables, functions, storage and lineage"},
      {"system", "System", "the System page: load, disks, top queries, activity and Keeper"},
      {"observability", "Observability", "traces, logs and metrics: the pages and the simple search tools"},
      {"query", "Query", "the Query page: saved queries, the SQL formatter and the record of a run"},
      {"sql", "SQL", "free SQL written by the client"},
      {"mcp_analysis", "MCP analysis", "your own limits and usage, and the usage of all the keys"},
  };
  return groups;
}

const std::vector<McpToolSection>& mcp_tool_sections() {
  static const std::vector<McpToolSection> sections = {
      {"observability", "traces", "Traces"},
      {"observability", "logs", "Logs"},
      {"observability", "metrics", "Metrics"},
  };
  return sections;
}

const std::vector<McpToolInfo>& mcp_tool_catalog() {
  static const std::vector<McpToolInfo> tools = [] {
    std::vector<McpToolInfo> all = {
      {"list_hosts", "data", "List hosts",
       "List the ClickHouse host this key reads, with its health. A key reads one host, so every other tool "
       "uses it without a `host` argument.",
       false},
      {"list_databases", "data", "List databases",
       "List the databases this key can see, with their engine and comment. `filter` is an optional glob "
       "(`*` matches any text) on the database name.",
       false},
      {"list_tables", "data", "List tables",
       "List the tables this key can read, with engine, row count and size on disk. Give `database` to "
       "list one database. `filter` is an optional glob (`*` matches any text) on the table name, for "
       "example `events_*`.",
       false},
      {"describe_table", "data", "Describe a table",
       "Describe one table: engine, sorting, partition and primary keys, row count, size, the CREATE "
       "statement and every column with its type, default and key membership. Call it before query_table "
       "to learn the exact column names and types.",
       false},
      {"query_table", "data", "Query a table",
       "Read rows of one table. ChDash builds the SQL from the arguments, so no SQL is needed: choose "
       "`columns`, add `filters` (all must match), `order_by` and a `limit` (default 100). Without "
       "`columns`, wide columns are left out and named in `omitted_columns`. Column names must come from "
       "describe_table. Values are typed by the column: numbers for numeric columns, strings for text, "
       "dates and UUIDs.",
       false},
      {"list_services", "observability", "List services",
       "List the services that sent data in the last `since_minutes` (default 60), with their number of spans "
       "and errors (`signal` = traces, the default) or of log records and errors (`signal` = logs). Call it "
       "first to learn the exact service names for search_traces and search_logs.",
       false, nullptr, "traces"},
      {"search_traces", "observability", "Search traces",
       "Find recent traces by their root span, newest first (or the slowest first with `order` = slowest). "
       "Filter with `service`, `operation` (a part of the span name), `status` (Error, Ok or Unset) and "
       "`min_duration_ms`. `since_minutes` defaults to 60. Each trace has its trace_id: give it to get_trace.",
       false, nullptr, "traces"},
      {"get_trace", "observability", "Get a trace",
       "Return every span of one trace, in time order: span, parent, service, name, kind, start, duration in "
       "milliseconds, status and status message. `trace_id` is 32 hexadecimal characters, from search_traces "
       "or from a log record.",
       false, nullptr, "traces"},
      {"search_logs", "observability", "Search logs",
       "Find recent log records, newest first. Filter with `service`, `severity` (the lowest level: trace, "
       "debug, info, warn or error), `contains` (a text in the message, not case sensitive) and `trace_id`. "
       "`since_minutes` defaults to 60. Messages are cut at 2000 characters.",
       false, nullptr, "logs"},
      {"list_metrics", "observability", "List metrics",
       "List the metrics that were reported in the last `since_minutes` (default 60): name, kind (gauge, sum "
       "or histogram), unit and description. `filter` is a glob on the name (`*` matches any text); "
       "`service` limits the list to one service.",
       false, nullptr, "metrics"},
      {"query_metric", "observability", "Query a metric",
       "Return one metric as a time series: one point for each `step_seconds`, over the last `since_minutes` "
       "(default 60). `aggregation` is avg (default), min, max, sum or last (histograms: avg, sum or count). "
       "Series of one metric that differ by attributes are merged in each point. Sum metrics are counters "
       "that only grow: use last or max. Give `kind` when a name exists in several kinds.",
       false, nullptr, "metrics"},
      {"run_query", "sql", "Run a SQL query",
       "Run exactly one read-only SQL statement (SELECT, WITH, SHOW, DESCRIBE, EXISTS or EXPLAIN) and "
       "return its rows. The statement runs with readonly=1, a row cap, a byte cap and a time limit; "
       "`truncated` is true when rows or bytes were cut. Use ClickHouse SQL. Prefer query_table when a "
       "simple read is enough.",
       true},
      {"explain_query", "sql", "Explain a SQL query",
       "Show how ClickHouse runs one SELECT statement without running it. `type` is plan (default), "
       "pipeline, ast, syntax or estimate. Use it to check the cost of a query before run_query.",
       true},
    };
    // The API tools have one row each in mcp_api_tools.cpp.
    // The patterns of the key cut the Explorer tools of one table, and the catalog.
    // The other API tools hold no data of the tables of the key (McpApiScope). None of them needs the scope "*".
    for (const auto& api : mcp_api_tools()) {
      all.push_back({api.name, api.group, api.title, api.description, false, &api, api.section});
    }
    // The analysis of the keys themselves belongs to the mcp_analysis family.
    // Every key has the first two tools, whatever its list of tools says. A key always knows its own limits.
    // A key also knows its own usage, once the usage is counted.
    //
    // The last tool shows other keys, with their names, hosts, clients and activity.
    // `*` does not give this tool. The list of the key must name it. The configuration must enable it (mcp.usage.all_keys).
    // The columns after the description are: needs_all_data, api, section, always, explicit_only, needs.
    all.push_back({"mcp_analysis_my_limits", "mcp_analysis", "My limits",
                   "The limits of your key: calls per minute and what is left, rows, seconds, and the size caps, each with its source. The "
                   "rate limit is per ChDash instance, and the call that asks has already taken its token. `source` is `key` (your key lowers "
                   "the cap), `mcp` (the ChDash configuration), `clickhouse` (the settings profile of the ClickHouse user of your host) or "
                   "`both` (the last two are equal). `null` means no limit. No argument.",
                   false, nullptr, nullptr, true, false, kMcpNeedsNothing});
    all.push_back({"mcp_analysis_my_usage", "mcp_analysis", "My usage",
                   "What your own key did in a window: requests, errors, time, rows and bytes, by tool, error code and client. The ChDash "
                   "instances that share the usage are summed. `window` is 1h, 6h, 24h (default), 7d, 30d, 90d or 365d, as far as the "
                   "retention goes. `series` adds one point for each step of the window. `include_cost` adds what the statements of your key "
                   "cost ClickHouse (read from system.query_log; a window of 30d or more reads 7d; kept 60 seconds). `instance` is a list of "
                   "instance names to sum. The call that asks is not in the answer yet.",
                   false, nullptr, nullptr, true, false, kMcpNeedsUsage});
    all.push_back({"mcp_analysis_all_usage", "mcp_analysis", "Usage of all keys",
                   "What all the keys of all the ChDash instances did in a window: requests, errors and time, by key, method, client and "
                   "instance. Each list has the most requests first. `window` is 1h, 6h, 24h (default), 7d, 30d, 90d or 365d, as far as the "
                   "retention goes. `group` is key (default), method, client or instance: what `series` is grouped by. `order` is requests "
                   "(default), errors, refused (the 429 and the requests refused before they were read), calls or bytes: the metric that ranks "
                   "the groups of `series`. `key` (the ids of keys), `method`, `client` and `instance` filter: lists of at most 20 values. "
                   "`limit` is the rows of each list (20 by default, at most 200). `series` adds the points of the 8 largest groups by `order`, "
                   "and the others summed. The names, hosts and clients of other keys are in the answer; their ClickHouse cost never is.",
                   false, nullptr, nullptr, false, true, kMcpNeedsUsage | kMcpNeedsAllKeys});
    return all;
  }();
  return tools;
}

unsigned mcp_tool_reads(const McpToolInfo& tool) {
  const std::string name = tool.name;
  const std::string section = tool.section ? tool.section : "";
  // list_services reads traces or logs, based on its `signal`. The call tells which one. The key cannot.
  if (name == "list_services") return kMcpReadsNone;
  if (section == "traces") return name == "traces_logs" ? (kMcpReadsTraces | kMcpReadsLogs) : kMcpReadsTraces;
  if (section == "logs") return kMcpReadsLogs;
  if (section == "metrics") return kMcpReadsMetrics;
  if (name == "explorer_functions") return kMcpReadsFunctions;
  return kMcpReadsNone;
}

const McpToolInfo* mcp_find_tool(std::string_view name) {
  for (const auto& tool : mcp_tool_catalog()) {
    if (name == tool.name) return &tool;
  }
  return nullptr;
}

bool mcp_tool_available(const McpToolInfo& tool, const McpToolAvailability& availability) {
  // The reading of all keys is a part of the usage. It never exists without the usage.
  if ((tool.needs & (kMcpNeedsUsage | kMcpNeedsAllKeys)) != 0 && !availability.usage) return false;
  if ((tool.needs & kMcpNeedsAllKeys) != 0 && !availability.all_keys) return false;
  return true;
}

std::string mcp_tool_unavailable_reason(const McpToolInfo& tool, const McpToolAvailability& availability) {
  if (mcp_tool_available(tool, availability)) return {};
  if (!availability.usage) {
    return std::string("the usage of the keys is off, so the tool ") + tool.name + " is not offered: the administrator must set mcp.usage.enabled in the ChDash configuration";
  }
  return std::string("reading the usage of all the keys is off, so the tool ") + tool.name +
         " is not offered: the administrator must set mcp.usage.all_keys in the ChDash configuration";
}

bool mcp_glob_match(std::string_view pattern, std::string_view text) {
  size_t p = 0;
  size_t t = 0;
  size_t star = std::string_view::npos;
  size_t mark = 0;
  while (t < text.size()) {
    if (p < pattern.size() && pattern[p] == '*') {
      star = p++;
      mark = t;
    } else if (p < pattern.size() && pattern[p] == text[t]) {
      ++p;
      ++t;
    } else if (star != std::string_view::npos) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (p < pattern.size() && pattern[p] == '*') ++p;
  return p == pattern.size();
}

std::string mcp_glob_to_like(std::string_view pattern) {
  std::string out;
  out.reserve(pattern.size() + 2);
  for (const char c : pattern) {
    if (c == '*') {
      out.push_back('%');
    } else {
      if (c == '%' || c == '_' || c == '\\') out.push_back('\\');
      out.push_back(c);
    }
  }
  return out;
}

namespace {

bool pattern_char_ok(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-' ||
         c == '$' || c == '*';
}

struct PatternParts {
  std::string_view db;
  std::string_view table;  // empty: the whole database
  bool has_table = false;
};

PatternParts split_pattern(std::string_view pattern) {
  PatternParts parts;
  const auto dot = pattern.find('.');
  if (dot == std::string_view::npos) {
    parts.db = pattern;
  } else {
    parts.db = pattern.substr(0, dot);
    parts.table = pattern.substr(dot + 1);
    parts.has_table = true;
  }
  return parts;
}

} // namespace

bool mcp_valid_database_pattern(std::string_view pattern, std::string* reason) {
  const auto fail = [&](const char* text) {
    if (reason) *reason = text;
    return false;
  };
  if (pattern.empty()) return fail("is empty");
  if (pattern.size() > 256) return fail("is longer than 256 bytes");
  const auto parts = split_pattern(pattern);
  if (parts.db.empty()) return fail("has an empty database part");
  if (parts.has_table && parts.table.empty()) return fail("has an empty table part");
  if (parts.table.find('.') != std::string_view::npos) return fail("has more than one dot");
  for (const char c : pattern) {
    if (c != '.' && !pattern_char_ok(c)) return fail("has a character outside letters, digits, _ - $ * and one dot");
  }
  return true;
}

bool mcp_scope_all_data(const std::vector<std::string>& databases) {
  return std::find(databases.begin(), databases.end(), "*") != databases.end();
}

bool mcp_scope_database_visible(const std::vector<std::string>& databases, std::string_view database) {
  for (const auto& entry : databases) {
    if (mcp_glob_match(split_pattern(entry).db, database)) return true;
  }
  return false;
}

bool mcp_scope_database_whole(const std::vector<std::string>& databases, std::string_view database) {
  for (const auto& entry : databases) {
    const auto parts = split_pattern(entry);
    if (!mcp_glob_match(parts.db, database)) continue;
    if (!parts.has_table || mcp_glob_match(parts.table, "")) return true;
  }
  return false;
}

bool mcp_scope_table_allowed(const std::vector<std::string>& databases, std::string_view database,
                             std::string_view table) {
  for (const auto& entry : databases) {
    const auto parts = split_pattern(entry);
    if (!mcp_glob_match(parts.db, database)) continue;
    if (!parts.has_table || mcp_glob_match(parts.table, table)) return true;
  }
  return false;
}

std::vector<std::string> mcp_scope_database_globs(const std::vector<std::string>& databases) {
  std::vector<std::string> out;
  for (const auto& entry : databases) {
    std::string db(split_pattern(entry).db);
    if (std::find(out.begin(), out.end(), db) == out.end()) out.push_back(std::move(db));
  }
  return out;
}

bool mcp_scope_host_allowed(const std::vector<std::string>& hosts, std::string_view host) {
  for (const auto& entry : hosts) {
    if (entry == "*" || entry == host) return true;
  }
  return false;
}

std::vector<std::string> mcp_scope_hosts(const std::vector<std::string>& hosts,
                                         const std::vector<std::string>& available) {
  std::vector<std::string> out;
  for (const auto& name : available) {
    if (mcp_scope_host_allowed(hosts, name)) out.push_back(name);
  }
  return out;
}

std::vector<std::string> mcp_effective_tools(const std::vector<std::string>& tools,
                                             const std::vector<std::string>& databases,
                                             const McpToolAvailability& availability) {
  const bool all_data = mcp_scope_all_data(databases);
  const bool wildcard = std::find(tools.begin(), tools.end(), "*") != tools.end();
  std::vector<std::string> out;
  for (const auto& tool : mcp_tool_catalog()) {
    if (tool.needs_all_data && !all_data) continue;
    if (!mcp_tool_available(tool, availability)) continue;
    // A tool that every key has needs no name in the list. A tool that "*" does not give needs its name. The other tools follow the list.
    const bool named = std::find(tools.begin(), tools.end(), tool.name) != tools.end();
    if (tool.always || named || (wildcard && !tool.explicit_only)) out.emplace_back(tool.name);
  }
  return out;
}

bool mcp_scope_tool_allowed(const std::vector<std::string>& tools, const std::vector<std::string>& databases,
                            std::string_view tool) {
  const auto effective = mcp_effective_tools(tools, databases);
  return std::find(effective.begin(), effective.end(), tool) != effective.end();
}

} // namespace chdash
