#pragma once

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace chdash {

enum class QueryRunMode {
  Normal,
  Profiling,
};

struct QueryRegistryRecord {
  std::string query_id;
  std::string host_id;
  std::vector<std::string> native_query_ids;
  QueryRunMode run_mode = QueryRunMode::Normal;
  std::string terminal_status;
  bool partial_execution = false;
  int64_t session_elapsed_ms = -1;

  // Retained only for the bounded Deep Analyze replay window. It is always the
  // SQL submitted to runner_uri; system_uri is never used to replay user SQL.
  std::string original_sql;

  std::chrono::steady_clock::time_point created_at{};
  std::chrono::steady_clock::time_point updated_at{};
};

class QueryRegistry {
public:
  QueryRegistry(
      std::chrono::milliseconds ttl,
      size_t max_entries,
      size_t max_sql_bytes = 32 * 1024 * 1024);

  void register_query(
      const std::string& query_id,
      const std::string& host_id,
      QueryRunMode run_mode,
      std::string original_sql = {});

  void add_native_query_id(
      const std::string& query_id,
      const std::string& native_query_id);

  void mark_terminal(
      const std::string& query_id,
      std::string terminal_status,
      bool partial_execution,
      int64_t session_elapsed_ms);

  // Query records are panel-scoped, not user-scoped. Host id is still checked
  // so a public query id from one configured host cannot be reused on another.
  std::optional<QueryRegistryRecord> find(
      const std::string& query_id,
      const std::string& host_id);

  size_t size();
  size_t retained_sql_bytes();
  void prune();

private:
  void prune_locked(std::chrono::steady_clock::time_point now);
  void erase_record_locked(std::unordered_map<std::string, QueryRegistryRecord>::iterator it);
  void evict_oldest_locked();
  void trim_sql_budget_locked(const std::string& protected_query_id);

  const std::chrono::milliseconds ttl_;
  const size_t max_entries_;
  const size_t max_sql_bytes_;
  size_t retained_sql_bytes_ = 0;
  std::mutex mu_;
  std::unordered_map<std::string, QueryRegistryRecord> records_;
};

} // namespace chdash
