#include "system_activity.hpp"

#include "allowed_objects.hpp"
#include "ch_block_value.hpp"
#include "explorer_catalog.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <exception>
#include <string_view>
#include <unordered_map>
#include <utility>

namespace chdash {
namespace {

uint64_t ops_now_ms() {
  using namespace std::chrono;
  return static_cast<uint64_t>(duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count());
}

std::string text(const clickhouse::Block& block, size_t column, size_t row) {
  return ch_block_text_at(block, column, row);
}

uint64_t u64(const std::string& value) {
  if (value.empty()) return 0;
  try {
    size_t pos = 0;
    const unsigned long long parsed = std::stoull(value, &pos, 10);
    return pos == value.size() ? static_cast<uint64_t>(parsed) : 0;
  } catch (...) {
    return 0;
  }
}

int64_t i64(const std::string& value) {
  if (value.empty()) return 0;
  try {
    size_t pos = 0;
    const long long parsed = std::stoll(value, &pos, 10);
    return pos == value.size() ? static_cast<int64_t>(parsed) : 0;
  } catch (...) {
    return 0;
  }
}

double f64(const std::string& value) {
  if (value.empty()) return 0;
  try {
    size_t pos = 0;
    const double parsed = std::stod(value, &pos);
    return pos == value.size() && std::isfinite(parsed) ? parsed : 0;
  } catch (...) {
    return 0;
  }
}

bool flag(const std::string& value) {
  return value == "1" || value == "true";
}

std::string quote_string(std::string_view value) {
  std::string out;
  out.reserve(value.size() + 2);
  out.push_back('\'');
  for (const char ch : value) {
    if (ch == '\\') out += "\\\\";
    else if (ch == '\'') out += "\\'";
    else out.push_back(ch);
  }
  out.push_back('\'');
  return out;
}

std::string object_key(const std::string& database, const std::string& table) {
  std::string key = database;
  key.push_back('\0');
  key += table;
  return key;
}

template <typename Fn>
bool try_select(clickhouse::Client& client, const std::string& sql, Fn&& fn, std::string* error) {
  try {
    client.Select(sql, std::forward<Fn>(fn));
    return true;
  } catch (const std::exception& e) {
    if (error) *error = e.what();
    return false;
  }
}

// Runner-context SHOW boundary, resolved lazily per database: only databases
// that actually appear in an activity row are enumerated.
class RunnerVisibility {
public:
  explicit RunnerVisibility(clickhouse::Client& runner) : runner_(runner), databases_(discover_visible_databases(runner)) {
    std::sort(databases_.begin(), databases_.end());
  }

  const std::vector<std::string>& databases() const { return databases_; }

  bool visible(const std::string& database, const std::string& table) {
    if (!std::binary_search(databases_.begin(), databases_.end(), database)) return false;
    auto it = objects_.find(database);
    if (it == objects_.end()) {
      auto objects = discover_visible_objects(runner_, database);
      std::sort(objects.begin(), objects.end());
      it = objects_.emplace(database, std::move(objects)).first;
    }
    return std::binary_search(it->second.begin(), it->second.end(), table);
  }

private:
  clickhouse::Client& runner_;
  std::vector<std::string> databases_;
  std::unordered_map<std::string, std::vector<std::string>> objects_;
};

// Reads at most row_limit + 1 rows so truncation is detected without a
// count() query. Returns false when the system table is unavailable.
template <typename Row, typename Parse>
bool load_section(
    clickhouse::Client& system,
    RunnerVisibility& visibility,
    const std::string& name,
    const std::string& sql,
    size_t row_limit,
    std::vector<Row>& out,
    SystemActivity& activity,
    Parse&& parse) {
  bool truncated = false;
  std::string section_error;
  const bool ok = try_select(system, sql, [&](const clickhouse::Block& block) {
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      const std::string database = text(block, 0, row);
      const std::string table = text(block, 1, row);
      if (!visibility.visible(database, table)) continue;
      if (out.size() >= row_limit) {
        truncated = true;
        continue;
      }
      Row item;
      item.database = database;
      item.table = table;
      parse(item, block, row);
      out.push_back(std::move(item));
    }
  }, &section_error);
  if (!ok) {
    out.clear();
    activity.unavailable_sections.push_back(name);
    if (activity.unavailable_detail.empty()) activity.unavailable_detail = section_error;
    return false;
  }
  if (truncated) activity.truncated_sections.push_back(name);
  return true;
}

} // namespace

bool load_system_activity(
    clickhouse::Client& system,
    clickhouse::Client& runner,
    size_t row_limit,
    SystemActivity& out,
    std::string* error) {
  out = SystemActivity{};
  out.generated_at_ms = ops_now_ms();
  out.row_limit = std::max<size_t>(1, row_limit);
  RunnerVisibility visibility(runner);
  if (visibility.databases().empty()) return true;

  // Rows of databases the runner cannot SHOW are excluded inside ClickHouse,
  // so they never consume the bounded LIMIT; table-level visibility is then
  // checked per row before anything is kept.
  std::string in_databases = "database IN (";
  for (size_t index = 0; index < visibility.databases().size(); ++index) {
    if (index) in_databases += ", ";
    in_databases += quote_string(visibility.databases()[index]);
  }
  in_databases += ")";
  const std::string limit = " LIMIT " + std::to_string(out.row_limit + 1);

  load_section(system, visibility, "merges",
    "SELECT toString(database), toString(`table`), toString(elapsed), toString(progress), toString(num_parts), "
    "toString(result_part_name), toString(partition_id), toString(is_mutation), toString(merge_type), "
    "toString(total_size_bytes_compressed), toString(bytes_read_uncompressed), toString(rows_read), toString(memory_usage) "
    "FROM system.merges WHERE " + in_databases + " ORDER BY elapsed DESC" + limit,
    out.row_limit, out.merges, out,
    [](SystemActivityMerge& item, const clickhouse::Block& block, size_t row) {
      item.elapsed_seconds = f64(text(block, 2, row));
      item.progress = f64(text(block, 3, row));
      item.num_parts = u64(text(block, 4, row));
      item.result_part_name = text(block, 5, row);
      item.partition_id = text(block, 6, row);
      item.is_mutation = flag(text(block, 7, row));
      item.merge_type = text(block, 8, row);
      item.total_bytes_compressed = u64(text(block, 9, row));
      item.bytes_read_uncompressed = u64(text(block, 10, row));
      item.rows_read = u64(text(block, 11, row));
      item.memory_usage = u64(text(block, 12, row));
    });

  // Pending mutations only: finished ones are history, and a failing
  // mutation stays pending with its latest failure reason.
  load_section(system, visibility, "mutations",
    "SELECT toString(database), toString(`table`), toString(mutation_id), toString(command), toString(create_time), "
    "toString(parts_to_do), toString(is_done), toString(is_killed), toString(latest_failed_part), "
    "toString(latest_fail_time), toString(latest_fail_reason), toString(latest_fail_error_code_name) "
    "FROM system.mutations WHERE NOT is_done AND " + in_databases +
    " ORDER BY latest_fail_reason = '' ASC, create_time ASC" + limit,
    out.row_limit, out.mutations, out,
    [](SystemActivityMutation& item, const clickhouse::Block& block, size_t row) {
      item.mutation_id = text(block, 2, row);
      item.command = text(block, 3, row);
      item.create_time = text(block, 4, row);
      item.parts_to_do = u64(text(block, 5, row));
      item.is_done = flag(text(block, 6, row));
      item.is_killed = flag(text(block, 7, row));
      item.latest_failed_part = text(block, 8, row);
      item.latest_fail_time = text(block, 9, row);
      item.latest_fail_reason = text(block, 10, row);
      item.latest_fail_error_code_name = text(block, 11, row);
    });

  // One row per table: the queue itself can hold thousands of entries.
  load_section(system, visibility, "replication_queue",
    "SELECT toString(database), toString(`table`), toString(count()), toString(countIf(is_currently_executing)), "
    "toString(countIf(num_postponed > 0)), toString(max(num_tries)), toString(min(create_time)), "
    "arrayStringConcat(arraySort(groupUniqArray(toString(type))), ','), "
    "toString(anyIf(postpone_reason, postpone_reason != '')), "
    "toString(argMaxIf(last_exception, last_exception_time, last_exception != '')), "
    "toString(maxIf(last_exception_time, last_exception != '')) "
    "FROM system.replication_queue WHERE " + in_databases +
    " GROUP BY database, `table` ORDER BY count() DESC, database, `table`" + limit,
    out.row_limit, out.replication_queue, out,
    [](SystemActivityReplicationQueue& item, const clickhouse::Block& block, size_t row) {
      item.entries = u64(text(block, 2, row));
      item.executing = u64(text(block, 3, row));
      item.postponed = u64(text(block, 4, row));
      item.max_tries = u64(text(block, 5, row));
      item.oldest_create_time = text(block, 6, row);
      const std::string types = text(block, 7, row);
      size_t start = 0;
      while (start < types.size()) {
        const size_t end = types.find(',', start);
        const std::string type = types.substr(start, end == std::string::npos ? std::string::npos : end - start);
        if (!type.empty()) item.types.push_back(type);
        if (end == std::string::npos) break;
        start = end + 1;
      }
      item.postpone_reason = text(block, 8, row);
      item.last_exception = text(block, 9, row);
      item.last_exception_time = text(block, 10, row);
    });

  // In-memory replica state only. log_max_index, log_pointer,
  // total/active_replicas, zookeeper_exception and replica_is_active cost a
  // Keeper request per table and are not selected here; the replica counts
  // come from the shared 60 s cache below.
  const bool replicas_loaded = load_section(system, visibility, "replicas",
    "SELECT toString(database), toString(`table`), toString(replica_name), toString(is_leader), toString(is_readonly), "
    "toString(is_session_expired), toString(queue_size), toString(inserts_in_queue), toString(merges_in_queue), "
    "toString(absolute_delay), toString(queue_oldest_time), toString(last_queue_update), "
    "toString(last_queue_update_exception) "
    "FROM system.replicas WHERE " + in_databases +
    " ORDER BY (is_readonly OR is_session_expired) DESC, absolute_delay DESC, queue_size DESC, database, `table`" + limit,
    out.row_limit, out.replicas, out,
    [](SystemActivityReplica& item, const clickhouse::Block& block, size_t row) {
      item.replica_name = text(block, 2, row);
      item.is_leader = flag(text(block, 3, row));
      item.is_readonly = flag(text(block, 4, row));
      item.is_session_expired = flag(text(block, 5, row));
      item.queue_size = u64(text(block, 6, row));
      item.inserts_in_queue = u64(text(block, 7, row));
      item.merges_in_queue = u64(text(block, 8, row));
      item.absolute_delay_seconds = u64(text(block, 9, row));
      item.queue_oldest_time = text(block, 10, row);
      item.last_queue_update = text(block, 11, row);
      item.last_queue_update_exception = text(block, 12, row);
    });
  if (replicas_loaded && !out.replicas.empty()) {
    std::vector<std::pair<std::string, std::string>> tables;
    tables.reserve(out.replicas.size());
    for (const auto& replica : out.replicas) tables.emplace_back(replica.database, replica.table);
    std::string counts_error;
    const auto counts = load_cached_replica_counts(system, tables, &counts_error);
    for (auto& replica : out.replicas) {
      const auto it = counts.find(object_key(replica.database, replica.table));
      if (it == counts.end()) continue;
      replica.total_replicas = it->second.total;
      replica.active_replicas = it->second.active;
    }
  }

  load_section(system, visibility, "distribution_queue",
    "SELECT toString(database), toString(`table`), toString(data_path), toString(is_blocked), toString(error_count), "
    "toString(data_files), toString(data_compressed_bytes), toString(broken_data_files), "
    "toString(broken_data_compressed_bytes), toString(last_exception), toString(last_exception_time) "
    "FROM system.distribution_queue WHERE " + in_databases +
    " ORDER BY error_count DESC, data_files DESC, database, `table`" + limit,
    out.row_limit, out.distribution_queue, out,
    [](SystemActivityDistributionQueue& item, const clickhouse::Block& block, size_t row) {
      item.data_path = text(block, 2, row);
      item.is_blocked = flag(text(block, 3, row));
      item.error_count = u64(text(block, 4, row));
      item.data_files = u64(text(block, 5, row));
      item.data_compressed_bytes = u64(text(block, 6, row));
      item.broken_data_files = u64(text(block, 7, row));
      item.broken_data_compressed_bytes = u64(text(block, 8, row));
      item.last_exception = text(block, 9, row);
      item.last_exception_time = text(block, 10, row);
    });

  if (out.unavailable_sections.size() == 5) {
    if (error) {
      *error = "None of system.merges, system.mutations, system.replication_queue, system.replicas or system.distribution_queue is readable.";
      if (!out.unavailable_detail.empty()) *error += " " + out.unavailable_detail;
    }
    return false;
  }
  return true;
}

bool load_system_keeper_status(
    clickhouse::Client& system,
    SystemKeeperStatus& out,
    std::string* error) {
  out = SystemKeeperStatus{};
  out.generated_at_ms = ops_now_ms();

  auto consume_connections = [&](bool with_timeout) {
    return [&, with_timeout](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        SystemKeeperConnection item;
        item.name = text(block, 0, row);
        item.host = text(block, 1, row);
        item.port = u64(text(block, 2, row));
        item.index = u64(text(block, 3, row));
        item.connected_time = text(block, 4, row);
        item.session_uptime_seconds = u64(text(block, 5, row));
        item.is_expired = flag(text(block, 6, row));
        item.keeper_api_version = u64(text(block, 7, row));
        if (with_timeout) item.session_timeout_ms = u64(text(block, 8, row));
        out.connections.push_back(std::move(item));
      }
    };
  };
  const std::string connection_columns =
      "SELECT toString(name), toString(host), toString(port), toString(index), toString(connected_time), "
      "toString(session_uptime_elapsed_seconds), toString(is_expired), toString(keeper_api_version)";
  std::string section_error;
  if (!try_select(system, connection_columns + ", toString(session_timeout_ms) FROM system.zookeeper_connection ORDER BY name LIMIT 16",
                  consume_connections(true), &section_error)) {
    out.connections.clear();
    // session_timeout_ms is recent; older servers still expose the rest.
    if (!try_select(system, connection_columns + " FROM system.zookeeper_connection ORDER BY name LIMIT 16",
                    consume_connections(false), &section_error)) {
      out.connections.clear();
      out.unavailable_sections.push_back("connections");
    }
  }

  static const char* const kMetrics[] = {
    "ZooKeeperSession", "ZooKeeperSessionExpired", "ZooKeeperRequest", "ZooKeeperWatch",
    "ZooKeeperConnectionLossStartedTimestampSeconds", "KeeperAliveConnections", "KeeperOutstandingRequests",
  };
  static const char* const kEvents[] = {
    "ZooKeeperInit", "ZooKeeperTransactions", "ZooKeeperWaitMicroseconds", "ZooKeeperHardwareExceptions",
    "ZooKeeperUserExceptions", "ZooKeeperOtherExceptions", "ZooKeeperBytesSent", "ZooKeeperBytesReceived",
    "ZooKeeperList", "ZooKeeperCreate", "ZooKeeperRemove", "ZooKeeperExists", "ZooKeeperGet", "ZooKeeperSet",
    "ZooKeeperMulti", "ZooKeeperWatchResponse",
  };
  auto in_list = [](const auto& names) {
    std::string sql = "(";
    bool first = true;
    for (const char* name : names) {
      if (!first) sql += ", ";
      first = false;
      sql += quote_string(name);
    }
    return sql + ")";
  };
  if (!try_select(system, "SELECT toString(metric), toString(value) FROM system.metrics WHERE metric IN " + in_list(kMetrics),
        [&](const clickhouse::Block& block) {
          for (size_t row = 0; row < block.GetRowCount(); ++row) out.metrics[text(block, 0, row)] = i64(text(block, 1, row));
        }, &section_error)) {
    out.metrics.clear();
    out.unavailable_sections.push_back("metrics");
  }
  if (!try_select(system, "SELECT toString(event), toString(value) FROM system.events WHERE event IN " + in_list(kEvents),
        [&](const clickhouse::Block& block) {
          for (size_t row = 0; row < block.GetRowCount(); ++row) out.events[text(block, 0, row)] = u64(text(block, 1, row));
        }, &section_error)) {
    out.events.clear();
    out.unavailable_sections.push_back("events");
  }
  if (out.unavailable_sections.size() == 3) {
    if (error) *error = "Keeper status is unavailable: " + section_error;
    return false;
  }
  const auto session = out.metrics.find("ZooKeeperSession");
  out.configured = !out.connections.empty() || (session != out.metrics.end() && session->second > 0);
  return true;
}

} // namespace chdash
