#pragma once

#include "query_registry.hpp"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace chdash {

class ClickHouseClientPool;

struct QueryExecutionStats {
  bool available = false;
  bool logs_pending = false;
  std::string error;
  std::string query_id;
  std::string native_query_id;
  std::string status;
  std::string event_time;
  uint64_t duration_ms = 0;
  uint64_t read_rows = 0;
  uint64_t read_bytes = 0;
  uint64_t written_rows = 0;
  uint64_t written_bytes = 0;
  uint64_t result_rows = 0;
  uint64_t result_bytes = 0;
  int64_t memory_usage = 0;
  uint64_t peak_threads_usage = 0;
  std::vector<std::string> databases;
  std::vector<std::string> tables;
  std::vector<std::string> projections;
  int32_t exception_code = 0;
  std::string exception;
};

QueryExecutionStats collect_query_execution(
    const QueryRegistryRecord& record,
    const std::string& system_uri,
    const std::shared_ptr<ClickHouseClientPool>& client_pool,
    int lookup_timeout_ms,
    bool flush_logs);

} // namespace chdash
