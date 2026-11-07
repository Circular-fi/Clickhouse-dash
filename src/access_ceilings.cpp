#include "access_ceilings.hpp"

#include "access_actions.hpp"
#include "access_enforce.hpp"
#include "log.hpp"

#include <algorithm>

namespace chdash {
namespace {

// The schema max of the keys that bound the ceilings (config_keys.def): a row or byte count is at most 10^15, a memory size at most 1 TiB,
// a duration at most 7 days. All of them are below 2^53, so a reader that uses floating point numbers reads them exactly.
constexpr uint64_t kRowsMax = 1'000'000'000'000'000ULL;
constexpr uint64_t kBytesMax = 1'000'000'000'000'000ULL;
constexpr uint64_t kResultBytesMax = 1'099'511'627'776ULL;
constexpr uint64_t kSecondsMax = 604'800ULL;
constexpr uint64_t kMemoryMax = 1'099'511'627'776ULL;

}  // namespace

uint64_t AccessCeilings::get(std::string_view name) const {
  if (name == "max_rows_read") return max_rows_read;
  if (name == "max_read_size") return max_read_size;
  if (name == "max_rows") return max_rows;
  if (name == "max_result_size") return max_result_size;
  if (name == "max_duration") return max_duration;
  if (name == "max_memory") return max_memory;
  return 0;
}

bool AccessCeilings::set(std::string_view name, uint64_t value) {
  if (name == "max_rows_read") max_rows_read = value;
  else if (name == "max_read_size") max_read_size = value;
  else if (name == "max_rows") max_rows = value;
  else if (name == "max_result_size") max_result_size = value;
  else if (name == "max_duration") max_duration = value;
  else if (name == "max_memory") max_memory = value;
  else return false;
  return true;
}

AccessCeilings AccessRunCeilings::resolve(SqlStatementClass sql_class) const {
  AccessCeilings run;
  if (has_read && has_write) {
    if (sql_class == SqlStatementClass::Read) run = read;
    else if (sql_class == SqlStatementClass::Write) run = write;
    else run = access_ceilings_lowest(read, write);
  } else if (has_write) {
    run = write;
  } else if (has_read) {
    run = read;
  }
  return access_ceilings_lowest(base, run);
}

AccessCeilings access_ceilings_of(const std::map<std::string, uint64_t>& limits) {
  AccessCeilings out;
  for (const auto& [name, value] : limits) out.set(name, value);
  return out;
}

const std::vector<AccessCeilingInfo>& access_ceiling_table() {
  static const std::vector<AccessCeilingInfo> table = {
      {"max_rows_read", "Most rows read by one run",
       "The most rows that one run reads from the tables. A run that reads more stops with an error. ChDash sets max_rows_to_read and counts "
       "the progress that ClickHouse reports.",
       "rows", kRowsMax, "max_rows_to_read"},
      {"max_read_size", "Most bytes read by one run",
       "The most bytes that one run reads from the tables. A run that reads more stops with an error. ChDash sets max_bytes_to_read and "
       "counts the progress that ClickHouse reports.",
       "bytes", kBytesMax, "max_bytes_to_read"},
      {"max_rows", "Most rows in the result of one run",
       "The most rows in the result of one run. A run with more rows stops with an error. ChDash sets max_result_rows and counts the rows "
       "that it receives.",
       "rows", kRowsMax, "max_result_rows"},
      {"max_result_size", "Largest result of one run",
       "The most bytes in the result of one run. A run with a larger result stops with an error. ChDash sets max_result_bytes and counts the "
       "bytes that it sends on.",
       "bytes", kResultBytesMax, "max_result_bytes"},
      {"max_duration", "Longest duration of one run",
       "The most seconds that one run takes. A run that takes longer stops with an error. ChDash sets max_execution_time and stops the run "
       "with a deadline.",
       "seconds", kSecondsMax, "max_execution_time"},
      {"max_memory", "Most memory used by one run",
       "The most memory in bytes that one run uses. ChDash sets max_memory_usage. The settings profile of the ClickHouse user enforces it: "
       "ChDash does not count memory itself.",
       "bytes", kMemoryMax, "max_memory_usage"},
  };
  return table;
}

std::vector<std::string> access_action_ceilings(std::string_view action) {
  if (action == "query.run.read" || action == "query.run.write" || action == "query.export") {
    return {"max_rows_read", "max_read_size", "max_rows", "max_result_size", "max_duration", "max_memory"};
  }
  if (action == "explorer.read") return {"max_rows", "max_rows_read", "max_duration", "max_memory"};
  if (action == "system.read" || action == "observability.read") return {"max_rows_read", "max_rows", "max_duration"};
  return {};
}

std::set<std::string> access_declared_ceilings(std::string_view action, const AccessFeatures& features) {
  const AccessAction* known = access_action(action);
  if (!known || !access_action_published(*known, features)) return {};
  const std::vector<std::string> names = access_action_ceilings(action);
  return std::set<std::string>(names.begin(), names.end());
}

bool access_ceilings_enforceable(const std::map<std::string, uint64_t>& limits, std::string_view action, const AccessFeatures& features,
                                 std::string* refused) {
  const std::set<std::string> declared = access_declared_ceilings(action, features);
  for (const auto& [name, value] : limits) {
    if (declared.count(name) != 0 && value >= 1) continue;
    if (refused) *refused = name;
    return false;
  }
  return true;
}

uint64_t access_declared_max(const std::vector<uint64_t>& bounds, uint64_t schema_max) {
  uint64_t out = 0;
  for (const uint64_t bound : bounds) out = std::max(out, bound == 0 ? schema_max : bound);
  return out == 0 ? schema_max : out;
}

uint64_t access_ceiling_max(const AccessCeilings& bounds, const AccessCeilingInfo& info) {
  const uint64_t value = bounds.get(info.name);
  return value == 0 ? info.schema_max : value;
}

std::string ceiling_breach_code(std::string_view text) {
  for (const char* code : {"query_scan_limit", "query_result_limit", "query_timeout"}) {
    const std::string_view name = code;
    if (text.substr(0, name.size()) == name && text.substr(name.size(), 2) == ": ") return std::string(name);
  }
  return std::string();
}

CeilingDeadline::CeilingDeadline(uint64_t seconds, std::function<void()> on_expired) : on_expired_(std::move(on_expired)) {
  if (seconds == 0) return;
  thread_ = std::thread([this, seconds] { run(seconds); });
}

CeilingDeadline::~CeilingDeadline() {
  {
    std::lock_guard<std::mutex> lock(mu_);
    stop_ = true;
  }
  cv_.notify_all();
  if (thread_.joinable()) thread_.join();
}

bool CeilingDeadline::expired() const {
  std::lock_guard<std::mutex> lock(mu_);
  return expired_;
}

void CeilingDeadline::run(uint64_t seconds) {
  std::unique_lock<std::mutex> lock(mu_);
  // A very large value must not overflow the clock: more than a day is not an expiry that a run can reach.
  const auto wait = std::chrono::seconds(std::min<uint64_t>(seconds, 365ULL * 24 * 3600));
  if (cv_.wait_for(lock, wait, [this] { return stop_; })) return;
  expired_ = true;
  lock.unlock();
  if (on_expired_) on_expired_();
}

void access_enforce_ceilings(const std::string& request_id, const std::vector<AccessQuestion>& questions,
                             std::vector<AccessDecision>* decisions, const AccessFeatures& features, bool can_apply) {
  for (size_t i = 0; i < questions.size() && i < decisions->size(); ++i) {
    AccessDecision& decision = (*decisions)[i];
    if (!decision.allowed || decision.limits.empty() || questions[i].match == AccessMatch::Subtree) continue;
    std::string refused;
    bool enforceable = false;
    if (can_apply) {
      enforceable = access_ceilings_enforceable(decision.limits, questions[i].action, features, &refused);
    } else {
      refused = decision.limits.begin()->first;
    }
    if (enforceable) continue;
    log_event(LogLevel::Warn, "access.ceiling_unenforceable",
              {{"request_id", request_id}, {"action", questions[i].action}, {"resource", access_resource_path(questions[i].resource)},
               {"ceiling", refused.substr(0, 128)}});
    decision.allowed = false;
    decision.reason = PdpReason::None;
    decision.limits.clear();
    decision.usage_units.reset();
  }
}

}  // namespace chdash
