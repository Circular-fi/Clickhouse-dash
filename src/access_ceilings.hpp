#pragma once

// The ceilings of a grant (docs/access.md, "Limits of a grant"; ProcurAuth sections 6.1, 7 and 8).
// A ceiling is the most that one use of an action can take. The PDP gives the value in context.limits of a true answer.
// ChDash declares six ceilings in its action document. This file holds:
//   - the table of the six ceilings, the ceilings that each action lists and the declaration of each ceiling in the document;
//   - AccessCeilings, the typed value of the ceilings of one request, and the rule that the lower value wins;
//   - apply_ceilings, the one function that lowers the bounds of a statement (ChQueryLimits);
//   - CeilingMeter and CeilingDeadline, the backstops of the client. They count what the progress packets and the result
//     blocks show, and they stop a run that goes past a ceiling, also when the SQL of the run sets a setting of its own.
// This header needs no other file of ChDash. The code of the ceilings that needs the actions is in access_ceilings.cpp.

#include "user_sql_policy.hpp"

#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <map>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

namespace chdash {

struct ChQueryLimits;
struct AccessFeatures;

// The value of each ceiling for one request. The value 0 means "no ceiling": the declaration has min 1, so a grant never gives 0.
struct AccessCeilings {
  uint64_t max_rows_read = 0;    // rows read from the tables       -> max_rows_to_read
  uint64_t max_read_size = 0;    // bytes read from the tables      -> max_bytes_to_read
  uint64_t max_rows = 0;         // rows of the result              -> max_result_rows
  uint64_t max_result_size = 0;  // bytes of the result             -> max_result_bytes
  uint64_t max_duration = 0;     // seconds                         -> max_execution_time
  uint64_t max_memory = 0;       // bytes                           -> max_memory_usage

  // True when at least one ceiling is set.
  bool any() const {
    return max_rows_read != 0 || max_read_size != 0 || max_rows != 0 || max_result_size != 0 || max_duration != 0 || max_memory != 0;
  }
  // The value of the ceiling `name` (0 for a name that ChDash does not know), and a setter that returns false for such a name.
  uint64_t get(std::string_view name) const;
  bool set(std::string_view name, uint64_t value);
  bool operator==(const AccessCeilings& other) const {
    return max_rows_read == other.max_rows_read && max_read_size == other.max_read_size && max_rows == other.max_rows &&
           max_result_size == other.max_result_size && max_duration == other.max_duration && max_memory == other.max_memory;
  }
  bool operator!=(const AccessCeilings& other) const { return !(*this == other); }
};

// The lower value of each ceiling. A ceiling that only one side sets stays as it is (ProcurAuth 8.2).
inline AccessCeilings access_ceilings_lowest(const AccessCeilings& a, const AccessCeilings& b) {
  const auto lower = [](uint64_t x, uint64_t y) -> uint64_t { return x == 0 ? y : (y == 0 ? x : (x < y ? x : y)); };
  AccessCeilings out;
  out.max_rows_read = lower(a.max_rows_read, b.max_rows_read);
  out.max_read_size = lower(a.max_read_size, b.max_read_size);
  out.max_rows = lower(a.max_rows, b.max_rows);
  out.max_result_size = lower(a.max_result_size, b.max_result_size);
  out.max_duration = lower(a.max_duration, b.max_duration);
  out.max_memory = lower(a.max_memory, b.max_memory);
  return out;
}

// The ceilings of the context.limits of a decision (the map of PdpLimits). A name that ChDash does not declare is left out:
// access_ceilings_enforceable refuses such a decision before this call.
AccessCeilings access_ceilings_of(const std::map<std::string, uint64_t>& limits);

// The declaration of one ceiling and its ClickHouse setting.
struct AccessCeilingInfo {
  const char* name;
  const char* label;        // 60 characters at most
  const char* description;  // 300 characters at most
  const char* unit;
  uint64_t schema_max;      // the declared max when no key of the configuration bounds the ceiling
  const char* setting;      // the ClickHouse setting that carries the ceiling
};

// The six ceilings, in the order of the document.
const std::vector<AccessCeilingInfo>& access_ceiling_table();

// The names of the ceilings that an action lists, in the order of the table. Empty for an action without ceilings.
std::vector<std::string> access_action_ceilings(std::string_view action);

// The declaration of one budget (ProcurAuth 6.1): the name is the plural noun of the thing that it counts, with no unit and no window.
struct AccessBudgetInfo {
  const char* name;
  const char* label;        // 60 characters at most
  const char* description;  // 300 characters at most
  const char* unit;         // 20 characters at most
};

// The three budgets, in the order of the document: queries (query.run.read, query.run.write), exports (query.export) and requests
// (mcp.session).
const std::vector<AccessBudgetInfo>& access_budget_table();

// The names of the budgets that an action lists. Empty for an action without a budget. A budget is counted at the use of the action
// (ProcurAuth 6.2), and the use is the run of SQL, the download of an export or a request of MCP that calls no tool: pages, probes, the
// formatter and the other questions of display take no unit (docs/access.md, "Budgets").
std::vector<std::string> access_action_budgets(std::string_view action);

// True when the document lists a budget on `action` with these features: the action is published and has a budget. Only then the use of the
// action sends a question with context.usage (ProcurAuth 6.4). A route that the document lists with no budget sends none.
bool access_action_has_budget(std::string_view action, const AccessFeatures& features);

// The ceilings that the document declares for `action` with these features: the list of access_action_ceilings when the
// action is published, else nothing. ChDash applies these ceilings and no other one (ProcurAuth 7.5).
std::set<std::string> access_declared_ceilings(std::string_view action, const AccessFeatures& features);

// The ceilings of the answers that guard one request (ProcurAuth 5.5a, 7.4). `base` holds the ceilings that always apply: the ceilings of the
// action of the route, and for an export the ceilings of query.export. A request that runs SQL can hold both query.run.read and
// query.run.write: then the class of the SQL (user_sql_policy.hpp) decides which of the two answers applies. When the class is
// unsure, the lower value of each ceiling applies. A person with one of the two actions uses the ceilings of that action.
struct AccessRunCeilings {
  AccessCeilings base;
  AccessCeilings read;
  AccessCeilings write;
  bool has_read = false;   // query.run.read is true for this request
  bool has_write = false;  // query.run.write is true for this request

  // The ceilings that apply to SQL of class `sql_class`.
  AccessCeilings resolve(SqlStatementClass sql_class) const;
};

// ProcurAuth 7.5: true when ChDash can apply each ceiling of `limits` for `action`. A name that the action does not list makes it
// false. A value below the declared min (1) is outside the declaration: it makes it false too. A value above the declared max is
// not a fault: the applied value is the lowest of the ceiling, the bound of the configuration and the profile.
// *refused receives the first name that fails.
bool access_ceilings_enforceable(const std::map<std::string, uint64_t>& limits, std::string_view action, const AccessFeatures& features,
                                 std::string* refused = nullptr);

// The declared max of one ceiling: the highest of the bounds of the configuration that carry it. A bound of 0 stands for the schema max
// of the key, which is `schema_max`. Without any bound, it is `schema_max`.
uint64_t access_declared_max(const std::vector<uint64_t>& bounds, uint64_t schema_max);

// The declared max of the ceiling `name` for the document. `bounds` holds the highest bound of the configuration for each ceiling:
// a value of 0 stands for the schema max of the ceiling (AccessCeilingInfo::schema_max).
uint64_t access_ceiling_max(const AccessCeilings& bounds, const AccessCeilingInfo& info);

// The one function that applies the ceilings to the bounds of a statement. Each ceiling lowers the matching field of `limits`:
// the value of the field becomes the lower of the old value and the ceiling (a field of 0 had no bound). No ceiling loosens a bound.
// Then ch_query_settings takes the lower value again with the settings profile of the ClickHouse user. A field with a ceiling
// gets the overflow mode "throw" when the field of the mode is empty, so a run fails with a clear error and no cut result is silent. A row
// or byte ceiling that sets the bound also replaces the mode "break" of a route with "throw": the route answers a refusal that names the
// ceiling (ChCeilingRefusal), never a cut answer.
void apply_ceilings(const AccessCeilings& ceilings, ChQueryLimits& limits);

// The error that a backstop gives. `code` is the code of the error (422 style: query_scan_limit and query_result_limit, 504 style:
// query_timeout). The message names the ceiling and its value.
struct CeilingBreach {
  std::string ceiling;  // max_rows_read ...
  std::string code;
  std::string message;
};

// The text that a backstop throws: "<code>: <message>". query_session.cpp reads the code from this prefix.
inline std::string ceiling_breach_text(const CeilingBreach& breach) { return breach.code + ": " + breach.message; }

// The code of the error that `text` carries (ceiling_breach_text), or an empty text when it is not one of them.
std::string ceiling_breach_code(std::string_view text);

// The backstop of the client for one run or one statement. It counts what ClickHouse reports (the Progress packets give the rows
// and bytes read) and what the client receives (the rows and bytes of the result). It does not look at the settings of ClickHouse:
// a SETTINGS clause or a SET statement in the SQL of the person cannot raise a ceiling, and a profile with readonly = 1 that takes
// no setting still has the backstop. The counters are not thread-safe: the caller holds its own lock.
class CeilingMeter {
 public:
  CeilingMeter() = default;
  CeilingMeter(AccessCeilings ceilings, std::chrono::steady_clock::time_point start) : ceilings_(ceilings), start_(start) {}

  // The new rows and bytes read, as one Progress packet gives them (the packet gives what is new, not a total).
  std::optional<CeilingBreach> on_progress(uint64_t rows, uint64_t bytes) {
    rows_read_ = add(rows_read_, rows);
    bytes_read_ = add(bytes_read_, bytes);
    if (ceilings_.max_rows_read != 0 && rows_read_ > ceilings_.max_rows_read) {
      return keep(breach_of("max_rows_read", "query_scan_limit", "The run read more rows than it may read.", ceilings_.max_rows_read));
    }
    if (ceilings_.max_read_size != 0 && bytes_read_ > ceilings_.max_read_size) {
      return keep(breach_of("max_read_size", "query_scan_limit", "The run read more bytes than it may read.", ceilings_.max_read_size));
    }
    return breach_;
  }
  // The new rows and bytes of the result that the client received.
  std::optional<CeilingBreach> on_result(uint64_t rows, uint64_t bytes) {
    rows_result_ = add(rows_result_, rows);
    bytes_result_ = add(bytes_result_, bytes);
    if (ceilings_.max_rows != 0 && rows_result_ > ceilings_.max_rows) {
      return keep(breach_of("max_rows", "query_result_limit", "The result has more rows than it may have.", ceilings_.max_rows));
    }
    if (ceilings_.max_result_size != 0 && bytes_result_ > ceilings_.max_result_size) {
      return keep(breach_of("max_result_size", "query_result_limit", "The result is larger than it may be.", ceilings_.max_result_size));
    }
    return breach_;
  }
  // The duration from the start. Empty while the run is inside max_duration.
  std::optional<CeilingBreach> on_clock(std::chrono::steady_clock::time_point now) const {
    if (breach_) return breach_;
    if (ceilings_.max_duration == 0 || start_.time_since_epoch().count() == 0) return std::nullopt;
    const auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(now - start_).count();
    // The run is past the ceiling when more than max_duration seconds passed.
    if (elapsed < 0 || static_cast<uint64_t>(elapsed) <= ceilings_.max_duration) return std::nullopt;
    return duration_breach();
  }

  // The breach of max_duration (the ceiling must be set). The deadline thread uses it when the run goes past the duration.
  CeilingBreach duration_breach() const {
    return breach_of("max_duration", "query_timeout", "The run took longer than it may take.", ceilings_.max_duration);
  }
  // The first breach, kept: a run that went past a ceiling stays past it.
  const std::optional<CeilingBreach>& breach() const { return breach_; }
  uint64_t rows_read() const { return rows_read_; }
  uint64_t bytes_read() const { return bytes_read_; }
  uint64_t rows_result() const { return rows_result_; }
  uint64_t bytes_result() const { return bytes_result_; }
  const AccessCeilings& ceilings() const { return ceilings_; }

 private:
  static uint64_t add(uint64_t total, uint64_t more) { return more > UINT64_MAX - total ? UINT64_MAX : total + more; }
  static CeilingBreach breach_of(const char* ceiling, const char* code, const std::string& what, uint64_t value) {
    CeilingBreach out;
    out.ceiling = ceiling;
    out.code = code;
    out.message = what + " The grant of your account sets " + ceiling + " to " + std::to_string(value) + ".";
    return out;
  }
  std::optional<CeilingBreach> keep(std::optional<CeilingBreach> found) {
    if (!breach_ && found) breach_ = std::move(found);
    return breach_;
  }

  AccessCeilings ceilings_;
  std::chrono::steady_clock::time_point start_{};
  uint64_t rows_read_ = 0;
  uint64_t bytes_read_ = 0;
  uint64_t rows_result_ = 0;
  uint64_t bytes_result_ = 0;
  std::optional<CeilingBreach> breach_;
};

// Calls `on_expired` one time when `seconds` have passed since the construction, unless the object ends first. It has its own
// thread, because a run can send no packet for a long time (a statement that sleeps, a lock). With `seconds` = 0 it does nothing.
// The callback is the KILL path of the caller. It runs on the thread of this object: it must not wait for the thread that owns the
// object.
class CeilingDeadline {
 public:
  CeilingDeadline(uint64_t seconds, std::function<void()> on_expired);
  CeilingDeadline(const CeilingDeadline&) = delete;
  CeilingDeadline& operator=(const CeilingDeadline&) = delete;
  ~CeilingDeadline();
  // True after the callback started.
  bool expired() const;

 private:
  void run(uint64_t seconds);

  std::function<void()> on_expired_;
  mutable std::mutex mu_;
  std::condition_variable cv_;
  bool stop_ = false;
  bool expired_ = false;
  std::thread thread_;
};

}  // namespace chdash
