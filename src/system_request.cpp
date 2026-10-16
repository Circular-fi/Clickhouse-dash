#include "system_request.hpp"

#include "api_params.hpp"
#include "service_result.hpp"

#include <algorithm>
#include <vector>

namespace chdash {
namespace system_page {

namespace {

std::string param(const httplib::Request& req, const char* name) { return req.has_param(name) ? req.get_param_value(name) : std::string{}; }

bool refresh_of(const httplib::Request& req) { return req.has_param("refresh") && req.get_param_value("refresh") == "1"; }

bool fail(ApiError* error, int status, std::string code, std::string message) {
  *error = make_error(status, std::move(code), std::move(message));
  return false;
}

std::string one_of(const std::vector<std::string>& names) {
  std::string out;
  for (const auto& name : names) out += (out.empty() ? "" : ", ") + name;
  return out;
}

bool member(const std::vector<std::string>& names, const std::string& value) { return std::find(names.begin(), names.end(), value) != names.end(); }

// The window of the Queries. The list and a drill-down share it.
// When absent, the window is the last default_lookback_minutes, at most the lookback. A window that ends in the future ends now.
// A window wider than query_log_max_lookback_hours is refused.
bool queries_window(const httplib::Request& req, const SystemSettings& settings, uint64_t now_ms, uint64_t& from_ms, uint64_t& to_ms, ApiError* error) {
  const uint64_t max_span_ms = static_cast<uint64_t>(settings.query_log_max_lookback_hours) * 3'600'000ULL;
  to_ms = now_ms;
  from_ms = 0;
  if (req.has_param("to_ms") && !parse_ms(param(req, "to_ms"), to_ms)) {
    return fail(error, 400, "invalid_range", "to_ms must be a whole number of milliseconds.");
  }
  if (req.has_param("from_ms")) {
    if (!parse_ms(param(req, "from_ms"), from_ms)) return fail(error, 400, "invalid_range", "from_ms must be a whole number of milliseconds.");
  } else {
    const uint64_t lookback = std::min<uint64_t>(static_cast<uint64_t>(settings.default_lookback_minutes) * 60'000ULL, max_span_ms);
    from_ms = to_ms > lookback ? to_ms - lookback : 0;
  }
  to_ms = std::min(to_ms, now_ms);
  if (from_ms >= to_ms) return fail(error, 400, "invalid_range", "from_ms must be before to_ms (and before now).");
  if (to_ms - from_ms > max_span_ms) {
    return fail(error, 400, "range_too_large",
                "The window is wider than " + std::to_string(settings.query_log_max_lookback_hours) + " hours (system.query_log_max_lookback_hours).");
  }
  return true;
}

}  // namespace

bool parse_ms(const std::string& text, uint64_t& out) {
  if (text.empty() || text.size() > 16) return false;
  if (!std::all_of(text.begin(), text.end(), [](char ch) { return ch >= '0' && ch <= '9'; })) return false;
  out = std::stoull(text);
  return true;
}

bool parse_hash(const std::string& text, uint64_t& out) {
  static const std::string kMax = "18446744073709551615";
  if (text.empty() || text.size() > kMax.size()) return false;
  if (!std::all_of(text.begin(), text.end(), [](char ch) { return ch >= '0' && ch <= '9'; })) return false;
  if (text.size() == kMax.size() && text > kMax) return false;
  out = std::stoull(text);
  return true;
}

bool parse_host_request(const httplib::Request& req, HostRequest* out, ApiError* error) {
  if (const auto unknown = unknown_param_error(req, {"host_id", "refresh"})) {
    *error = *unknown;
    return false;
  }
  out->host_id = param(req, "host_id");
  if (out->host_id.empty()) return fail(error, 400, "missing_host_id", "Missing host_id.");
  out->refresh = refresh_of(req);
  return true;
}

bool parse_series_request(const httplib::Request& req, const SystemSettings& settings, uint64_t now_ms, SeriesRequest* out, ApiError* error) {
  if (const auto unknown = unknown_param_error(req, {"host_id", "from_ms", "to_ms", "panel", "scope", "refresh"})) {
    *error = *unknown;
    return false;
  }
  SeriesRequest request;
  request.host_id = param(req, "host_id");
  if (request.host_id.empty()) return fail(error, 400, "missing_host_id", "Missing host_id.");
  const std::string panel = req.has_param("panel") ? param(req, "panel") : std::string("performance");
  if (panel != "performance" && panel != "disk_growth") return fail(error, 400, "invalid_panel", "panel must be performance or disk_growth.");
  request.growth = panel == "disk_growth";
  // Cluster fan-out (clusterAllReplicas) is opt-in: it needs system.cluster_fanout.
  const std::string scope = req.has_param("scope") ? param(req, "scope") : std::string("server");
  if (scope == "cluster") {
    if (!settings.cluster_fanout) return fail(error, 400, "cluster_fanout_disabled", "The cluster view is off (system.cluster_fanout).");
    return fail(error, 501, "cluster_scope_unsupported", "The Performance section reads this server only.");
  }
  if (scope != "server") return fail(error, 400, "invalid_scope", "scope must be server or cluster.");

  // The window uses the default lookback when it is absent. It is at most max_lookback_days.
  const uint64_t max_span_ms = static_cast<uint64_t>(settings.max_lookback_days) * 86'400'000ULL;
  uint64_t to_ms = now_ms;
  uint64_t from_ms = 0;
  if (req.has_param("to_ms") && !parse_ms(param(req, "to_ms"), to_ms)) {
    return fail(error, 400, "invalid_range", "to_ms must be a whole number of milliseconds.");
  }
  if (req.has_param("from_ms")) {
    if (!parse_ms(param(req, "from_ms"), from_ms)) return fail(error, 400, "invalid_range", "from_ms must be a whole number of milliseconds.");
  } else {
    // Disk growth uses the system.disk_growth_days setting.
    const uint64_t lookback = request.growth ? static_cast<uint64_t>(settings.disk_growth_days) * 86'400'000ULL
                                             : static_cast<uint64_t>(settings.default_lookback_minutes) * 60'000ULL;
    from_ms = to_ms > lookback ? to_ms - lookback : 0;
  }
  // A window that ends in the future ends now.
  to_ms = std::min(to_ms, now_ms);
  if (from_ms >= to_ms) return fail(error, 400, "invalid_range", "from_ms must be before to_ms (and before now).");
  if (to_ms - from_ms > max_span_ms) {
    return fail(error, 400, "range_too_large",
                "The window is wider than " + std::to_string(settings.max_lookback_days) + " days (system.max_lookback_days).");
  }
  request.from_ms = from_ms;
  request.to_ms = to_ms;
  MonitorSeriesWindow& window = request.window;
  window.step_s = monitor_series_step_seconds((to_ms - from_ms + 999) / 1000);
  window.from_s = from_ms / 1000 / window.step_s * window.step_s;
  window.to_s = ((to_ms + 999) / 1000 + window.step_s - 1) / window.step_s * window.step_s;
  window.now_s = now_ms / 1000;
  window.span_s = (to_ms - from_ms + 999) / 1000;
  window.query_log_max_span_s = static_cast<uint64_t>(settings.query_log_max_lookback_hours) * 3600ULL;
  window.query_log_max_rows = settings.query_log_max_rows;
  request.refresh = param(req, "refresh") == "1";
  *out = std::move(request);
  return true;
}

bool parse_queries_request(const httplib::Request& req, const SystemSettings& settings, uint64_t now_ms, QueriesRequest* out, ApiError* error) {
  if (const auto unknown = unknown_param_error(
          req, {"host_id", "from_ms", "to_ms", "sort", "kind", "errors", "user", "database", "table", "hide_chdash", "refresh"})) {
    *error = *unknown;
    return false;
  }
  QueriesRequest request;
  request.host_id = param(req, "host_id");
  if (request.host_id.empty()) return fail(error, 400, "missing_host_id", "Missing host_id.");
  const std::string sort = req.has_param("sort") ? param(req, "sort") : std::string("total_time");
  if (!member(monitor_queries_sorts(), sort)) return fail(error, 400, "invalid_sort", "sort must be one of " + one_of(monitor_queries_sorts()) + ".");
  const std::string kind = req.has_param("kind") ? param(req, "kind") : std::string("all");
  if (!member(monitor_queries_kinds(), kind)) return fail(error, 400, "invalid_kind", "kind must be one of " + one_of(monitor_queries_kinds()) + ".");
  const std::string errors = req.has_param("errors") ? param(req, "errors") : std::string("all");
  if (!member(monitor_queries_error_filters(), errors)) {
    return fail(error, 400, "invalid_errors", "errors must be one of " + one_of(monitor_queries_error_filters()) + ".");
  }
  // One user, or every user (absent or empty).
  const std::string user = param(req, "user");
  if (!user.empty() && !monitor_queries_user_valid(user)) {
    return fail(error, 400, "invalid_user", "user must be 1 to " + std::to_string(kMonitorQueryUserMaxBytes) + " bytes without control characters.");
  }
  // One database and / or one table ("database.table") that the shapes involve. Absent or empty means any.
  const std::string database = param(req, "database");
  if (!database.empty() && !monitor_queries_database_valid(database)) {
    return fail(error, 400, "invalid_database", "database must be 1 to " + std::to_string(kMonitorQueryObjectMaxBytes) + " bytes without control characters.");
  }
  const std::string table = param(req, "table");
  if (!table.empty() && !monitor_queries_table_valid(table)) {
    return fail(error, 400, "invalid_table",
                "table must be database.table, 3 to " + std::to_string(kMonitorQueryObjectMaxBytes) + " bytes without control characters.");
  }
  const std::string hide = req.has_param("hide_chdash") ? param(req, "hide_chdash") : std::string("1");
  if (hide != "1" && hide != "0") return fail(error, 400, "invalid_hide_chdash", "hide_chdash must be 1 or 0.");

  uint64_t from_ms = 0, to_ms = 0;
  if (!queries_window(req, settings, now_ms, from_ms, to_ms, error)) return false;
  request.from_ms = from_ms;
  request.to_ms = to_ms;
  MonitorQueriesRequest& q = request.query;
  // Minute-aligned: every request of the same minute shares one read.
  q.from_s = from_ms / 60'000 * 60;
  q.to_s = (to_ms + 59'999) / 60'000 * 60;
  q.now_s = now_ms / 1000;
  q.sort = sort;
  q.kind = kind;
  q.errors = errors;
  q.user = user;
  q.database = database;
  q.table = table;
  q.hide_chdash = hide == "1";
  q.max_rows = settings.query_log_max_rows;
  request.refresh = param(req, "refresh") == "1";
  *out = std::move(request);
  return true;
}

bool parse_query_request(const httplib::Request& req, const std::string& hash_text, const SystemSettings& settings, uint64_t now_ms,
                         QueryRequest* out, ApiError* error) {
  if (const auto unknown = unknown_param_error(req, {"host_id", "from_ms", "to_ms", "order", "hide_chdash", "refresh"})) {
    *error = *unknown;
    return false;
  }
  QueryRequest request;
  request.host_id = param(req, "host_id");
  if (request.host_id.empty()) return fail(error, 400, "missing_host_id", "Missing host_id.");
  uint64_t hash = 0;
  if (!parse_hash(hash_text, hash)) return fail(error, 400, "invalid_hash", "The query hash must be a normalized_query_hash (a UInt64).");
  const std::string order = req.has_param("order") ? param(req, "order") : std::string("duration");
  if (!member(monitor_query_run_orders(), order)) return fail(error, 400, "invalid_order", "order must be one of duration, latest, memory.");
  const std::string hide = req.has_param("hide_chdash") ? param(req, "hide_chdash") : std::string("1");
  if (hide != "1" && hide != "0") return fail(error, 400, "invalid_hide_chdash", "hide_chdash must be 1 or 0.");

  uint64_t from_ms = 0, to_ms = 0;
  if (!queries_window(req, settings, now_ms, from_ms, to_ms, error)) return false;
  request.from_ms = from_ms;
  request.to_ms = to_ms;
  MonitorQueriesRequest& q = request.query;
  // The Performance steps have at most 300 buckets.
  // The window is aligned to the step. A minute-aligned window is already aligned for steps up to 1 min.
  q.step_s = monitor_series_step_seconds((to_ms - from_ms + 999) / 1000);
  q.from_s = from_ms / 1000 / q.step_s * q.step_s;
  q.to_s = ((to_ms + 999) / 1000 + q.step_s - 1) / q.step_s * q.step_s;
  q.now_s = now_ms / 1000;
  q.hash = hash;
  q.order = order;
  q.hide_chdash = hide == "1";
  q.max_rows = settings.query_log_max_rows;
  request.refresh = param(req, "refresh") == "1";
  *out = std::move(request);
  return true;
}

}  // namespace system_page
}  // namespace chdash
