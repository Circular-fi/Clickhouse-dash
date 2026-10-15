// GET /api/mcp/keys/<id>/cost: what the statements of an MCP key cost ClickHouse (docs/mcp.md, "The ClickHouse cost of a key"). Each
// statement of a call of the key is named for it (its query_id, mcp_cost.hpp); this route reads system.query_log of the host of the key
// with the RUNNER account and the bounds of System > Queries, as that page does (the MCP user never reads query_log), and keeps the answer
// 60 s. A read of the page: handle_api_mcp checked its guard. Never SQL, never data: counts, users, tools and the names of the tables.
//
// The tool mcp_analysis_my_usage reads the same cost for its own key (Server::mcp_tool_cost): the same cache and the same read (answer_mcp_cost),
// written for a client that is no administrator. The tool runs on the thread of POST /mcp, whose scope is no scope of MCP (it has no query_id
// of a key): the read of system.query_log is not a statement of the key, so it is never counted in the cost that it reads.

#include "server.hpp"

#include "api_error.hpp"
#include "ch_uri.hpp"
#include "host_util.hpp"
#include "json_text.hpp"
#include "log.hpp"
#include "mcp_cost.hpp"
#include "mcp_keys.hpp"
#include "mcp_scope.hpp"
#include "system_monitor.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <chrono>
#include <map>
#include <string>
#include <vector>

namespace chdash {
namespace {

using Writer = rapidjson::Writer<rapidjson::StringBuffer>;

void put(Writer& w, std::string_view text) { write_json_text(w, text); }

void no_store(httplib::Response& res) {
  res.headers.erase("Cache-Control");
  res.set_header("Cache-Control", "no-store");
}

void fail(httplib::Response& res, int status, const std::string& code, const std::string& message, const std::string& field = {},
          const std::string& reason = {}) {
  ApiError error;
  error.status = status;
  error.code = code;
  error.message = message;
  if (!field.empty() || !reason.empty()) {
    error.text.emplace_back("field", field);
    error.text.emplace_back("reason", reason);
  }
  send_error(res, error);
  no_store(res);
}

std::string user_of(const std::string& uri) {
  const auto parsed = parse_clickhouse_uri(uri, nullptr);
  return parsed ? parsed->user : std::string();
}

// The figures of several rows of the cost.
struct Sum {
  uint64_t statements = 0;
  uint64_t failed = 0;
  uint64_t canceled = 0;
  uint64_t read_rows = 0;
  uint64_t read_bytes = 0;
  uint64_t result_rows = 0;
  uint64_t result_bytes = 0;
  uint64_t duration_ms = 0;
  uint64_t cpu_us = 0;
  uint64_t memory_peak_bytes = 0;

  void add(const McpCostRow& row) {
    statements += row.statements;
    failed += row.failed;
    canceled += row.canceled;
    read_rows += row.read_rows;
    read_bytes += row.read_bytes;
    result_rows += row.result_rows;
    result_bytes += row.result_bytes;
    duration_ms += row.duration_ms;
    cpu_us += row.cpu_us;
    memory_peak_bytes = std::max(memory_peak_bytes, row.memory_peak_bytes);
  }
};

void put_sum(Writer& w, const Sum& sum, bool with_results) {
  w.Key("statements"); w.Uint64(sum.statements);
  w.Key("failed"); w.Uint64(sum.failed);
  w.Key("canceled"); w.Uint64(sum.canceled);
  w.Key("read_rows"); w.Uint64(sum.read_rows);
  w.Key("read_bytes"); w.Uint64(sum.read_bytes);
  if (with_results) {
    w.Key("result_rows"); w.Uint64(sum.result_rows);
    w.Key("result_bytes"); w.Uint64(sum.result_bytes);
  }
  w.Key("duration_ms"); w.Uint64(sum.duration_ms);
  w.Key("cpu_ms"); w.Uint64((sum.cpu_us + 500) / 1000);
  w.Key("memory_peak_bytes"); w.Uint64(sum.memory_peak_bytes);
}

// What the answer says when the cost cannot be read.
struct Unavailable {
  std::string reason;  // no_host, runner_unavailable, not_granted, disabled, window_too_large, readonly_account, unsupported, failed
  std::string error;
  std::string statement;
  std::string suggested_window;
};

// The answer of the page (`for_page`): the id of the key, why there is no cost, and the text of the error and the GRANT statement for the
// administrator. The answer of the tool has none of these: the id is the caller's own, and a cost that cannot be read has its own object
// (write_tool_unavailable).
void write_answer(Writer& w, const std::string& id, const std::string& host, const McpCostWindow& window, int64_t max_lookback_hours,
                  const McpCost* cost, const Unavailable& unavailable, const std::string& mcp_user, const std::string& system_user, bool for_page) {
  w.StartObject();
  if (for_page) {
    w.Key("id"); put(w, id);
  }
  w.Key("host"); put(w, host);
  const McpCostWindow& read = cost ? cost->window : window;
  w.Key("window"); put(w, read.name);
  w.Key("from"); put(w, mcp_iso_utc(read.from_s));
  w.Key("to"); put(w, mcp_iso_utc(read.to_s));
  w.Key("max_lookback_hours"); w.Int64(max_lookback_hours);
  w.Key("clamped"); w.Bool(read.clamped);
  w.Key("read_at");
  if (cost) put(w, mcp_iso_utc(cost->read_at_s));
  else w.Null();
  w.Key("status"); w.String(cost ? "ok" : "unavailable");
  if (for_page) {
    w.Key("reason"); put(w, unavailable.reason);
    w.Key("error"); put(w, unavailable.error.substr(0, 300));
    w.Key("statement"); put(w, unavailable.statement);
    w.Key("suggested_window"); put(w, unavailable.suggested_window);
  }

  // The rows by user and tool, summed by user (the identities) and by tool. A tool that is not of the catalog (a query_id that another
  // user of ClickHouse made up) is "other"; a user that is neither of the host's MCP identities is "other" too.
  Sum totals;
  std::map<std::string, Sum> by_user;
  std::map<std::string, Sum> by_tool;
  if (cost) {
    for (const McpCostRow& row : cost->rows) {
      totals.add(row);
      by_user[row.user].add(row);
      by_tool[mcp_find_tool(row.tool) ? row.tool : std::string("other")].add(row);
    }
  }
  w.Key("totals");
  w.StartObject();
  put_sum(w, totals, true);
  w.EndObject();

  const auto most_first = [](const std::map<std::string, Sum>& sums) {
    std::vector<std::pair<std::string, Sum>> out(sums.begin(), sums.end());
    std::stable_sort(out.begin(), out.end(), [](const auto& a, const auto& b) { return a.second.statements > b.second.statements; });
    return out;
  };
  w.Key("identities");
  w.StartArray();
  for (const auto& [user, sum] : most_first(by_user)) {
    w.StartObject();
    w.Key("user"); put(w, user);
    w.Key("role"); w.String(!mcp_user.empty() && user == mcp_user ? "mcp" : !system_user.empty() && user == system_user ? "system" : "other");
    put_sum(w, sum, false);
    w.EndObject();
  }
  w.EndArray();
  w.Key("tools");
  w.StartArray();
  for (const auto& [tool, sum] : most_first(by_tool)) {
    w.StartObject();
    w.Key("tool"); put(w, tool);
    put_sum(w, sum, false);
    w.EndObject();
  }
  w.EndArray();
  w.Key("tables");
  w.StartArray();
  if (cost) {
    for (const auto& [name, statements] : cost->tables) {
      w.StartObject();
      w.Key("name"); put(w, name);
      w.Key("statements"); w.Uint64(statements);
      w.EndObject();
    }
  }
  w.EndArray();
  w.Key("tables_truncated"); w.Bool(cost && cost->tables_truncated);
  w.Key("rows_truncated"); w.Bool(cost && cost->rows_truncated);
  w.EndObject();
}

// What a client reads when the cost cannot be read, in ChDash's own words: a ClickHouse error can name a server, and the GRANT statement names the
// account of the runner, which the administrator reads on the page.
std::string tool_reason_text(const std::string& reason, const std::string& suggested_window) {
  if (reason == "no_host") return "the host of the key is not configured";
  if (reason == "runner_unavailable") return "ChDash cannot connect to the account that reads system.query_log on the host of the key";
  if (reason == "not_granted") {
    return "the account that ChDash reads system.query_log with cannot read it: the administrator must grant it SELECT on system.query_log";
  }
  if (reason == "disabled") return "system.query_log does not exist on the host of the key";
  if (reason == "window_too_large") {
    return "the window holds more of system.query_log than ChDash reads in one go" +
           (suggested_window.empty() ? std::string() : ": ask for a window of " + suggested_window);
  }
  if (reason == "readonly_account") return "the account that ChDash reads system.query_log with refuses the settings of the read";
  if (reason == "unsupported") return "system.query_log of this ClickHouse server lacks a column that the read needs";
  if (reason == "busy") return "too many heavy reads are running for the host of the key: ask again in a moment";
  if (reason == "stopping") return "ChDash is stopping";
  return "the read of system.query_log failed: the administrator finds why on the page of the key (the cost of a key)";
}

// The answer of the tool for a cost that cannot be read: no figures (zeros would read as "no cost"), the reason and a sentence.
void write_tool_unavailable(Writer& w, const std::string& host, const McpCostWindow& window, const Unavailable& unavailable) {
  w.StartObject();
  w.Key("host"); put(w, host);
  w.Key("window"); put(w, window.name);
  w.Key("status"); w.String("unavailable");
  w.Key("reason"); put(w, unavailable.reason);
  w.Key("message"); put(w, tool_reason_text(unavailable.reason, unavailable.suggested_window));
  if (!unavailable.suggested_window.empty()) {
    w.Key("suggested_window"); put(w, unavailable.suggested_window);
  }
  w.EndObject();
}

} // namespace

void Server::handle_mcp_key_cost(const httplib::Request& req, httplib::Response& res, int64_t now) {
  const auto started = std::chrono::steady_clock::now();
  const std::string id = req.matches.size() > 1 ? std::string(req.matches[1]) : std::string();
  if (!cfg_.system.top_queries_enabled()) {
    return fail(res, 404, "not_enabled", "the cost of a key reads system.query_log as System > Queries does, and system.top_queries is off");
  }
  // The host of the key; a key of an older file that names several takes ?host= (one of them); a deleted key, the host its usage kept.
  std::string host_id;
  bool known = false;
  for (const auto& key : mcp_keys_->list()) {
    if (key.id != id) continue;
    known = true;
    const std::string asked = req.has_param("host") ? req.get_param_value("host") : std::string();
    for (const auto& name : key.hosts) {
      if (name == asked) host_id = name;
    }
    if (host_id.empty() && !key.hosts.empty()) host_id = key.hosts.front();
  }
  if (!known && mcp_usage_) {
    if (const auto entry = mcp_usage_->entry_key(id)) {
      known = true;
      host_id = entry->host;
    }
  }
  if (!known) return fail(res, 404, "not_found", "no such key");
  const std::string asked = req.has_param("window") ? req.get_param_value("window") : std::string();
  const auto window = mcp_cost_window(asked.empty() ? "24h" : asked, cfg_.system.query_log_max_lookback_hours, now);
  if (!window) return fail(res, 400, "validation", "window must be 1h, 6h, 24h or 7d", "window", "invalid");

  const bool refresh = req.has_param("refresh") && req.get_param_value("refresh") == "1";
  // A read that the browser abandons stops, and so does the wait for a place of heavy work.
  const std::function<bool()> stop = [this, &req] { return stopping() || (req.is_connection_closed && req.is_connection_closed()); };
  const McpCostAnswer answer = answer_mcp_cost(id, host_id, *window, refresh, true, stop, now);
  if (answer.busy || answer.stopping) {
    send_no_place(res);
    no_store(res);
    return;
  }
  // The audit line of the page's reads of a key (api_mcp.cpp writes the others).
  const auto duration_ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
  log_event(LogLevel::Info, "mcp.call",
            {{"key", "-"}, {"call", "keys/cost"}, {"host", host_id.empty() ? std::string("-") : host_id}, {"status", answer.status + ":" + id},
             {"duration_ms", static_cast<int64_t>(duration_ms)}, {"rows", static_cast<uint64_t>(0)}});
  res.status = 200;
  no_store(res);
  res.set_content(answer.json.data(), answer.json.size(), "application/json");
}

// The read that the page and the tool share: the cache, the runner account, the heavy work of a host. `host_id` is the host of the key.
Server::McpCostAnswer Server::answer_mcp_cost(const std::string& key_id, const std::string& host_id, const McpCostWindow& window, bool refresh,
                                              bool for_page, const std::function<bool()>& stop, int64_t now) {
  McpCostAnswer out;
  const int64_t lookback = cfg_.system.query_log_max_lookback_hours;
  const HostSpec* host = host_id.empty() ? nullptr : find_host(cfg_.hosts, host_id);
  rapidjson::StringBuffer sb;
  Writer w(sb);
  out.status = "ok";
  if (!host) {
    Unavailable unavailable{"no_host", "the host of the key is not configured", "", ""};
    if (for_page) write_answer(w, key_id, host_id, window, lookback, nullptr, unavailable, "", "", true);
    else write_tool_unavailable(w, host_id, window, unavailable);
    out.status = "no_host";
  } else {
    // A scan of query_log is heavy work for the host, as System > Queries is.
    const auto ticket = acquire_ticket(WorkClass::Heavy, host->id, stop);
    if (!ticket) {
      out.stopping = stopping();
      out.busy = !out.stopping;
      return out;
    }
    const uint64_t max_rows = cfg_.system.query_log_max_rows;
    const auto result = mcp_cost_cache_.get(
        host->id + '\x1f' + key_id + '\x1f' + window.name,
        [&](McpCost& value, std::string& code, std::string& message) {
          std::string error;
          auto db = open_system_runner_executor(*host, &error);
          if (!db) {
            code = "runner_unavailable";
            message = error.empty() ? "cannot connect to the runner account of the host" : error;
            return false;
          }
          try {
            value = mcp_read_cost(*db, key_id, window, max_rows, now);
            return true;
          } catch (const std::exception& e) {
            db->invalidate();
            code = monitor_reason_of(e);
            message = e.what();
            return false;
          }
        },
        refresh);
    Unavailable unavailable;
    const McpCost* cost = result.has_value && result.value ? result.value.get() : nullptr;
    if (!cost) {
      unavailable.reason = result.error_code.empty() ? "failed" : result.error_code;
      unavailable.error = result.error_message;
      if (unavailable.reason == "not_granted") unavailable.statement = monitor_grant_hint("query_log", user_of(host->runner_uri), "runner user");
      if (unavailable.reason == "window_too_large" && window.name == "7d") unavailable.suggested_window = "24h";
      out.status = unavailable.reason;
    }
    if (for_page || cost) {
      write_answer(w, key_id, host->id, window, lookback, cost, unavailable, user_of(host->mcp_uri),
                   user_of(host->system_uri.empty() ? host->runner_uri : host->system_uri), for_page);
    } else {
      write_tool_unavailable(w, host->id, window, unavailable);
    }
  }
  out.json.assign(sb.GetString(), sb.GetSize());
  return out;
}

// The cost of the key that the tool mcp_analysis_my_usage asks for, a JSON object. The window of the usage is the one of the cost when the cost
// has it (1h, 6h, 24h, 7d), else 7d, the longest (the object says the window that it read). A cost that cannot be read says why, in its status:
// the tool still gives the usage.
std::string Server::mcp_tool_cost(const McpKey& key, const std::string& usage_window, int64_t now) {
  rapidjson::StringBuffer sb;
  Writer w(sb);
  if (!cfg_.system.top_queries_enabled()) {
    w.StartObject();
    w.Key("status"); w.String("not_enabled");
    w.Key("message"); w.String("the cost of a key reads system.query_log as System > Queries does, and system.top_queries is off in the ChDash configuration");
    w.EndObject();
    return std::string(sb.GetString(), sb.GetSize());
  }
  const bool as_asked = usage_window == "1h" || usage_window == "6h" || usage_window == "24h" || usage_window == "7d";
  const auto window = mcp_cost_window(as_asked ? usage_window : "7d", cfg_.system.query_log_max_lookback_hours, now);
  // The stop of the call: the client of MCP went away, or the server stops (the scope of POST /mcp says so).
  std::function<bool()> stop = [this] { return stopping(); };
  if (const ChQueryLimits* scope = ChQueryScope::current(); scope && scope->canceled) stop = scope->canceled;
  const McpCostAnswer answer = answer_mcp_cost(key.id, key.hosts.empty() ? std::string() : key.hosts.front(), *window, false, false, stop, now);
  if (answer.busy || answer.stopping) {
    Unavailable unavailable{answer.stopping ? "stopping" : "busy", "", "", ""};
    write_tool_unavailable(w, key.hosts.empty() ? std::string() : key.hosts.front(), *window, unavailable);
    return std::string(sb.GetString(), sb.GetSize());
  }
  return answer.json;
}

} // namespace chdash
