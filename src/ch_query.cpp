#include "ch_query.hpp"

#include <clickhouse/columns/string.h>
#include <clickhouse/exceptions.h>

#include <algorithm>
#include <cstdlib>
#include <mutex>
#include <optional>
#include <string_view>
#include <unordered_map>

namespace chdash {

namespace {

constexpr auto kCancelCheckInterval = std::chrono::milliseconds(200);

thread_local ChQueryScope* t_scope = nullptr;

// What ChDash knows of each connection it opened (ch_open_client): never destroyed, so a connection that
// outlives the static objects at exit still finds it.
struct ConnectionState {
  bool dirty = false;
  bool probed = false;
  bool settings_refused = false;  // ClickHouse refused a setting once: the connection sends none again
  ChSettingsProfile profile;
};

struct ConnectionBook {
  std::mutex mu;
  std::unordered_map<const clickhouse::Client*, ConnectionState> states;
};

ConnectionBook& book() {
  static auto* value = new ConnectionBook();
  return *value;
}

// A copy of the state of `client`; nullopt for a client that ch_open_client did not open.
std::optional<ConnectionState> state_of(const clickhouse::Client& client) {
  auto& b = book();
  std::lock_guard<std::mutex> lock(b.mu);
  const auto it = b.states.find(&client);
  if (it == b.states.end()) return std::nullopt;
  return it->second;
}

template <typename Fn>
void update_state(const clickhouse::Client& client, Fn&& fn) noexcept {
  auto& b = book();
  std::lock_guard<std::mutex> lock(b.mu);
  const auto it = b.states.find(&client);
  if (it != b.states.end()) fn(it->second);
}

void set_dirty(const clickhouse::Client& client, bool dirty) noexcept {
  update_state(client, [dirty](ConnectionState& state) { state.dirty = dirty; });
}

uint64_t parse_u64(std::string_view text) {
  uint64_t value = 0;
  for (const char ch : text) {
    if (ch < '0' || ch > '9') break;
    const uint64_t digit = static_cast<uint64_t>(ch - '0');
    if (value > (UINT64_MAX - digit) / 10) return UINT64_MAX;
    value = value * 10 + digit;
  }
  return value;
}

// True when the limits would send a setting: only then is the profile of the connection read.
bool wants_settings(const ChQueryLimits& limits) {
  return !limits.log_comment.empty() || limits.deadline != std::chrono::steady_clock::time_point{} ||
         limits.max_execution_time_s > 0 || limits.max_memory_usage > 0 || limits.max_rows_to_read > 0 ||
         limits.max_result_rows > 0 || limits.max_result_bytes > 0 || limits.read_only;
}

[[noreturn]] void throw_deadline_passed() {
  auto error = std::make_shared<clickhouse::Exception>();
  error->code = 159;
  error->name = "TIMEOUT_EXCEEDED";
  error->display_text =
      "Timeout exceeded: the time of the request ran out before this query started. (TIMEOUT_EXCEEDED)";
  throw clickhouse::ServerError(error);
}

// One statement on one connection: points 1 and 2 of ch_query.hpp.
class Runner {
 public:
  explicit Runner(clickhouse::Client& client) : client_(client) {}

  // Runs `query` (with the settings of the scope) under the rules of point 1 of ch_query.hpp.
  void run(const clickhouse::Query& query) {
    const ChQueryLimits* limits = ChQueryScope::current();
    ch_check_canceled();
    if (limits && limits->deadline != std::chrono::steady_clock::time_point{} &&
        std::chrono::steady_clock::now() >= limits->deadline) {
      throw_deadline_passed();
    }

    auto state = state_of(client_);
    if (state && state->dirty) {
      // A statement before this one on the same lease ended in an unknown state (a caller that caught the
      // error and goes on): a new socket, never the packets of the previous statement.
      client_.ResetConnection();
      set_dirty(client_, false);
    }

    std::vector<std::pair<std::string, std::string>> settings;
    if (limits && state && !state->settings_refused && wants_settings(*limits)) {
      if (!state->probed) {
        probe();
        state = state_of(client_);
      }
      if (state) settings = ch_query_settings(*limits, state->profile, std::chrono::steady_clock::now());
    }

    clickhouse::Query with_settings = query;
    std::vector<std::string> sent;
    for (const auto& [name, value] : settings) {
      if (query.GetQuerySettings().count(name) != 0) continue;  // the caller's own setting stays
      clickhouse::QuerySettingsField field;
      field.value = value;
      with_settings.SetSetting(name, field);
      sent.push_back(name);
    }

    try {
      execute(sent.empty() ? query : with_settings);
    } catch (const clickhouse::ServerError& error) {
      // READONLY (164) or SETTING_CONSTRAINT_VIOLATION (452) about a setting that ChDash added (a profile with
      // constraints that getSetting does not show): the statement did not start. Run it once more without
      // them, and never send them again on this connection.
      // "Cannot modify 'x' setting in readonly mode" names the setting; "Cannot execute query in readonly mode"
      // is the statement itself refused (readonly = 2 and a write), and must stay an error.
      if (!is_setting_refusal(error.GetCode(), error.what(), sent)) throw;
      update_state(client_, [](ConnectionState& value) { value.settings_refused = true; });
      execute(query);
    }
  }

 private:
  static bool is_setting_refusal(int code, std::string_view message, const std::vector<std::string>& names) {
    if (code == 164 && message.find("Cannot modify") == std::string_view::npos) return false;
    if (code != 164 && code != 452) return false;
    for (const auto& name : names) {
      if (message.find("'" + name + "'") != std::string_view::npos || message.find(name + " ") != std::string_view::npos) return true;
    }
    return false;
  }

  // The statement, under the rule of point 1: marked before it is sent, clean again only when ClickHouse
  // ended it (the end of the stream, or an exception packet of the server).
  void execute(const clickhouse::Query& query) {
    set_dirty(client_, true);
    try {
      client_.Execute(query);
    } catch (const clickhouse::ServerError&) {
      set_dirty(client_, false);
      throw;
    }
    set_dirty(client_, false);
  }

  // What the settings profile of the user allows (once per connection). The probe is labelled like the reads
  // of ChDash, so System > Queries leaves it out; a readonly = 1 user refuses the label (READONLY), which says
  // what the probe would. An old server without getSetting answers another error: the profile stays unknown
  // and no setting is sent.
  void probe() {
    ChSettingsProfile profile;
    clickhouse::Query query(
        "SELECT toString(getSetting('readonly')), toString(getSetting('max_execution_time')), "
        "toString(getSetting('max_memory_usage')), toString(getSetting('max_rows_to_read')), "
        "toString(getSetting('max_result_rows')), toString(getSetting('max_result_bytes'))");
    clickhouse::QuerySettingsField label;
    label.value = "chdash:probe";
    query.SetSetting("log_comment", label);
    query.OnData([&profile](const clickhouse::Block& block) {
      if (block.GetRowCount() == 0 || block.GetColumnCount() < 6) return;
      const auto text = [&block](size_t column) -> std::string {
        const auto values = block[column]->As<clickhouse::ColumnString>();
        return values ? std::string(values->At(0)) : std::string();
      };
      profile.readonly = parse_u64(text(0));
      profile.max_execution_time = std::max(0.0, std::strtod(text(1).c_str(), nullptr));
      profile.max_memory_usage = parse_u64(text(2));
      profile.max_rows_to_read = parse_u64(text(3));
      profile.max_result_rows = parse_u64(text(4));
      profile.max_result_bytes = parse_u64(text(5));
      profile.known = true;
    });
    try {
      execute(query);
    } catch (const clickhouse::ServerError& error) {
      profile = ChSettingsProfile{};
      if (error.GetCode() == 164) {
        profile.known = true;
        profile.readonly = 1;
      }
    }
    update_state(client_, [&profile](ConnectionState& value) {
      value.probed = true;
      value.profile = profile;
    });
  }

  clickhouse::Client& client_;
};

}  // namespace

ChQueryScope::ChQueryScope(ChQueryLimits limits) : limits_(std::move(limits)), previous_(t_scope) {
  t_scope = this;
}

ChQueryScope::~ChQueryScope() { t_scope = previous_; }

const ChQueryLimits* ChQueryScope::current() { return t_scope ? &t_scope->limits_ : nullptr; }

ChQueryLimits ChQueryScope::current_copy() { return t_scope ? t_scope->limits_ : ChQueryLimits{}; }

void ch_check_canceled() {
  ChQueryScope* scope = t_scope;
  if (!scope || !scope->limits_.canceled) return;
  if (!scope->canceled_) {
    const auto now = std::chrono::steady_clock::now();
    if (scope->last_check_ != std::chrono::steady_clock::time_point{} && now - scope->last_check_ < kCancelCheckInterval) {
      return;
    }
    scope->last_check_ = now;
    scope->canceled_ = scope->limits_.canceled();
  }
  if (scope->canceled_) throw ChQueryCanceled();
}

void ch_select(clickhouse::Client& client, const std::string& sql,
               const std::function<void(const clickhouse::Block&)>& on_block) {
  clickhouse::Query query(sql);
  query.OnData([&on_block](const clickhouse::Block& block) {
    ch_check_canceled();
    on_block(block);
  });
  query.OnProgress([](const clickhouse::Progress&) { ch_check_canceled(); });
  Runner(client).run(query);
}

void ch_select_cancelable(clickhouse::Client& client, const std::string& sql,
                          const std::function<bool(const clickhouse::Block&)>& on_block) {
  bool stopped = false;
  clickhouse::Query query(sql);
  query.OnDataCancelable([&on_block, &stopped](const clickhouse::Block& block) {
    // false once: clickhouse-cpp sends one Cancel packet and reads the stream to its end.
    if (stopped) return true;
    ch_check_canceled();
    if (!on_block(block)) stopped = true;
    return !stopped;
  });
  query.OnProgress([&stopped](const clickhouse::Progress&) {
    if (!stopped) ch_check_canceled();
  });
  try {
    Runner(client).run(query);
  } catch (const clickhouse::ServerError& error) {
    // Some servers end a canceled stream with QUERY_WAS_CANCELLED (394) or QUERY_WAS_CANCELLED_BY_CLIENT
    // (735) instead of its end: the rows that the callback kept are the answer, and the exception was the
    // last packet.
    if (!(stopped && (error.GetCode() == 394 || error.GetCode() == 735))) throw;
  }
}

void ch_execute(clickhouse::Client& client, const std::string& sql) {
  clickhouse::Query query(sql);
  query.OnProgress([](const clickhouse::Progress&) { ch_check_canceled(); });
  Runner(client).run(query);
}

void ch_execute(clickhouse::Client& client, const clickhouse::Query& query) { Runner(client).run(query); }

void ChClientDeleter::operator()(clickhouse::Client* client) const noexcept {
  if (!client) return;
  {
    auto& b = book();
    std::lock_guard<std::mutex> lock(b.mu);
    b.states.erase(client);
  }
  delete client;
}

ChClientPtr ch_open_client(const clickhouse::ClientOptions& options) {
  ChClientPtr client(new clickhouse::Client(options));
  auto& b = book();
  std::lock_guard<std::mutex> lock(b.mu);
  b.states[client.get()] = ConnectionState{};
  return client;
}

bool ch_connection_dirty(const clickhouse::Client& client) noexcept {
  auto& b = book();
  std::lock_guard<std::mutex> lock(b.mu);
  const auto it = b.states.find(&client);
  return it != b.states.end() && it->second.dirty;
}

void ch_mark_dirty(const clickhouse::Client& client) noexcept { set_dirty(client, true); }

std::vector<std::pair<std::string, std::string>> ch_query_settings(
    const ChQueryLimits& limits, const ChSettingsProfile& profile, std::chrono::steady_clock::time_point now) {
  std::vector<std::pair<std::string, std::string>> out;
  // readonly = 1 refuses any change; an unknown profile could be stricter than what ChDash would send.
  if (!profile.known || profile.readonly == 1) return out;

  if (!limits.log_comment.empty()) out.emplace_back("log_comment", limits.log_comment);
  if (limits.read_only && profile.readonly == 0) out.emplace_back("readonly", "2");

  // The smaller of the bounds that are set; 0 = none.
  const auto tighter = [](uint64_t a, uint64_t b) -> uint64_t {
    if (a == 0) return b;
    if (b == 0) return a;
    return std::min(a, b);
  };

  uint64_t seconds = limits.max_execution_time_s > 0 ? static_cast<uint64_t>(limits.max_execution_time_s) : 0;
  if (limits.deadline != std::chrono::steady_clock::time_point{}) {
    const auto left_ms = std::chrono::duration_cast<std::chrono::milliseconds>(limits.deadline - now).count();
    seconds = tighter(seconds, static_cast<uint64_t>(std::max<int64_t>(1, (left_ms + 999) / 1000)));
  }
  if (seconds > 0) {
    const double profile_seconds = profile.max_execution_time;
    if (profile_seconds <= 0 || static_cast<double>(seconds) < profile_seconds) {
      out.emplace_back("max_execution_time", std::to_string(seconds));
      if (!limits.timeout_overflow_mode.empty()) out.emplace_back("timeout_overflow_mode", limits.timeout_overflow_mode);
    }
  }

  const uint64_t memory = tighter(limits.max_memory_usage, profile.max_memory_usage);
  if (limits.max_memory_usage > 0 && memory != profile.max_memory_usage) {
    out.emplace_back("max_memory_usage", std::to_string(memory));
  }

  const uint64_t rows = tighter(limits.max_rows_to_read, profile.max_rows_to_read);
  if (limits.max_rows_to_read > 0 && rows != profile.max_rows_to_read) {
    out.emplace_back("max_rows_to_read", std::to_string(rows));
    if (!limits.read_overflow_mode.empty()) out.emplace_back("read_overflow_mode", limits.read_overflow_mode);
  }

  bool result_cap = false;
  const uint64_t result_rows = tighter(limits.max_result_rows, profile.max_result_rows);
  if (limits.max_result_rows > 0 && result_rows != profile.max_result_rows) {
    out.emplace_back("max_result_rows", std::to_string(result_rows));
    result_cap = true;
  }
  const uint64_t result_bytes = tighter(limits.max_result_bytes, profile.max_result_bytes);
  if (limits.max_result_bytes > 0 && result_bytes != profile.max_result_bytes) {
    out.emplace_back("max_result_bytes", std::to_string(result_bytes));
    result_cap = true;
  }
  if (result_cap && !limits.result_overflow_mode.empty()) out.emplace_back("result_overflow_mode", limits.result_overflow_mode);
  return out;
}

}  // namespace chdash
