#pragma once

// What the units of the System page share and that no other file needs: the readers of a cell of a result, the lists of columns that the
// capability detection looks for, the time predicate of the *_log tables, and the runner's boundary. Each section of the page has its own
// unit (system_overview, system_series, system_queries, system_disks); the detection and the SETTINGS clause are in system_monitor_caps.cpp.

#include "acl_service.hpp"
#include "ch_block_value.hpp"
#include "sql_literal.hpp"
#include "system_series.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace chdash {
namespace monitor_internal {

using sql::quote_string;

inline uint64_t monitor_now_ms() {
  using namespace std::chrono;
  return static_cast<uint64_t>(duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count());
}

inline std::string text(const clickhouse::Block& block, size_t column, size_t row) {
  return ch_block_text_at(block, column, row);
}

inline uint64_t u64(const std::string& value) {
  if (value.empty()) return 0;
  try {
    size_t pos = 0;
    const unsigned long long parsed = std::stoull(value, &pos, 10);
    return pos == value.size() ? static_cast<uint64_t>(parsed) : 0;
  } catch (...) {
    return 0;
  }
}

inline std::optional<double> finite(const std::string& value) {
  if (value.empty()) return std::nullopt;
  try {
    size_t pos = 0;
    const double parsed = std::stod(value, &pos);
    if (pos != value.size() || !std::isfinite(parsed)) return std::nullopt;
    return parsed;
  } catch (...) {
    return std::nullopt;
  }
}

inline bool flag(const std::string& value) {
  return value == "1" || value == "true";
}

inline std::string in_list(const std::vector<std::string>& names) {
  std::string sql = "(";
  for (size_t index = 0; index < names.size(); ++index) {
    if (index) sql += ", ";
    sql += quote_string(names[index]);
  }
  return sql + ")";
}

// A text of lines, one value on each (the empty ones are dropped).
inline std::vector<std::string> split_lines(const std::string& value) {
  std::vector<std::string> out;
  size_t start = 0;
  while (start <= value.size() && !value.empty()) {
    const size_t end = value.find('\n', start);
    const std::string item = value.substr(start, end == std::string::npos ? std::string::npos : end - start);
    if (!item.empty()) out.push_back(item);
    if (end == std::string::npos) break;
    start = end + 1;
  }
  return out;
}

// The rows of system.query_log in a window [from_s, to_s): its primary key (event_date, event_time) prunes the parts.
inline std::string query_log_time_predicate(int64_t from_s, int64_t to_s) {
  const std::string from = "toDateTime(" + std::to_string(from_s) + ")";
  const std::string to = "toDateTime(" + std::to_string(to_s) + ")";
  return "event_date BETWEEN toDate(" + from + ") AND toDate(" + to + ") AND event_time >= " + from + " AND event_time < " + to;
}

// Two columns of a grouped read of query_log: the names in its array column `column` (databases, tables) and how many rows involved each,
// over every group of the answer (a window function after the GROUP BY, no second read), then the `limit` most involved as one
// "name\tcount" per line (the same on every row).
inline std::string query_log_object_list_sql(const std::string& column, const std::string& alias, size_t limit) {
  return "sumMap(sumMap(arrayMap(x -> toString(x), " + column + "), arrayMap(x -> toUInt64(1), " + column + "))) OVER () AS " + alias + ", "
         "arrayStringConcat(arrayMap(x -> concat(replaceAll(replaceAll(x.1, '\\t', ' '), '\\n', ' '), '\\t', toString(x.2)), "
         "arraySlice(arrayReverseSort(x -> x.2, arrayZip(" + alias + ".1, " + alias + ".2)), 1, " + std::to_string(limit) + ")), '\\n')";
}

// The runner's boundary (its ACL, kept by the AclService), resolved lazily per
// database (the RunnerVisibility of system_activity.cpp).
class VisibleTables {
public:
  explicit VisibleTables(AclView& acl) : acl_(acl) {}

  const std::vector<std::string>& databases() { return acl_.databases(); }
  bool visible(const std::string& database, const std::string& table) { return acl_.visible(database, table); }

private:
  AclView& acl_;
};

// The columns of the system tables that the detection looks for (system_monitor_caps.cpp), by the section that reads them.
std::vector<std::string> metric_log_columns();
const std::vector<std::string>& disk_columns();
const std::vector<std::string>& storage_policy_columns();

// The time predicate and the number of buckets of a window of the *_log tables (the primary key of each: event_date, event_time), and the
// reader of one value of a series, shared by the Performance series and the growth of the disks (system_series.cpp).
std::string series_time_predicate(const MonitorSeriesWindow& w);
uint64_t series_bucket_count(const MonitorSeriesWindow& w);
double f64_at(const clickhouse::Block& block, size_t column, size_t row);
void source_failed(MonitorSeriesSource& source, const MonitorCapabilities& caps, const std::exception& error);

}  // namespace monitor_internal
}  // namespace chdash
