#include "ch_query.hpp"

#include <clickhouse/columns/string.h>
#include <clickhouse/exceptions.h>

#include <algorithm>
#include <cstdlib>
#include <mutex>
#include <optional>
#include <string_view>
#include <system_error>
#include <unordered_map>

namespace chdash {

namespace {

constexpr auto kCancelCheckInterval = std::chrono::milliseconds(200);

thread_local ChQueryScope* t_scope = nullptr;

// ChDash stores what it knows of each connection that it opened (ch_open_client). The code never destroys these records.
// A connection that outlives the static objects at exit still finds its record.
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

// A copy of the state of `client`. It is nullopt for a client that ch_open_client did not open.
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

// Returns true when the limits send a setting. Only then does the code read the profile of the connection.
bool wants_settings(const ChQueryLimits& limits) {
  return !limits.log_comment.empty() || limits.deadline != std::chrono::steady_clock::time_point{} ||
         limits.max_execution_time_s > 0 || limits.max_memory_usage > 0 || limits.max_rows_to_read > 0 ||
         limits.max_result_rows > 0 || limits.max_result_bytes > 0 || limits.read_only || limits.read_only_strict;
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
  // If the scope has on_statement, the callback receives the record of the statement after its end or its error.
  void run(const clickhouse::Query& query) {
    const ChQueryLimits* limits = ChQueryScope::current();
    if (!limits || !limits->on_statement) {
      run_statement(query);
      return;
    }
    const std::function<void(const ChStatementRecord&)> observer = limits->on_statement;
    ChStatementRecord record;
    record.operation = ch_statement_operation(query.GetText());
    record.query_id = query.GetQueryID();
    record.started = std::chrono::system_clock::now();
    const auto finish = [&] {
      record.ended = std::chrono::system_clock::now();
      if (const auto& endpoint = client_.GetCurrentEndpoint(); endpoint) {
        record.server_address = endpoint->host;
        record.server_port = endpoint->port;
      }
      try {
        observer(record);
      } catch (...) {
        // The trace never changes the result of a statement.
      }
    };
    try {
      run_statement(query);
    } catch (const clickhouse::ServerError& error) {
      record.error_code = error.GetCode();
      record.error_type = std::to_string(error.GetCode());
      finish();
      throw;
    } catch (const ChQueryCanceled&) {
      record.error_type = "canceled";
      finish();
      throw;
    } catch (const std::system_error&) {
      record.error_type = "connection";
      finish();
      throw;
    } catch (...) {
      record.error_type = "client";
      finish();
      throw;
    }
    finish();
  }

  // The statement itself has these inputs: the deadline, the state of the connection and the settings of the scope.
  void run_statement(const clickhouse::Query& query) {
    const ChQueryLimits* limits = ChQueryScope::current();
    ch_check_canceled();
    if (limits && limits->deadline != std::chrono::steady_clock::time_point{} &&
        std::chrono::steady_clock::now() >= limits->deadline) {
      throw_deadline_passed();
    }

    auto state = state_of(client_);
    if (state && state->dirty) {
      // A statement before this one on the same lease ended in an unknown state. A caller caught the error and went on.
      // The code opens a new socket. The packets of the previous statement never reach this statement.
      client_.ResetConnection();
      set_dirty(client_, false);
    }

    // A strict read-only statement (the access of humans, docs/access.md) never runs without readonly = 1.
    // It always gets all the settings of its scope, also on a connection that refused the settings of ChDash before.
    // It never runs without a profile.
    // It never runs in the second attempt below, and it never changes the state of the connection.
    const bool strict = limits && limits->read_only_strict;
    bool profile_read_only = false;
    std::vector<std::pair<std::string, std::string>> settings;
    if (limits && state && (strict || (!state->settings_refused && wants_settings(*limits)))) {
      if (!state->probed) {
        probe();
        state = state_of(client_);
      }
      if (state) {
        profile_read_only = state->profile.known && state->profile.readonly == 1;
        if (strict || !state->settings_refused) settings = ch_query_settings(*limits, state->profile, std::chrono::steady_clock::now());
      }
    }
    if (strict && !profile_read_only &&
        std::none_of(settings.begin(), settings.end(), [](const auto& setting) { return setting.first == "readonly"; })) {
      settings.emplace_back("readonly", "1");
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
      // READONLY (164) or SETTING_CONSTRAINT_VIOLATION (452) can refer to a setting that ChDash added. A profile can have constraints that getSetting does not show.
      // In this case the statement did not start. Run it once more without those settings.
      // Never send those settings again on this connection.
      // "Cannot modify 'x' setting in readonly mode" names the setting.
      //
      // "Cannot execute query in readonly mode" means that the statement itself is refused (readonly = 2 and a write). It must stay an error.
      //
      // A strict statement fails closed. The error can come from a SETTINGS clause of the statement itself, which names a setting
      // that ChDash also sent. Such an error must not remove the bounds of the later statements of the connection, which other
      // subjects can lease.
      if (strict) throw;
      if (!is_setting_refusal(error.GetCode(), error.what(), sent)) throw;
      update_state(client_, [](ConnectionState& value) { value.settings_refused = true; });
      execute(query);
    }
  }

 // The profile of the connection. The probe reads it the first time.
  ChSettingsProfile profile() {
    auto state = state_of(client_);
    if (!state) return ChSettingsProfile{};
    if (!state->probed) {
      probe();
      state = state_of(client_);
    }
    return state ? state->profile : ChSettingsProfile{};
  }

 private:
  // "Cannot modify 'x' setting in readonly mode" (164) or "Setting x shouldn't be greater than ..." (452) refers to a setting that ChDash sent.
  // The words "readonly mode" in the first message do not name a readonly setting.
  // A SET of the statement itself, in a read-only run, causes this error.
  // This error belongs to the statement. It is not a refusal of the settings of ChDash.
  static bool is_setting_refusal(int code, std::string_view message, const std::vector<std::string>& names) {
    if (code == 164 && message.find("Cannot modify") == std::string_view::npos) return false;
    if (code != 164 && code != 452) return false;
    for (const auto& name : names) {
      if (message.find("'" + name + "'") != std::string_view::npos || message.find("Setting " + name + " ") != std::string_view::npos) return true;
    }
    return false;
  }

  // The statement follows the rule of point 1. The connection is marked before the statement is sent.
  // The connection is clean again only when ClickHouse ends the statement.
  // This happens at the end of the stream, or with an exception packet of the server.
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

  // The settings profile of the user defines what is allowed (read once per connection). The probe carries the same label as the reads of ChDash.
  // So System > Queries leaves it out. A readonly = 1 user refuses the label (READONLY), which shows what the probe does.
  // An old server without getSetting answers another error. The profile stays unknown.
  //
  // No setting is sent.
  void probe() {
    ChSettingsProfile profile;
    // The label is never named for the caller. The probe runs once for the connection, whoever asks first.
    const std::string sql =
        "SELECT toString(getSetting('readonly')), toString(getSetting('max_execution_time')), "
        "toString(getSetting('max_memory_usage')), toString(getSetting('max_rows_to_read')), "
        "toString(getSetting('max_result_rows')), toString(getSetting('max_result_bytes'))";
    clickhouse::Query query(sql, std::string());
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
    // A server that refuses the label also drops the connection. The next statement then fails with "closed".
    // The connection is marked. The statement that follows opens a new socket first (point 1 of ch_query.hpp).
    bool refused = false;
    try {
      execute(query);
    } catch (const clickhouse::ServerError& error) {
      profile = ChSettingsProfile{};
      if (error.GetCode() == 164) {
        profile.known = true;
        profile.readonly = 1;
        refused = true;
      }
    }
    update_state(client_, [&profile, refused](ConnectionState& value) {
      value.probed = true;
      value.profile = profile;
      if (refused) value.dirty = true;
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

std::string ch_statement_query_id() {
  const ChQueryLimits* limits = ChQueryScope::current();
  return limits && limits->query_id ? limits->query_id() : std::string();
}

std::string ch_statement_operation(std::string_view sql) {
  size_t i = 0;
  while (i < sql.size()) {
    const char c = sql[i];
    if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '(') {
      ++i;
    } else if (sql.compare(i, 2, "--") == 0 || c == '#') {
      const size_t end = sql.find('\n', i);
      i = end == std::string_view::npos ? sql.size() : end + 1;
    } else if (sql.compare(i, 2, "/*") == 0) {
      const size_t end = sql.find("*/", i + 2);
      i = end == std::string_view::npos ? sql.size() : end + 2;
    } else {
      break;
    }
  }
  std::string word;
  while (i < sql.size() && word.size() < 16) {
    const char c = sql[i];
    if (c >= 'a' && c <= 'z') word.push_back(static_cast<char>(c - 'a' + 'A'));
    else if (c >= 'A' && c <= 'Z') word.push_back(c);
    else break;
    ++i;
  }
  if (word == "WITH") return "SELECT";
  if (word == "DESC") return "DESCRIBE";
  static const char* const known[] = {"SELECT", "SHOW", "DESCRIBE", "EXPLAIN", "EXISTS", "INSERT", "CREATE", "ALTER", "DROP", "KILL",
                                      "SYSTEM", "OPTIMIZE", "TRUNCATE", "RENAME", "SET", "USE", "CHECK", "GRANT", "REVOKE", "DELETE", "UPDATE"};
  for (const char* name : known) {
    if (word == name) return word;
  }
  return std::string();
}

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
  ch_select(client, sql, ChParams{}, on_block);
}

void ch_select(clickhouse::Client& client, const std::string& sql, const ChParams& params,
               const std::function<void(const clickhouse::Block&)>& on_block) {
  clickhouse::Query query(sql, ch_statement_query_id());
  for (const auto& [name, value] : params) query.SetParam(name, value);
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
  clickhouse::Query query(sql, ch_statement_query_id());
  query.OnDataCancelable([&on_block, &stopped](const clickhouse::Block& block) {
    // The callback returns false once. clickhouse-cpp sends one Cancel packet and reads the stream to its end.
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
    // Some servers end a canceled stream with QUERY_WAS_CANCELLED (394) or QUERY_WAS_CANCELLED_BY_CLIENT (735).
    // They send this instead of the normal end of the stream. The rows that the callback kept are the answer.
    // The exception is the last packet.
    if (!(stopped && (error.GetCode() == 394 || error.GetCode() == 735))) throw;
  }
}

void ch_execute(clickhouse::Client& client, const std::string& sql) {
  clickhouse::Query query(sql, ch_statement_query_id());
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
  // readonly = 1 refuses any change. An unknown profile can be stricter than what ChDash sends.
  // A strict read-only statement still sends readonly = 1. A server that refuses it fails the statement. This is the safe side.
  if (profile.known && profile.readonly == 1) return out;
  if (!profile.known) {
    if (limits.read_only_strict) out.emplace_back("readonly", "1");
    return out;
  }

  if (!limits.log_comment.empty()) out.emplace_back("log_comment", limits.log_comment);
  if (limits.read_only_strict) out.emplace_back("readonly", "1");
  else if (limits.read_only && profile.readonly == 0) out.emplace_back("readonly", "2");

  // The smaller of the bounds that are set. 0 means none.
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

ChSettingsProfile ch_connection_profile(clickhouse::Client& client) { return Runner(client).profile(); }

ChMcpSettings ch_mcp_settings(const ChMcpLimits& limits, const ChSettingsProfile& profile) {
  ChMcpSettings out;
  out.max_rows = limits.max_rows;
  out.max_bytes = limits.max_bytes;
  // The smaller of the rows and the bytes, from the guard rails and the profile.
  if (profile.known && profile.max_result_rows > 0 && profile.max_result_rows <= static_cast<uint64_t>(std::max<int64_t>(0, limits.max_rows))) {
    out.max_rows = static_cast<int64_t>(profile.max_result_rows);
    out.rows_cut_by_profile = true;
  }
  if (profile.known && profile.max_result_bytes > 0 && profile.max_result_bytes <= static_cast<uint64_t>(std::max<int64_t>(0, limits.max_bytes))) {
    out.max_bytes = static_cast<int64_t>(profile.max_result_bytes);
    out.bytes_cut_by_profile = true;
  }
  // readonly = 1 in the profile: ClickHouse refuses every setting of the statement.
  if (profile.known && profile.readonly == 1) return out;

  const auto add = [&out](const char* name, std::string value) { out.settings.emplace_back(name, std::move(value)); };
  // A guard rail is removed when the profile has no value, or a larger value.
  // The profile is never contradicted. A request never raises the guard rail.
  const auto lowers = [&profile](uint64_t ours, uint64_t theirs) { return !profile.known || theirs == 0 || ours < theirs; };

  if (!profile.known || profile.readonly == 0) add("readonly", "1");
  if (limits.timeout_seconds > 0 && (!profile.known || profile.max_execution_time <= 0 || static_cast<double>(limits.timeout_seconds) < profile.max_execution_time)) {
    add("max_execution_time", std::to_string(limits.timeout_seconds));
  }
  // The code reads one row more than the guard rail. A result that fills the guard rail then shows whether it was cut.
  const uint64_t rows = static_cast<uint64_t>(std::max<int64_t>(0, limits.max_rows)) + 1;
  if (lowers(rows, profile.max_result_rows)) add("max_result_rows", std::to_string(rows));
  add("result_overflow_mode", "break");
  if (limits.max_bytes > 0 && lowers(static_cast<uint64_t>(limits.max_bytes), profile.max_result_bytes)) {
    add("max_result_bytes", std::to_string(limits.max_bytes));
  }
  if (limits.max_memory_bytes > 0 && lowers(static_cast<uint64_t>(limits.max_memory_bytes), profile.max_memory_usage)) {
    add("max_memory_usage", std::to_string(limits.max_memory_bytes));
  }
  add("max_query_size", std::to_string(std::max<int64_t>(262144, limits.sql_bytes + 1024)));
  if (limits.max_rows_to_read > 0 && lowers(static_cast<uint64_t>(limits.max_rows_to_read), profile.max_rows_to_read)) {
    add("max_rows_to_read", std::to_string(limits.max_rows_to_read));
  }
  if (!limits.log_comment.empty()) add("log_comment", limits.log_comment);
  return out;
}

}  // namespace chdash
