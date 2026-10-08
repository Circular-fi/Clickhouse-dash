#include "mcp_scope.hpp"

#include <algorithm>

namespace chdash {

const std::vector<McpToolInfo>& mcp_tool_catalog() {
  static const std::vector<McpToolInfo> tools = {
      {"list_hosts", "schema", "List hosts",
       "List the ClickHouse hosts this key can use, with their health. Every other tool takes an optional "
       "`host`; call this first when the key has more than one host.",
       false},
      {"list_databases", "schema", "List databases",
       "List the databases this key can see, with their engine and comment. `filter` is an optional glob "
       "(`*` matches any text) on the database name.",
       false},
      {"list_tables", "schema", "List tables",
       "List the tables this key can read, with engine, row count and size on disk. Give `database` to "
       "list one database. `filter` is an optional glob (`*` matches any text) on the table name, for "
       "example `events_*`.",
       false},
      {"describe_table", "schema", "Describe a table",
       "Describe one table: engine, sorting, partition and primary keys, row count, size, the CREATE "
       "statement and every column with its type, default and key membership. Call it before query_table "
       "to learn the exact column names and types.",
       false},
      {"query_table", "read", "Query a table",
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
       false},
      {"search_traces", "observability", "Search traces",
       "Find recent traces by their root span, newest first (or the slowest first with `order` = slowest). "
       "Filter with `service`, `operation` (a part of the span name), `status` (Error, Ok or Unset) and "
       "`min_duration_ms`. `since_minutes` defaults to 60. Each trace has its trace_id: give it to get_trace.",
       false},
      {"get_trace", "observability", "Get a trace",
       "Return every span of one trace, in time order: span, parent, service, name, kind, start, duration in "
       "milliseconds, status and status message. `trace_id` is 32 hexadecimal characters, from search_traces "
       "or from a log record.",
       false},
      {"search_logs", "observability", "Search logs",
       "Find recent log records, newest first. Filter with `service`, `severity` (the lowest level: trace, "
       "debug, info, warn or error), `contains` (a text in the message, not case sensitive) and `trace_id`. "
       "`since_minutes` defaults to 60. Messages are cut at 2000 characters.",
       false},
      {"list_metrics", "observability", "List metrics",
       "List the metrics that were reported in the last `since_minutes` (default 60): name, kind (gauge, sum "
       "or histogram), unit and description. `filter` is a glob on the name (`*` matches any text); "
       "`service` limits the list to one service.",
       false},
      {"query_metric", "observability", "Query a metric",
       "Return one metric as a time series: one point for each `step_seconds`, over the last `since_minutes` "
       "(default 60). `aggregation` is avg (default), min, max, sum or last (histograms: avg, sum or count). "
       "Series of one metric that differ by attributes are merged in each point. Sum metrics are counters "
       "that only grow: use last or max. Give `kind` when a name exists in several kinds.",
       false},
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
  return tools;
}

const McpToolInfo* mcp_find_tool(std::string_view name) {
  for (const auto& tool : mcp_tool_catalog()) {
    if (name == tool.name) return &tool;
  }
  return nullptr;
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
                                             const std::vector<std::string>& databases) {
  const bool all_data = mcp_scope_all_data(databases);
  const bool wildcard = std::find(tools.begin(), tools.end(), "*") != tools.end();
  std::vector<std::string> out;
  for (const auto& tool : mcp_tool_catalog()) {
    if (tool.needs_all_data && !all_data) continue;
    if (wildcard || std::find(tools.begin(), tools.end(), tool.name) != tools.end()) out.emplace_back(tool.name);
  }
  return out;
}

bool mcp_scope_tool_allowed(const std::vector<std::string>& tools, const std::vector<std::string>& databases,
                            std::string_view tool) {
  const auto effective = mcp_effective_tools(tools, databases);
  return std::find(effective.begin(), effective.end(), tool) != effective.end();
}

} // namespace chdash
