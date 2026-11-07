#pragma once

#include "access_ceilings.hpp"

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

// What the access check decided when the export was made (docs/access.md, "Limits of a grant"). The stream asks the PDP again and applies
// the lower of the two ceilings, so the stream is never looser than the run was.
struct ExportJobAccess {
  AccessCeilings ceilings;  // the ceilings of query.export and of the class of the SQL
  bool read_only = false;   // the person had no query.run.write: each statement runs with readonly = 1
  SqlStatementClass sql_class = SqlStatementClass::Unsure;
};

struct ExportJob {
  std::string export_id;
  std::string host_id;
  ExportFormat format = ExportFormat::Csv;
  std::vector<std::string> queries;
  ExportJobAccess access;
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

  // The access part of a pending job, without taking the job. False when the job is not there (as consume).
  bool peek_access(const std::string& export_id, const std::string& host_id, ExportJobAccess* out);

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
