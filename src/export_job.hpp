#pragma once

#include <chrono>
#include <cstddef>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace chdash {

enum class ExportFormat {
  Csv,
  Json,
};

struct ExportJob {
  std::string export_id;
  std::string host_id;
  ExportFormat format = ExportFormat::Csv;
  std::vector<std::string> queries;
  std::chrono::steady_clock::time_point created_at{};
  std::chrono::steady_clock::time_point expires_at{};
};

class ExportJobStore {
public:
  ExportJobStore(
      std::chrono::milliseconds ttl,
      size_t max_entries,
      size_t max_total_sql_bytes);

  bool put(ExportJob job, std::string* error = nullptr);

  // One-time capability consumption. The job is erased atomically before it is
  // returned so the same download token cannot open two streams.
  std::optional<ExportJob> consume(
      const std::string& export_id,
      const std::string& host_id);

  size_t size();
  size_t retained_sql_bytes();
  void prune();

private:
  void prune_locked(std::chrono::steady_clock::time_point now);
  void erase_locked(std::unordered_map<std::string, ExportJob>::iterator it);

  const std::chrono::milliseconds ttl_;
  const size_t max_entries_;
  const size_t max_total_sql_bytes_;
  size_t retained_sql_bytes_ = 0;
  std::mutex mu_;
  std::unordered_map<std::string, ExportJob> jobs_;
};

const char* export_format_name(ExportFormat format);

} // namespace chdash
