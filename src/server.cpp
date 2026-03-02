#include "server.hpp"
#include "ch_uri.hpp"
#include "serve_embedded_static.hpp"

#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <clickhouse/columns/string.h>
#include <clickhouse/block.h>

#include <algorithm>
#include <chrono>
#include <ctime>
#include <deque>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <optional>
#include <random>
#include <sstream>
#include <thread>

namespace chdash {

namespace {

static std::string gen_query_id() {
  static thread_local std::mt19937_64 rng{std::random_device{}()};
  auto hex = [](uint64_t x, int n) {
    std::ostringstream oss;
    oss << std::hex;
    oss.width(n);
    oss.fill('0');
    if (n >= 16) oss << x;
    else oss << (x & ((1ull << (4 * n)) - 1));
    return oss.str();
  };
  uint64_t a = rng();
  uint64_t b = rng();
  return hex(a, 8) + "-" + hex(a >> 32, 4) + "-" + hex(a >> 48, 4) + "-" + hex(b, 4) + "-" + hex(b >> 16, 12);
}

static int64_t now_ms() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

static std::vector<std::string> split_csv(std::string_view s) {
  auto trim_local = [](std::string_view in) -> std::string_view {
    size_t a = 0;
    while (a < in.size() && (in[a] == ' ' || in[a] == '\t' || in[a] == '\r' || in[a] == '\n')) ++a;
    size_t b = in.size();
    while (b > a && (in[b - 1] == ' ' || in[b - 1] == '\t' || in[b - 1] == '\r' || in[b - 1] == '\n')) --b;
    return in.substr(a, b - a);
  };

  std::vector<std::string> out;
  size_t i = 0;
  while (i < s.size()) {
    while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == ',')) ++i;
    if (i >= s.size()) break;
    size_t j = i;
    while (j < s.size() && s[j] != ',') ++j;
    std::string v = std::string(trim_local(s.substr(i, j - i)));
    if (!v.empty()) out.push_back(std::move(v));
    i = j + 1;
  }
  out.erase(std::unique(out.begin(), out.end()), out.end());
  return out;
}

static int64_t now_unix_sec() {
  using namespace std::chrono;
  return duration_cast<seconds>(system_clock::now().time_since_epoch()).count();
}

static std::vector<uint8_t> random_bytes(size_t n) {
  std::vector<uint8_t> out(n);
  std::random_device rd;
  for (size_t i = 0; i < n; ++i) out[i] = static_cast<uint8_t>(rd() & 0xFF);
  return out;
}

static std::string build_hosts_json(const HostsSnapshot& snap) {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("ts_ms"); w.Int64(snap.ts_ms);
  w.Key("interval_ms"); w.Int(snap.interval_ms);
  w.Key("timeout_ms"); w.Int(snap.timeout_ms);
  w.Key("hosts");
  w.StartArray();
  for (const auto& h : snap.hosts) {
    w.StartObject();
    w.Key("id"); w.String(h.id.c_str());
    w.Key("label"); w.String(h.label.c_str());
    w.Key("healthy"); w.Bool(h.healthy);
    w.Key("checked_at_ms"); w.Int64(h.checked_at_ms);
    w.Key("ping_ms");
    if (h.ping_ms >= 0) w.Int64(h.ping_ms); else w.Null();
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();
  return sb.GetString();
}

static bool try_serve_fs(const std::string& static_dir, const httplib::Request& req, httplib::Response& res) {
  std::string path = req.path;
  if (path.empty() || path == "/") path = "/index.html";

  std::string rel;
  if (path.rfind("/static/", 0) == 0) rel = path.substr(std::string("/static/").size());
  else if (!path.empty() && path[0] == '/') rel = path.substr(1);
  else rel = path;

  if (rel.find("..") != std::string::npos) return false;
  if (rel.find('\\') != std::string::npos) return false;

  std::filesystem::path full = std::filesystem::path(static_dir) / rel;
  std::error_code ec;
  if (!std::filesystem::is_regular_file(full, ec)) return false;

  std::ifstream in(full, std::ios::binary);
  if (!in) return false;
  std::string body((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  res.set_header("Cache-Control", "no-cache");
  res.set_content(std::move(body), mime_from_path(rel));
  return true;
}

static void json_error(httplib::Response& res, int status, const std::string& code, const std::string& message) {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("error_code"); w.String(code.c_str(), (rapidjson::SizeType)code.size());
  w.Key("message"); w.String(message.c_str(), (rapidjson::SizeType)message.size());
  w.EndObject();
  res.status = status;
  res.set_header("Content-Type", "application/json");
  res.set_content(sb.GetString(), "application/json");
}

static bool parse_json_body(const httplib::Request& req, rapidjson::Document& doc) {
  doc.Parse(req.body.c_str());
  return !doc.HasParseError() && doc.IsObject();
}

static std::string sse_json_event(const std::string& event, const std::string& json) {
  std::ostringstream oss;
  oss << "event: " << event << "\n";
  oss << "data: " << json << "\n\n";
  return oss.str();
}

static std::string build_meta_json(const std::string& qid) {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("query_id"); w.String(qid.c_str());
  w.Key("status"); w.String("connected");
  w.EndObject();
  return sb.GetString();
}

static std::string build_keepalive_json(const std::string& qid) {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("query_id"); w.String(qid.c_str());

  auto t = std::time(nullptr);
  std::tm tm{};
#if defined(_WIN32)
  gmtime_s(&tm, &t);
#else
  gmtime_r(&t, &tm);
#endif
  char buf[64];
  std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tm);

  w.Key("time"); w.String(buf);
  w.EndObject();
  return sb.GetString();
}

struct StreamState {
  std::shared_ptr<QuerySession> session;
  std::string query_id;

  std::chrono::steady_clock::time_point last_publish{};
  std::chrono::steady_clock::time_point last_keepalive{};

  uint64_t prev_read_rows = 0;
  uint64_t prev_read_bytes = 0;

  int64_t prev_cpu_total_us = 0;
  int64_t cpu_inst_max_centi = 0;
  int64_t thread_peak = 0;

  std::deque<std::string> local_chunks;
};

static std::string build_tick_json(const SessionSnapshot& snap, StreamState& st) {
  int64_t percentCenti = 0;
  int64_t knownInt = 0;
  if (snap.total_rows_to_read > 0) {
    knownInt = 1;
    const __int128 num = static_cast<__int128>(snap.read_rows_total) * 10000;
    percentCenti = static_cast<int64_t>(num / static_cast<__int128>(snap.total_rows_to_read));
    if (percentCenti < 0) percentCenti = 0;
    if (percentCenti > 10000) percentCenti = 10000;
  }

  const auto now = std::chrono::steady_clock::now();
  const auto prev_publish = st.last_publish;

  int64_t rowsPerSec = 0;
  int64_t bytesPerSec = 0;

  if (prev_publish.time_since_epoch().count() != 0) {
    const double dt = std::chrono::duration_cast<std::chrono::duration<double>>(now - prev_publish).count();
    if (dt > 1e-9) {
      rowsPerSec = static_cast<int64_t>(double(snap.read_rows_total - st.prev_read_rows) / dt);
      bytesPerSec = static_cast<int64_t>(double(snap.read_bytes_total - st.prev_read_bytes) / dt);
      if (rowsPerSec < 0) rowsPerSec = 0;
      if (bytesPerSec < 0) bytesPerSec = 0;
    }
  }

  st.prev_read_rows = snap.read_rows_total;
  st.prev_read_bytes = snap.read_bytes_total;

  int64_t cpuCenti = 0;
  {
    const int64_t cpu_total_us = snap.user_time_us_total + snap.system_time_us_total;
    if (prev_publish.time_since_epoch().count() != 0) {
      const auto dt_us = std::chrono::duration_cast<std::chrono::microseconds>(now - prev_publish).count();
      const int64_t d_cpu = cpu_total_us - st.prev_cpu_total_us;
      if (dt_us > 0 && d_cpu >= 0) {
        cpuCenti = static_cast<int64_t>((__int128)d_cpu * 10000 / dt_us);
      }
    }
    st.prev_cpu_total_us = cpu_total_us;
    if (cpuCenti > st.cpu_inst_max_centi) st.cpu_inst_max_centi = cpuCenti;
  }

  st.last_publish = now;

  const int64_t memInst = snap.current_mem_bytes;
  const int64_t memMax = snap.peak_mem_bytes;

  const int64_t thrInst = snap.threads_inst;
  if (snap.threads_peak > st.thread_peak) st.thread_peak = snap.threads_peak;
  const int64_t thrMax = st.thread_peak;

  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartArray();
  w.Int64(snap.elapsed_ms);
  w.Int64(percentCenti);
  w.Int64(knownInt);
  w.Int64((int64_t)snap.read_rows_total);
  w.Int64((int64_t)snap.read_bytes_total);
  w.Int64((int64_t)snap.total_rows_to_read);
  w.Int64(rowsPerSec);
  w.Int64(bytesPerSec);
  w.Int64(cpuCenti);
  w.Int64(st.cpu_inst_max_centi);
  if (memInst < 0) w.Null(); else w.Int64(memInst);
  if (memMax < 0) w.Null(); else w.Int64(memMax);
  w.Int64(thrInst);
  w.Int64(thrMax);
  auto samples = st.session->drain_samples();
  if (samples.empty()) {
    w.Null();
  } else {
    w.StartArray();
    for (const auto& s : samples) {
      w.StartArray();
      w.Int64(s.elapsed_ms);
      w.Uint64(s.read_bytes_total);
      if (s.cpu_centi < 0) w.Null(); else w.Int64(s.cpu_centi);
      if (s.mem_bytes < 0) w.Null(); else w.Int64(s.mem_bytes);
      w.Int64(s.threads);
      w.EndArray();
    }
    w.EndArray();
  }
  w.EndArray();
  return sb.GetString();
}

static std::string build_done_json(const SessionSnapshot& snap, const std::string& message, bool truncated) {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("query_id"); w.String(snap.query_id.c_str());
  w.Key("status");
  switch (snap.status) {
    case SessionStatus::Finished: w.String("finished"); break;
    case SessionStatus::Canceled: w.String("canceled"); break;
    case SessionStatus::Error: w.String("error"); break;
    case SessionStatus::ResultLimitReached: w.String("result_limit_reached"); break;
    default: w.String("finished"); break;
  }
  w.Key("elapsed_seconds"); w.Double(double(snap.elapsed_ms) / 1000.0);
  w.Key("read_rows"); w.Uint64(snap.read_rows_total);
  w.Key("read_bytes"); w.Uint64(snap.read_bytes_total);
  w.Key("result_rows_returned"); w.Uint64(snap.wrote_rows_total);
  w.Key("result_truncated"); w.Bool(truncated);
  if (!message.empty()) {
    w.Key("message"); w.String(message.c_str());
  }
  w.EndObject();
  return sb.GetString();
}

static const HostSpec* find_host(const std::vector<HostSpec>& hosts, const std::string& id) {
  for (const auto& h : hosts) {
    if (h.id == id) return &h;
  }
  return nullptr;
}

static std::string trim_sql(std::string sql) {
  // trim left
  size_t i = 0;
  while (i < sql.size() && (sql[i] == ' ' || sql[i] == '\n' || sql[i] == '\r' || sql[i] == '\t')) ++i;
  if (i > 0) sql.erase(0, i);
  // trim right + trailing semicolons
  while (!sql.empty()) {
    char c = sql.back();
    if (c == ' ' || c == '\n' || c == '\r' || c == '\t' || c == ';') {
      sql.pop_back();
      continue;
    }
    break;
  }
  return sql;
}

static std::string escape_for_clickhouse_string(std::string_view in) {
  std::string out;
  out.reserve(in.size() + 16);
  for (size_t i = 0; i < in.size(); ++i) {
    char c = in[i];
    if (c == '\r') {
      if (i + 1 < in.size() && in[i + 1] == '\n') {
        ++i;
      }
      out.push_back('\n');
      continue;
    }
    if (c == '\\') {
      out.push_back('\\');
      out.push_back('\\');
      continue;
    }
    if (c == '\'') {
      out.push_back('\\');
      out.push_back('\'');
      continue;
    }
    out.push_back(c);
  }
  return out;
}

static std::optional<std::string> try_format_query(
    const HostSpec& host,
    const std::string& sql,
    size_t max_bytes,
    std::string* err_log
) {
    if (sql.size() > max_bytes) {
        if (err_log) *err_log = "sql too large";
        return std::nullopt;
    }

    const std::string escaped = escape_for_clickhouse_string(sql);
    const std::string fmt_sql =
        "SELECT formatQuery('" + escaped + "') AS query";

    std::string err;
    auto client = make_client_from_uri(
        host.runner_uri,
        std::chrono::seconds(5),
        std::chrono::seconds(5),
        std::chrono::seconds(5),
        &err
    );

    if (!client) {
        if (err_log) *err_log = "make_client failed: " + err;
        return std::nullopt;
    }

    std::optional<std::string> formatted;

    try {
        client->Select(fmt_sql, [&](const clickhouse::Block& b) {

            // Ignore empty blocks (important)
            if (b.GetRowCount() == 0 || b.GetColumnCount() == 0)
                return;

            clickhouse::ColumnRef col = b[0];
            if (!col)
                return;

            // Handle Nullable
            if (auto nullable = col->As<clickhouse::ColumnNullable>()) {
                if (nullable->IsNull(0))
                    return;
                col = nullable->Nested();
            }

            if (auto s = col->As<clickhouse::ColumnString>()) {
                formatted = std::string(s->At(0));
            }
        });

    } catch (const std::exception& e) {
        if (err_log) *err_log = std::string("exception: ") + e.what();
        return std::nullopt;
    }

    if (!formatted) {
        if (err_log) *err_log = "no formatted result returned";
    }

    return formatted;
}

static bool is_ascii_space(char c) {
  return c == ' ' || c == '\n' || c == '\r' || c == '\t';
}

static std::string trim_ascii_spaces(std::string_view in) {
  size_t b = 0;
  while (b < in.size() && is_ascii_space(in[b])) ++b;
  size_t e = in.size();
  while (e > b && is_ascii_space(in[e - 1])) --e;
  return std::string(in.substr(b, e - b));
}

static bool is_ident_char(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_';
}

static std::vector<std::string> split_top_level(std::string_view s, char sep) {
  std::vector<std::string> out;
  size_t last = 0;
  bool in_str = false;
  bool esc = false;
  int par = 0, br = 0, cr = 0;

  auto flush = [&](size_t pos) {
    out.push_back(std::string(s.substr(last, pos - last)));
    last = pos + 1;
  };

  for (size_t i = 0; i < s.size(); ++i) {
    const char c = s[i];
    if (in_str) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c == '\\') {
        esc = true;
        continue;
      }
      if (c == '\'') {
        in_str = false;
      }
      continue;
    }

    if (c == '\'') {
      in_str = true;
      esc = false;
      continue;
    }

    if (c == '(') ++par;
    else if (c == ')' && par > 0) --par;
    else if (c == '[') ++br;
    else if (c == ']' && br > 0) --br;
    else if (c == '{') ++cr;
    else if (c == '}' && cr > 0) --cr;

    if (c == sep && par == 0 && br == 0 && cr == 0) {
      flush(i);
    }
  }

  out.push_back(std::string(s.substr(last)));
  return out;
}

static bool contains_token_outside_strings(std::string_view s, std::string_view tok) {
  bool in_str = false;
  bool esc = false;
  for (size_t i = 0; i < s.size(); ++i) {
    const char c = s[i];
    if (in_str) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c == '\\') {
        esc = true;
        continue;
      }
      if (c == '\'') in_str = false;
      continue;
    }
    if (c == '\'') {
      in_str = true;
      esc = false;
      continue;
    }
    if (i + tok.size() <= s.size() && s.substr(i, tok.size()) == tok) return true;
  }
  return false;
}

static std::string pretty_array_arg(std::string_view arr_expr, const std::string& base_indent) {
  // Only rewrite when it clearly looks like a "complex" array (outer arrays of tuples, etc.).
  // Simple arrays like ['a','b'] are intentionally kept inline.
  std::string t = trim_ascii_spaces(arr_expr);
  if (t.size() < 2 || t.front() != '[' || t.back() != ']') return t;

  // Heuristic: array contains tuple(...) outside strings.
  const bool has_tuple =
      contains_token_outside_strings(t, "tuple(") || contains_token_outside_strings(t, "Tuple(");
  if (!has_tuple) return t;

  const std::string_view inner(t.data() + 1, t.size() - 2);
  auto items = split_top_level(inner, ',');
  if (items.size() <= 1) return t;

  const std::string item_indent = base_indent + "    ";
  std::ostringstream oss;
  oss << base_indent << "[\n";
  for (size_t i = 0; i < items.size(); ++i) {
    std::string it = trim_ascii_spaces(items[i]);
    oss << item_indent << it;
    if (i + 1 < items.size()) oss << ",";
    oss << "\n";
  }
  oss << base_indent << "]";
  return oss.str();
}

static size_t find_from_keyword_top_level(const std::string& s) {
  // Find " FROM " at top-level (not inside (), [] or strings).
  const std::string needle = " FROM ";
  bool in_str = false;
  bool esc = false;
  int par = 0, br = 0, cr = 0;
  for (size_t i = 0; i + needle.size() <= s.size(); ++i) {
    const char c = s[i];
    if (in_str) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c == '\\') {
        esc = true;
        continue;
      }
      if (c == '\'') in_str = false;
      continue;
    }
    if (c == '\'') {
      in_str = true;
      esc = false;
      continue;
    }
    if (c == '(') ++par;
    else if (c == ')' && par > 0) --par;
    else if (c == '[') ++br;
    else if (c == ']' && br > 0) --br;
    else if (c == '{') ++cr;
    else if (c == '}' && cr > 0) --cr;

    if (par == 0 && br == 0 && cr == 0 && s.compare(i, needle.size(), needle) == 0) return i;
  }
  return std::string::npos;
}

static bool has_top_level_comma(std::string_view s) {
  bool in_str = false;
  bool esc = false;
  int par = 0, br = 0, cr = 0;
  for (size_t i = 0; i < s.size(); ++i) {
    const char c = s[i];
    if (in_str) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c == '\\') {
        esc = true;
        continue;
      }
      if (c == '\'') in_str = false;
      continue;
    }
    if (c == '\'') {
      in_str = true;
      esc = false;
      continue;
    }
    if (c == '(') ++par;
    else if (c == ')' && par > 0) --par;
    else if (c == '[') ++br;
    else if (c == ']' && br > 0) --br;
    else if (c == '{') ++cr;
    else if (c == '}' && cr > 0) --cr;
    if (c == ',' && par == 0 && br == 0 && cr == 0) return true;
  }
  return false;
}


static size_t find_token_outside_strings(std::string_view s, std::string_view tok) {
  bool in_str = false;
  bool esc = false;
  if (tok.empty()) return std::string::npos;
  for (size_t i = 0; i + tok.size() <= s.size(); ++i) {
    const char c = s[i];
    if (in_str) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c == '\\') {
        esc = true;
        continue;
      }
      if (c == '\'') in_str = false;
      continue;
    }
    if (c == '\'') {
      in_str = true;
      esc = false;
      continue;
    }
    if (s.substr(i, tok.size()) == tok) return i;
  }
  return std::string::npos;
}

static int paren_delta_outside_strings(std::string_view s) {
  bool in_str = false;
  bool esc = false;
  bool in_line_comment = false;
  bool in_block_comment = false;
  int delta = 0;

  for (size_t i = 0; i < s.size(); ++i) {
    const char c = s[i];

    if (in_line_comment) {
      if (c == '\n') in_line_comment = false;
      continue;
    }

    if (in_block_comment) {
      if (c == '*' && i + 1 < s.size() && s[i + 1] == '/') {
        in_block_comment = false;
        ++i;
      }
      continue;
    }

    if (in_str) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c == '\\') {
        esc = true;
        continue;
      }
      if (c == '\'') in_str = false;
      continue;
    }

    if (c == '\'') {
      in_str = true;
      esc = false;
      continue;
    }

    if (c == '-' && i + 1 < s.size() && s[i + 1] == '-') {
      in_line_comment = true;
      ++i;
      continue;
    }

    if (c == '/' && i + 1 < s.size() && s[i + 1] == '*') {
      in_block_comment = true;
      ++i;
      continue;
    }

    if (c == '(') ++delta;
    else if (c == ')') --delta;
  }

  return delta;
}

struct BoolPart {
  std::string op;
  std::string text;
};

static bool is_word_char(char c) {
  return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_' || c == '`';
}

static std::vector<BoolPart> split_bool_ops_top_level(std::string_view s) {
  std::vector<BoolPart> out;
  size_t last = 0;

  bool in_str = false;
  bool esc = false;
  bool in_line_comment = false;
  bool in_block_comment = false;

  int par = 0, br = 0, cr = 0;
  std::string next_op;

  auto flush = [&](size_t pos) {
    BoolPart p;
    p.op = next_op;
    p.text = std::string(s.substr(last, pos - last));
    out.push_back(std::move(p));
    next_op.clear();
  };

  auto skip_ws = [&](size_t& i) {
    while (i < s.size() && is_ascii_space(s[i])) ++i;
  };

  skip_ws(last);

  for (size_t i = last; i < s.size(); ++i) {
    const char c = s[i];

    if (in_line_comment) {
      if (c == '\n') in_line_comment = false;
      continue;
    }

    if (in_block_comment) {
      if (c == '*' && i + 1 < s.size() && s[i + 1] == '/') {
        in_block_comment = false;
        ++i;
      }
      continue;
    }

    if (in_str) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c == '\\') {
        esc = true;
        continue;
      }
      if (c == '\'') in_str = false;
      continue;
    }

    if (c == '\'') {
      in_str = true;
      esc = false;
      continue;
    }

    if (c == '-' && i + 1 < s.size() && s[i + 1] == '-') {
      in_line_comment = true;
      ++i;
      continue;
    }

    if (c == '/' && i + 1 < s.size() && s[i + 1] == '*') {
      in_block_comment = true;
      ++i;
      continue;
    }

    if (c == '(') ++par;
    else if (c == ')' && par > 0) --par;
    else if (c == '[') ++br;
    else if (c == ']' && br > 0) --br;
    else if (c == '{') ++cr;
    else if (c == '}' && cr > 0) --cr;

    if (par != 0 || br != 0 || cr != 0) continue;

    auto match_kw = [&](std::string_view kw) -> bool {
      if (i + kw.size() > s.size()) return false;
      for (size_t k = 0; k < kw.size(); ++k) {
        const char a = s[i + k];
        const char b = kw[k];
        if (a != b && a != char(b + 32)) return false;
      }
      const char prev = (i == 0) ? ' ' : s[i - 1];
      const char next = (i + kw.size() < s.size()) ? s[i + kw.size()] : ' ';
      if (is_word_char(prev) || is_word_char(next)) return false;
      return true;
    };

    if (match_kw("AND")) {
      flush(i);
      next_op = std::string(s.substr(i, 3));
      size_t j = i + 3;
      skip_ws(j);
      last = j;
      i = j ? (j - 1) : i;
      continue;
    }

    if (match_kw("OR")) {
      flush(i);
      next_op = std::string(s.substr(i, 2));
      size_t j = i + 2;
      skip_ws(j);
      last = j;
      i = j ? (j - 1) : i;
      continue;
    }
  }

  BoolPart p;
  p.op = next_op;
  p.text = std::string(s.substr(last));
  out.push_back(std::move(p));
  return out;
}



static bool iequals_ascii(std::string_view a, std::string_view b) {
  if (a.size() != b.size()) return false;
  for (size_t i = 0; i < a.size(); ++i) {
    unsigned char ca = static_cast<unsigned char>(a[i]);
    unsigned char cb = static_cast<unsigned char>(b[i]);
    if (ca >= 'A' && ca <= 'Z') ca = static_cast<unsigned char>(ca + 32);
    if (cb >= 'A' && cb <= 'Z') cb = static_cast<unsigned char>(cb + 32);
    if (ca != cb) return false;
  }
  return true;
}

static bool is_where_terminator(std::string_view t) {
  static const std::string_view kws[] = {
      "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "UNION", "WINDOW", "PREWHERE", "SETTINGS", "FORMAT"};
  for (auto kw : kws) {
    if (t.size() >= kw.size() && t.substr(0, kw.size()) == kw) return true;
  }
  return false;
}


static std::string_view trim_view_ascii_spaces(std::string_view in) {
  size_t b = 0;
  while (b < in.size() && is_ascii_space(in[b])) ++b;
  size_t e = in.size();
  while (e > b && is_ascii_space(in[e - 1])) --e;
  return in.substr(b, e - b);
}



static bool looks_like_query_block(std::string_view s) {
  s = trim_view_ascii_spaces(s);
  static const std::string_view kws[] = {"SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "CREATE", "ALTER", "DROP"};
  for (auto kw : kws) {
    if (s.size() >= kw.size() && iequals_ascii(s.substr(0, kw.size()), kw)) return true;
  }
  return false;
}

static bool peel_one_outer_paren(std::string_view s, std::string_view& inner) {
  s = trim_view_ascii_spaces(s);
  if (s.size() < 2 || s.front() != '(' || s.back() != ')') return false;

  bool in_str = false;
  bool esc = false;
  bool in_line_comment = false;
  bool in_block_comment = false;
  int par = 0;

  for (size_t i = 0; i < s.size(); ++i) {
    const char c = s[i];

    if (in_line_comment) {
      if (c == '\n') in_line_comment = false;
      continue;
    }

    if (in_block_comment) {
      if (c == '*' && i + 1 < s.size() && s[i + 1] == '/') {
        in_block_comment = false;
        ++i;
      }
      continue;
    }

    if (in_str) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c == '\\') {
        esc = true;
        continue;
      }
      if (c == '\'') in_str = false;
      continue;
    }

    if (c == '\'') {
      in_str = true;
      esc = false;
      continue;
    }

    if (c == '-' && i + 1 < s.size() && s[i + 1] == '-') {
      in_line_comment = true;
      ++i;
      continue;
    }

    if (c == '/' && i + 1 < s.size() && s[i + 1] == '*') {
      in_block_comment = true;
      ++i;
      continue;
    }

    if (c == '(') ++par;
    else if (c == ')') {
      --par;
      if (par == 0 && i != s.size() - 1) return false;
    }
  }

  if (par != 0) return false;
  inner = s.substr(1, s.size() - 2);
  return true;
}

static std::string format_bool_expr(std::string_view expr, const std::string& base_indent);

static bool peel_and_has_bool_ops(std::string_view expr, std::string_view& inner) {
  if (!peel_one_outer_paren(expr, inner)) return false;
  const auto parts = split_bool_ops_top_level(inner);
  return parts.size() > 1;
}

static std::string format_bool_chain(std::string_view expr, const std::string& base_indent, std::string_view op) {
  const auto parts = split_bool_ops_top_level(expr);
  if (parts.size() < 2) return {};

  for (size_t i = 1; i < parts.size(); ++i) {
    if (!iequals_ascii(parts[i].op, op)) return {};
  }

  struct Operand {
    std::string_view raw;
    std::string_view inner;
    bool multiline;
  };

  std::vector<Operand> ops;
  ops.reserve(parts.size());
  for (const auto& p : parts) {
    std::string_view inner;
    if (!peel_one_outer_paren(p.text, inner)) return {};
    Operand o;
    o.raw = trim_view_ascii_spaces(p.text);
    o.inner = inner;
    o.multiline = (inner.find('\n') != std::string_view::npos) || (split_bool_ops_top_level(inner).size() > 1);
    ops.push_back(o);
  }

  auto emit_operand = [&](std::string& out, const Operand& o, const std::string& indent) {
    if (!o.multiline) {
      out.append(o.raw);
      return;
    }
    out.push_back('(');
    out.push_back('\n');
    out.append(format_bool_expr(o.inner, indent + "    "));
    out.push_back('\n');
    out.append(indent);
    out.push_back(')');
  };

  std::string out;
  out.reserve(expr.size() + base_indent.size() * parts.size() + 64);

  out.append(base_indent);
  emit_operand(out, ops[0], base_indent);

  for (size_t i = 1; i < ops.size(); ++i) {
    out.push_back('\n');
    out.append(base_indent);
    out.append(parts[i].op);
    out.push_back(' ');
    if (!ops[i].multiline) {
      out.append(ops[i].raw);
      continue;
    }
    emit_operand(out, ops[i], base_indent);
  }

  return out;
}

static std::string format_bool_expr(std::string_view expr, const std::string& base_indent) {
  expr = trim_view_ascii_spaces(expr);
  if (expr.empty()) return base_indent;

  if (auto f = format_bool_chain(expr, base_indent, "OR"); !f.empty()) return f;
  if (auto f = format_bool_chain(expr, base_indent, "AND"); !f.empty()) return f;

  std::string_view inner;
  if (peel_one_outer_paren(expr, inner)) {
    const auto inner_parts = split_bool_ops_top_level(inner);
    if (inner_parts.size() > 1) {
      std::string out;
      out.reserve(base_indent.size() * 4 + expr.size() + 16);
      out.append(base_indent);
      out.push_back('(');
      out.push_back('\n');
      out.append(format_bool_expr(inner, base_indent + "    "));
      out.push_back('\n');
      out.append(base_indent);
      out.push_back(')');
      return out;
    }
  }

  const auto parts = split_bool_ops_top_level(expr);
  if (parts.empty()) {
    std::string out;
    out.reserve(base_indent.size() + expr.size());
    out.append(base_indent);
    out.append(expr);
    return out;
  }

  std::string out;
  out.reserve(base_indent.size() * parts.size() + expr.size() + 64);

  {
    std::string_view inner;
    const std::string_view t0 = trim_view_ascii_spaces(parts[0].text);
    if (peel_and_has_bool_ops(t0, inner)) {
      out.append(base_indent);
      out.push_back('(');
      out.push_back('\n');
      out.append(format_bool_expr(inner, base_indent + "    "));
      out.push_back('\n');
      out.append(base_indent);
      out.push_back(')');
    } else {
      out.append(base_indent);
      out.append(trim_ascii_spaces(parts[0].text));
    }
  }

  for (size_t i = 1; i < parts.size(); ++i) {
    std::string_view inner;
    const std::string_view ti = trim_view_ascii_spaces(parts[i].text);
    if (peel_and_has_bool_ops(ti, inner)) {
      out.push_back('\n');
      out.append(base_indent);
      out.append(parts[i].op);
      out.push_back(' ');
      out.push_back('(');
      out.push_back('\n');
      out.append(format_bool_expr(inner, base_indent + "    "));
      out.push_back('\n');
      out.append(base_indent);
      out.push_back(')');
      continue;
    }
    out.push_back('\n');
    out.append(base_indent);
    out.append(parts[i].op);
    out.push_back(' ');
    out.append(trim_ascii_spaces(parts[i].text));
  }
  return out;
}

static bool is_bool_clause_start(std::string_view t, std::string_view& kw, std::string_view& rest) {
  static const std::string_view kws[] = {"WHERE ", "HAVING ", "PREWHERE "};
  for (auto k : kws) {
    if (t.rfind(k, 0) == 0) {
      kw = k.substr(0, k.size() - 1);
      rest = t.substr(k.size());
      return true;
    }
  }
  return false;
}

static std::string reindent_where_and_join(std::string s) {
  std::string out;
  out.reserve(s.size() + 256);

  bool in_clause = false;
  int clause_depth = 0;
  std::string clause_kw;
  std::string clause_indent;
  std::string clause_expr;

  auto flush_clause = [&]() {
    const std::string_view expr = trim_view_ascii_spaces(std::string_view(clause_expr));
    const auto parts = split_bool_ops_top_level(expr);
    const bool multiline = (expr.find('\n') != std::string_view::npos);

    out.append(clause_indent);
    out.append(clause_kw);
    if (parts.size() <= 1 && !multiline) {
      out.push_back(' ');
      out.append(expr);
      out.push_back('\n');
    } else {
      out.push_back('\n');
      out.append(format_bool_expr(expr, clause_indent + "    "));
      out.push_back('\n');
    }

    in_clause = false;
    clause_depth = 0;
    clause_kw.clear();
    clause_indent.clear();
    clause_expr.clear();
  };

  size_t pos = 0;
  while (pos <= s.size()) {
    const size_t nl = s.find('\n', pos);
    const bool has_nl = (nl != std::string::npos);
    const size_t end = has_nl ? nl : s.size();
    const std::string_view line = std::string_view(s).substr(pos, end - pos);

    size_t ind_len = 0;
    while (ind_len < line.size() && (line[ind_len] == ' ' || line[ind_len] == '\t')) ++ind_len;
    const std::string_view indent = line.substr(0, ind_len);
    const std::string_view trimmed = line.substr(ind_len);

    if (in_clause && clause_depth == 0 && (is_where_terminator(trimmed) || (!trimmed.empty() && trimmed.front() == ')'))) {
      flush_clause();
    }

    if (!in_clause) {
      std::string_view kw, rest;
      if (is_bool_clause_start(trimmed, kw, rest)) {
        in_clause = true;
        clause_depth = 0;
        clause_kw = std::string(kw);
        clause_indent = std::string(indent);
        clause_expr = std::string(rest);
        clause_depth += paren_delta_outside_strings(trimmed);
      } else {
        const size_t join_pos = find_token_outside_strings(trimmed, " JOIN ");
        const size_t on_pos = find_token_outside_strings(trimmed, " ON ");
        if (join_pos != std::string::npos && on_pos != std::string::npos && join_pos < on_pos) {
          std::string left = std::string(trimmed.substr(0, on_pos));
          while (!left.empty() && (left.back() == ' ' || left.back() == '\t')) left.pop_back();
          std::string right = std::string(trimmed.substr(on_pos + 1));
          while (!right.empty() && (right.front() == ' ' || right.front() == '\t')) right.erase(right.begin());

          out.append(indent);
          out.append(left);
          out.push_back('\n');

          std::string_view rtrim = trim_view_ascii_spaces(right);
          if (rtrim.rfind("ON ", 0) == 0) {
            const std::string_view expr = rtrim.substr(3);
            out.append(indent);
            out.append("    ON");
            out.push_back('\n');
            out.append(format_bool_expr(expr, std::string(indent) + "        "));
          } else {
            out.append(indent);
            out.append("    ");
            out.append(right);
          }

          if (has_nl) out.push_back('\n');
          pos = has_nl ? (nl + 1) : (s.size() + 1);
          continue;
        }

        out.append(line);
        if (has_nl) out.push_back('\n');
      }
    } else {
      if (!clause_expr.empty()) clause_expr.push_back('\n');
      clause_expr.append(trimmed);
      clause_depth += paren_delta_outside_strings(trimmed);
    }

    pos = has_nl ? (nl + 1) : (s.size() + 1);
  }

  if (in_clause) flush_clause();

  return out;
}

static std::string cascade_format_line(std::string_view line, size_t threshold) {
  if (line.size() <= threshold) return std::string(line);

  size_t ind_len = 0;
  while (ind_len < line.size() && (line[ind_len] == ' ' || line[ind_len] == '\t')) ++ind_len;
  const std::string base_indent(line.substr(0, ind_len));
  const std::string_view s = line.substr(ind_len);

  bool in_str = false;
  bool esc = false;
  struct Group {
    size_t start;
    size_t commas;
    bool child_break;
  };
  std::vector<Group> st;
  std::vector<char> is_break_start(s.size(), 0);

  for (size_t i = 0; i < s.size(); ++i) {
    const char c = s[i];
    if (in_str) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c == '\\') {
        esc = true;
        continue;
      }
      if (c == '\'') in_str = false;
      continue;
    }
    if (c == '\'') {
      in_str = true;
      esc = false;
      continue;
    }
    if (c == '(') {
      st.push_back(Group{i, 0, false});
      continue;
    }
    if (c == ',' && !st.empty()) {
      st.back().commas++;
      continue;
    }
    if (c == ')' && !st.empty()) {
      const Group g = st.back();
      st.pop_back();
      const size_t span = (i + 1) - g.start;
      const bool brk = (span > threshold) && (g.commas > 0 || g.child_break);
      if (brk) is_break_start[g.start] = 1;
      if (!st.empty()) st.back().child_break = st.back().child_break || brk;
      continue;
    }
  }

  if (!st.empty()) return std::string(line);

  auto is_clause = [&](std::string_view t) -> bool {
    static const std::string_view kws[] = {"SELECT", "FROM", "WHERE", "AND", "OR", "GROUP", "HAVING", "ORDER", "LIMIT",
                                           "INNER", "LEFT", "RIGHT", "FULL", "JOIN", "ON", "WITH"};
    for (auto kw : kws) {
      if (t.size() >= kw.size() && t.substr(0, kw.size()) == kw) return true;
    }
    return false;
  };

  const std::string_view t = trim_ascii_spaces(s);
  if (is_clause(t)) return std::string(line);

  std::string out;
  out.reserve(line.size() + 128);
  out.append(base_indent);

  bool in2 = false;
  bool esc2 = false;
  std::vector<bool> brk_stack;
  int depth = 0;

  for (size_t i = 0; i < s.size(); ++i) {
    const char c = s[i];
    if (in2) {
      out.push_back(c);
      if (esc2) {
        esc2 = false;
      } else if (c == '\\') {
        esc2 = true;
      } else if (c == '\'') {
        in2 = false;
      }
      continue;
    }
    if (c == '\'') {
      in2 = true;
      esc2 = false;
      out.push_back(c);
      continue;
    }

    if (c == '(') {
      const bool brk = is_break_start[i];
      brk_stack.push_back(brk);
      ++depth;
      out.push_back('(');
      if (brk) {
        out.push_back('\n');
        out.append(base_indent);
        out.append(std::string(size_t(depth) * 4, ' '));
        while (i + 1 < s.size() && (s[i + 1] == ' ' || s[i + 1] == '\t')) ++i;
      }
      continue;
    }

    if (c == ',' && !brk_stack.empty() && brk_stack.back()) {
      out.push_back(',');
      out.push_back('\n');
      out.append(base_indent);
      out.append(std::string(size_t(depth) * 4, ' '));
      while (i + 1 < s.size() && (s[i + 1] == ' ' || s[i + 1] == '\t')) ++i;
      continue;
    }

    if (c == ')' && !brk_stack.empty()) {
      const bool brk = brk_stack.back();
      brk_stack.pop_back();
      if (brk) {
        if (!out.empty() && out.back() != '\n') {
          out.push_back('\n');
          out.append(base_indent);
          out.append(std::string(size_t(depth - 1) * 4, ' '));
        }
      }
      out.push_back(')');
      --depth;
      continue;
    }

    out.push_back(c);
  }

  return out;
}

static std::string cascade_select_lists(std::string s, size_t threshold) {
  std::string out;
  out.reserve(s.size() + 256);

  bool in_select = false;

  size_t pos = 0;
  while (pos <= s.size()) {
    const size_t nl = s.find('\n', pos);
    const bool has_nl = (nl != std::string::npos);
    const size_t end = has_nl ? nl : s.size();
    const std::string_view line = std::string_view(s).substr(pos, end - pos);

    size_t ind_len = 0;
    while (ind_len < line.size() && (line[ind_len] == ' ' || line[ind_len] == '\t')) ++ind_len;
    const std::string_view trimmed = line.substr(ind_len);

    if (!in_select && (trimmed == "SELECT" || trimmed.rfind("SELECT ", 0) == 0)) {
      in_select = true;
      out.append(line);
    } else if (in_select && trimmed.rfind("FROM", 0) == 0) {
      in_select = false;
      out.append(line);
    } else if (in_select) {
      out.append(cascade_format_line(line, threshold));
    } else {
      out.append(line);
    }

    if (has_nl) out.push_back('\n');
    pos = has_nl ? (nl + 1) : (s.size() + 1);
  }

  return out;
}

static std::string align_simple_as_in_select(std::string s) {
  std::vector<std::string> lines;
  lines.reserve(256);

  size_t pos = 0;
  while (pos <= s.size()) {
    const size_t nl = s.find('\n', pos);
    const bool has_nl = (nl != std::string::npos);
    const size_t end = has_nl ? nl : s.size();
    lines.push_back(std::string(s.substr(pos, end - pos)));
    pos = has_nl ? (nl + 1) : (s.size() + 1);
  }

  auto is_simple_as = [&](const std::string& line, size_t& ind_len, size_t& as_pos, size_t& lhs_len) -> bool {
    ind_len = 0;
    while (ind_len < line.size() && (line[ind_len] == ' ' || line[ind_len] == '\t')) ++ind_len;
    std::string_view trimmed(line.data() + ind_len, line.size() - ind_len);
    const size_t pos_as = find_token_outside_strings(trimmed, " AS ");
    if (pos_as == std::string::npos) return false;
    std::string_view lhs = trimmed.substr(0, pos_as);
    while (!lhs.empty() && (lhs.back() == ' ' || lhs.back() == '\t')) lhs.remove_suffix(1);
    if (lhs.empty()) return false;
    for (char c : lhs) {
      if (c == ' ' || c == '\t') return false;
    }
    as_pos = pos_as;
    lhs_len = lhs.size();
    return true;
  };

  bool in_select = false;
  std::vector<size_t> group;
  size_t group_max = 0;

  auto flush = [&]() {
    if (group.size() < 2) {
      group.clear();
      group_max = 0;
      return;
    }
    for (size_t idx : group) {
      std::string& line = lines[idx];
      size_t ind_len = 0, as_pos = 0, lhs_len = 0;
      if (!is_simple_as(line, ind_len, as_pos, lhs_len)) continue;

      std::string indent = line.substr(0, ind_len);
      std::string_view trimmed(line.data() + ind_len, line.size() - ind_len);
      std::string lhs = std::string(trimmed.substr(0, as_pos));
      while (!lhs.empty() && (lhs.back() == ' ' || lhs.back() == '\t')) lhs.pop_back();
      std::string rhs = std::string(trimmed.substr(as_pos + 1));
      while (!rhs.empty() && (rhs.front() == ' ' || rhs.front() == '\t')) rhs.erase(rhs.begin());

      const size_t pad = (group_max > lhs.size()) ? (group_max - lhs.size()) + 1 : 1;
      line = indent + lhs + std::string(pad, ' ') + rhs;
    }
    group.clear();
    group_max = 0;
  };

  for (size_t i = 0; i < lines.size(); ++i) {
    const std::string& line = lines[i];
    size_t ind_len = 0;
    while (ind_len < line.size() && (line[ind_len] == ' ' || line[ind_len] == '\t')) ++ind_len;
    std::string_view trimmed(line.data() + ind_len, line.size() - ind_len);

    if (!in_select && (trimmed == "SELECT" || trimmed.rfind("SELECT ", 0) == 0)) {
      flush();
      in_select = true;
      continue;
    }
    if (in_select && trimmed.rfind("FROM", 0) == 0) {
      flush();
      in_select = false;
      continue;
    }
    if (!in_select) {
      flush();
      continue;
    }

    size_t as_pos = 0, lhs_len = 0;
    if (is_simple_as(line, ind_len, as_pos, lhs_len)) {
      group.push_back(i);
      group_max = std::max(group_max, lhs_len);
    } else {
      flush();
    }
  }
  flush();

  std::string out;
  out.reserve(s.size() + 128);
  for (size_t i = 0; i < lines.size(); ++i) {
    out.append(lines[i]);
    if (i + 1 < lines.size()) out.push_back('\n');
  }
  return out;
}


static std::string format_bool_in_parentheses(std::string s, size_t threshold) {
  size_t i = 0;

  auto current_line_indent = [](const std::string& out) -> std::string {
    size_t line_start = out.rfind('\n');
    line_start = (line_start == std::string::npos) ? 0 : (line_start + 1);
    std::string ind;
    ind.reserve(32);
    for (size_t j = line_start; j < out.size(); ++j) {
      const char c = out[j];
      if (c == ' ' || c == '\t') ind.push_back(c);
      else break;
    }
    return ind;
  };

  auto parse = [&](auto&& self, char stop) -> std::string {
    std::string out;
    out.reserve(256);

    bool in_str = false;
    bool esc = false;
    bool in_line_comment = false;
    bool in_block_comment = false;

    while (i < s.size()) {
      const char c = s[i];

      if (!in_str && !in_line_comment && !in_block_comment && stop != 0 && c == stop) {
        ++i;
        break;
      }

      if (in_line_comment) {
        out.push_back(c);
        ++i;
        if (c == '\n') in_line_comment = false;
        continue;
      }

      if (in_block_comment) {
        out.push_back(c);
        ++i;
        if (c == '*' && i < s.size() && s[i] == '/') {
          out.push_back('/');
          ++i;
          in_block_comment = false;
        }
        continue;
      }

      if (in_str) {
        out.push_back(c);
        ++i;
        if (esc) {
          esc = false;
          continue;
        }
        if (c == '\\') {
          esc = true;
          continue;
        }
        if (c == '\'') in_str = false;
        continue;
      }

      if (c == '\'') {
        in_str = true;
        esc = false;
        out.push_back(c);
        ++i;
        continue;
      }

      if (c == '-' && i + 1 < s.size() && s[i + 1] == '-') {
        in_line_comment = true;
        out.push_back('-');
        out.push_back('-');
        i += 2;
        continue;
      }

      if (c == '/' && i + 1 < s.size() && s[i + 1] == '*') {
        in_block_comment = true;
        out.push_back('/');
        out.push_back('*');
        i += 2;
        continue;
      }

      if (c == '(') {
        const std::string indent = current_line_indent(out);

        auto last_ident_before_paren = [&](const std::string& buf) -> std::string {
          size_t p = buf.size();
          while (p > 0) {
            const char cc = buf[p - 1];
            if (cc == ' ' || cc == '\t' || cc == '\n' || cc == '\r') {
              --p;
              continue;
            }
            break;
          }
          const size_t end = p;
          while (p > 0) {
            const char cc = buf[p - 1];
            if ((cc >= 'A' && cc <= 'Z') || (cc >= 'a' && cc <= 'z') || cc == '_') {
              --p;
              continue;
            }
            break;
          }
          if (p >= end) return std::string();
          return std::string(buf.substr(p, end - p));
        };

        auto reindent_multiline = [&](std::string_view txt, const std::string& target_indent) -> std::string {
          std::vector<std::string_view> lines;
          size_t pos = 0;
          while (pos <= txt.size()) {
            const size_t nl = txt.find('\n', pos);
            const bool has = nl != std::string_view::npos;
            const size_t end = has ? nl : txt.size();
            lines.push_back(txt.substr(pos, end - pos));
            if (!has) break;
            pos = nl + 1;
          }

          size_t min_ws = std::numeric_limits<size_t>::max();
          for (const auto& ln : lines) {
            size_t k = 0;
            while (k < ln.size() && (ln[k] == ' ' || ln[k] == '\t')) ++k;
            if (k == ln.size()) continue;
            min_ws = std::min(min_ws, k);
          }
          if (min_ws == std::numeric_limits<size_t>::max()) min_ws = 0;

          std::string r;
          r.reserve(txt.size() + lines.size() * target_indent.size() + 8);
          for (size_t li = 0; li < lines.size(); ++li) {
            std::string_view ln = lines[li];
            if (ln.size() >= min_ws) ln = ln.substr(min_ws);
            r.append(target_indent);
            r.append(ln);
            if (li + 1 < lines.size()) r.push_back('\n');
          }
          return r;
        };

        out.push_back('(');
        ++i;

        std::string inner = self(self, ')');
        const std::string_view inner_trim = trim_view_ascii_spaces(std::string_view(inner));
        const bool looks_query = looks_like_query_block(inner_trim);
        const auto inner_parts = looks_query ? std::vector<BoolPart>() : split_bool_ops_top_level(inner_trim);

        if (!looks_query && inner_parts.size() > 1) {
          const std::string inner_indent = indent + "    ";
          out.push_back('\n');
          out.append(format_bool_expr(inner_trim, inner_indent));
          out.push_back('\n');
          out.append(indent);
        } else if (!looks_query && !inner_trim.empty() && inner_trim.size() > threshold) {
          const std::string inner_indent = indent + "    ";
          out.push_back('\n');
          out.append(inner_indent);
          out.append(inner_trim);
          out.push_back('\n');
          out.append(indent);
        } else if (looks_query && inner_trim.find('\n') != std::string_view::npos) {
          const std::string prev = last_ident_before_paren(out.substr(0, out.size() - 1));
          if (prev == "IN") {
            const std::string inner_indent = indent + "    ";
            out.push_back('\n');
            out.append(reindent_multiline(inner_trim, inner_indent));
            out.push_back('\n');
            out.append(indent);
          } else {
            out.append(inner);
          }
        } else {
          out.append(inner);
        }

        out.push_back(')');
        continue;
      }

      out.push_back(c);
      ++i;
    }

    return out;
  };

  i = 0;
  std::string out = parse(parse, 0);
  return out;
}

static std::string reindent_bool_expressions(std::string s) {
  std::string out;
  out.reserve(s.size() + 256);

  size_t pos = 0;
  while (pos <= s.size()) {
    const size_t nl = s.find('\n', pos);
    const bool has_nl = (nl != std::string::npos);
    const size_t end = has_nl ? nl : s.size();
    const std::string_view line = std::string_view(s).substr(pos, end - pos);

    size_t ind_len = 0;
    while (ind_len < line.size() && (line[ind_len] == ' ' || line[ind_len] == '\t')) ++ind_len;
    const std::string_view indent = line.substr(0, ind_len);
    const std::string_view trimmed = line.substr(ind_len);

    const bool skip = trimmed.empty() ||
                      trimmed.rfind("WHERE", 0) == 0 ||
                      trimmed.rfind("HAVING", 0) == 0 ||
                      trimmed.rfind("PREWHERE", 0) == 0 ||
                      trimmed.rfind("AND ", 0) == 0 ||
                      trimmed.rfind("OR ", 0) == 0 ||
                      trimmed.front() == ')' ||
                      trimmed.front() == ',';

    if (skip) {
      out.append(line);
    } else {
      const auto parts = split_bool_ops_top_level(trimmed);
      if (parts.size() > 1) {
        out.append(format_bool_expr(trimmed, std::string(indent)));
      } else {
        out.append(line);
      }
    }

    if (has_nl) out.push_back('\n');
    pos = has_nl ? (nl + 1) : (s.size() + 1);
  }

  return out;
}

static std::string postprocess_format_query(std::string s, size_t threshold) {
  // Rule 2: If SELECT has a single (long) expression, put it on the next line.
  if (s.rfind("SELECT ", 0) == 0 && s.find('\n') == std::string::npos) {
    const size_t from_pos = find_from_keyword_top_level(s);
    const size_t expr_beg = std::string("SELECT ").size();
    const size_t expr_end = (from_pos == std::string::npos) ? s.size() : from_pos;
    if (expr_end > expr_beg) {
      const std::string_view expr = std::string_view(s).substr(expr_beg, expr_end - expr_beg);
      if (!has_top_level_comma(expr) && (expr_end - expr_beg) > threshold) {
        std::string out;
        out.reserve(s.size() + 8);
        out.append("SELECT\n    ");
        out.append(trim_ascii_spaces(expr));
        out.append(s.substr(expr_end));
        s.swap(out);
      }
    }
  }

  // Rule 4 (+ Rule 3): Multiline CAST(...) args; pretty outer arrays of tuples.
  std::string out;
  out.reserve(s.size() + 64);
  bool in_str = false;
  bool esc = false;
  for (size_t i = 0; i < s.size();) {
    const char c = s[i];
    if (in_str) {
      out.push_back(c);
      if (esc) {
        esc = false;
      } else if (c == '\\') {
        esc = true;
      } else if (c == '\'') {
        in_str = false;
      }
      ++i;
      continue;
    }

    if (c == '\'') {
      in_str = true;
      esc = false;
      out.push_back(c);
      ++i;
      continue;
    }

    const bool is_cast =
        (i + 5 <= s.size() && s.compare(i, 5, "CAST(") == 0 && (i == 0 || !is_ident_char(s[i - 1])));
    if (!is_cast) {
      out.push_back(c);
      ++i;
      continue;
    }

    // Find matching ')'
    size_t j = i + 5;
    bool in2 = false;
    bool esc2 = false;
    int par = 1;
    for (; j < s.size(); ++j) {
      char cj = s[j];
      if (in2) {
        if (esc2) {
          esc2 = false;
          continue;
        }
        if (cj == '\\') {
          esc2 = true;
          continue;
        }
        if (cj == '\'') in2 = false;
        continue;
      }
      if (cj == '\'') {
        in2 = true;
        esc2 = false;
        continue;
      }
      if (cj == '(') ++par;
      else if (cj == ')') {
        --par;
        if (par == 0) break;
      }
    }
    if (j >= s.size()) {
      // malformed; passthrough
      out.append(s.substr(i));
      break;
    }

    const size_t call_len = (j + 1) - i;
    const std::string_view inner = std::string_view(s).substr(i + 5, (j - (i + 5)));
    auto args = split_top_level(inner, ',');
    if (args.size() < 2 || call_len <= threshold) {
      out.append(s.substr(i, call_len));
      i = j + 1;
      continue;
    }

    // Determine indentation at the call site.
    size_t line_start = out.rfind('\n');
    line_start = (line_start == std::string::npos) ? 0 : (line_start + 1);
    std::string base_indent;
    if (line_start < out.size()) {
      base_indent = out.substr(line_start);
      for (char ic : base_indent) {
        if (ic != ' ' && ic != '\t') { base_indent.clear(); break; }
      }
    }
    const std::string arg_indent = base_indent + "    ";

    out.append("CAST(\n");
    for (size_t k = 0; k < args.size(); ++k) {
      std::string a = trim_ascii_spaces(args[k]);
      std::string rendered;
      if (!a.empty() && a.front() == '[' && a.back() == ']') {
        rendered = pretty_array_arg(a, arg_indent);
      } else {
        rendered = arg_indent + a;
      }
      out.append(rendered);
      if (k + 1 < args.size()) out.push_back(',');
      out.push_back('\n');
    }
    out.append(base_indent);
    out.push_back(')');

    i = j + 1;
  }

  out = reindent_where_and_join(std::move(out));
  out = cascade_select_lists(std::move(out), threshold);
  out = align_simple_as_in_select(std::move(out));
  out = format_bool_in_parentheses(std::move(out), threshold);
  out = reindent_bool_expressions(std::move(out));
  return out;
}

static std::string escape_single_quotes(std::string_view in) {
  std::string out;
  out.reserve(in.size() + 8);
  for (char c : in) {
    if (c == '\\') {
      out.push_back('\\');
      out.push_back('\\');
    } else if (c == '\'') {
      out.push_back('\\');
      out.push_back('\'');
    } else {
      out.push_back(c);
    }
  }
  return out;
}

} // namespace

Server::Server(AppConfig cfg)
    : cfg_(std::move(cfg)),
      health_(std::make_unique<HealthRunner>(cfg_.hosts, cfg_.health)),
      jwt_(random_bytes(32)) {

  // Start global runners.
  if (health_) health_->start();

  // --- Static ---
  http_.Get("/", [&](const auto& req, auto& res) {
    if (!try_serve_embedded(req, res) && !try_serve_fs(cfg_.static_dir, req, res)) {
      res.status = 404;
      res.set_content("index.html not found", "text/plain");
    }
  });

  http_.Get(R"(/static/.*)", [&](const auto& req, auto& res) {
    if (!try_serve_embedded(req, res) && !try_serve_fs(cfg_.static_dir, req, res)) {
      res.status = 404;
      res.set_content("asset not found", "text/plain");
    }
  });

  http_.Get("/healthz", [&](const auto& req, auto& res) { handle_healthz(req, res); });
  http_.Get("/api/version", [&](const auto& req, auto& res) { handle_api_version(req, res); });
  http_.Get("/api/meta", [&](const auto& req, auto& res) { handle_api_meta(req, res); });
  http_.Get("/api/hosts", [&](const auto& req, auto& res) { handle_api_hosts(req, res); });
  http_.Get("/api/hosts/stream", [&](const auto& req, auto& res) { handle_api_hosts_stream(req, res); });
  http_.Get("/api/health", [&](const auto& req, auto& res) { handle_api_health(req, res); });

  http_.Post("/api/format", [&](const auto& req, auto& res) { handle_api_format(req, res); });

  http_.Post("/api/query/run", [&](const auto& req, auto& res) { handle_query_run(req, res); });
  http_.Post("/api/query", [&](const auto& req, auto& res) { handle_query_run(req, res); });

  http_.Get("/api/query/stream", [&](const auto& req, auto& res) { handle_query_stream(req, res); });
  http_.Post("/api/query/cancel", [&](const auto& req, auto& res) { handle_query_cancel(req, res); });
}

int Server::run() {
  auto pos = cfg_.listen.rfind(':');
  std::string host = "0.0.0.0";
  int port = 8080;
  if (pos != std::string::npos) {
    host = cfg_.listen.substr(0, pos);
    port = std::stoi(cfg_.listen.substr(pos + 1));
  }
  return http_.listen(host.c_str(), port) ? 0 : 1;
}

bool Server::health_check(std::string* error_message) {
  if (cfg_.hosts.empty()) {
    if (error_message) *error_message = "no ClickHouse hosts configured";
    return false;
  }
  // Strict: ALL hosts must be reachable.
  for (const auto& h : cfg_.hosts) {
    std::string err;
    auto c = make_client_from_uri(
      h.system_uri,
      std::chrono::milliseconds(cfg_.health.timeout_ms),
      std::chrono::milliseconds(cfg_.health.timeout_ms),
      std::chrono::milliseconds(cfg_.health.timeout_ms),
      &err
    );
    if (!c) {
      if (error_message) *error_message = "host=" + h.id + " connect error: " + err;
      return false;
    }
    try {
      c->Ping();
    } catch (const std::exception& e) {
      if (error_message) *error_message = "host=" + h.id + " ping error: " + std::string(e.what());
      return false;
    }
  }
  return true;
}

void Server::handle_healthz(const httplib::Request&, httplib::Response& res) {
  // Use the async runner snapshot if available.
  const bool ok = health_ ? health_->all_healthy() : false;
  if (ok) {
    res.status = 200;
    res.set_content("ok", "text/plain");
    return;
  }
  json_error(res, 503, "db_unhealthy", "one or more ClickHouse hosts are unhealthy");
}

void Server::handle_api_version(const httplib::Request&, httplib::Response& res) {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("name"); w.String("clickhouse-dash");
  w.Key("version"); w.String(cfg_.version_semver.c_str());
  w.Key("git_sha"); w.String(cfg_.version_git_sha.c_str());
  w.Key("build_time"); w.String(cfg_.version_build_time.c_str());
  w.EndObject();
  res.status = 200;
  res.set_content(sb.GetString(), "application/json");
}

void Server::handle_api_meta(const httplib::Request& req, httplib::Response& res) {
  const auto host_it = req.params.find("host_id");
  if (host_it == req.params.end() || host_it->second.empty()) {
    return json_error(res, 400, "missing_host_id", "Missing host_id.");
  }
  const std::string host_id = host_it->second;
  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) {
    return json_error(res, 404, "unknown_host", "Unknown host_id.");
  }

  std::vector<std::string> types;
  const auto types_it = req.params.find("types");
  if (types_it == req.params.end() || types_it->second.empty()) {
    types.push_back("keywords");
  } else {
    types = split_csv(types_it->second);
  }
  if (types.empty()) {
    return json_error(res, 400, "missing_types", "Missing types.");
  }

  const int64_t generated_at = now_ms();
  const int64_t ttl_ms = 10 * 60 * 1000;

  struct TypeResult {
    bool ok = false;
    bool stale = false;
    int64_t updated_at_ms = 0;
    std::vector<std::string> items;
    std::string error_code;
    std::string error_message;
  };

  std::unordered_map<std::string, TypeResult> results;
  results.reserve(types.size());

  for (const auto& t : types) {
    results.emplace(t, TypeResult{});
  }

  std::unordered_map<std::string, MetaCacheEntry> cached;
  {
    std::lock_guard<std::mutex> lk(meta_mu_);
    auto hit = meta_cache_.find(host_id);
    if (hit != meta_cache_.end()) cached = hit->second;
  }

  auto get_cached = [&](const std::string& type) -> std::optional<MetaCacheEntry> {
    auto it = cached.find(type);
    if (it == cached.end()) return std::nullopt;
    return it->second;
  };

  auto set_cache = [&](const std::string& type, MetaCacheEntry e) {
    std::lock_guard<std::mutex> lk(meta_mu_);
    meta_cache_[host_id][type] = std::move(e);
  };

  std::unordered_map<std::string, bool> should_fetch;
  should_fetch.reserve(types.size());
  for (const auto& type : types) {
    const auto ce = get_cached(type);
    const bool fresh = ce && (generated_at - ce->fetched_at_ms) <= ttl_ms;
    should_fetch[type] = !fresh;
    if (fresh) {
      auto& r = results[type];
      r.ok = true;
      r.stale = false;
      r.updated_at_ms = ce->updated_at_ms;
      r.items = ce->items;
    }
  }

  std::string client_err;
  std::shared_ptr<clickhouse::Client> client;
  for (const auto& type : types) {
    if (!should_fetch[type]) continue;
    if (type != "keywords") {
      auto& r = results[type];
      r.ok = false;
      r.error_code = "unknown_type";
      r.error_message = "Unknown metadata type.";
      continue;
    }

    if (!client) {
      client = make_client_from_uri(
        host->system_uri,
        std::chrono::seconds(3),
        std::chrono::seconds(3),
        std::chrono::seconds(3),
        &client_err
      );
      if (!client) {
        auto& r = results[type];
        r.ok = false;
        r.error_code = "host_down";
        r.error_message = "Could not connect to host.";
        continue;
      }
    }

    try {
      std::vector<std::string> items;
      client->Select("SELECT keyword FROM system.keywords", [&items](const clickhouse::Block& block) {
        if (block.GetColumnCount() < 1) return;
        const auto col = block[0]->As<clickhouse::ColumnString>();
        if (!col) return;
        const size_t n = col->Size();
        for (size_t i = 0; i < n; ++i) {
          const auto sv = col->At(i);
          items.emplace_back(sv.data(), sv.size());
        }
      });

      std::sort(items.begin(), items.end());
      items.erase(std::unique(items.begin(), items.end()), items.end());

      MetaCacheEntry e;
      e.fetched_at_ms = generated_at;
      e.updated_at_ms = generated_at;
      e.items = items;
      set_cache(type, e);

      auto& r = results[type];
      r.ok = true;
      r.stale = false;
      r.updated_at_ms = e.updated_at_ms;
      r.items = std::move(items);
    } catch (const std::exception& e) {
      auto& r = results[type];
      r.ok = false;
      r.error_code = "clickhouse_error";
      r.error_message = e.what();
      const auto ce = get_cached(type);
      if (ce) {
        r.ok = true;
        r.stale = true;
        r.updated_at_ms = ce->updated_at_ms;
        r.items = ce->items;
      }
    }
  }

  bool any_ok = false;
  for (const auto& [_, r] : results) {
    if (r.ok) { any_ok = true; break; }
  }

  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Int(1);
  w.Key("host_id"); w.String(host_id.c_str());
  w.Key("generated_at_ms"); w.Int64(generated_at);

  w.Key("data");
  w.StartObject();
  for (const auto& type : types) {
    const auto it = results.find(type);
    if (it == results.end()) continue;
    const auto& r = it->second;
    if (!r.ok) continue;
    w.Key(type.c_str());
    w.StartObject();
    w.Key("updated_at_ms"); w.Int64(r.updated_at_ms);
    if (r.stale) { w.Key("stale"); w.Bool(true); }
    w.Key("items");
    w.StartArray();
    for (const auto& s : r.items) w.String(s.c_str());
    w.EndArray();
    w.EndObject();
  }
  w.EndObject();

  w.Key("errors");
  w.StartArray();
  for (const auto& type : types) {
    const auto it = results.find(type);
    if (it == results.end()) continue;
    const auto& r = it->second;
    if (r.ok && !r.stale) continue;
    if (r.error_code.empty()) continue;
    w.StartObject();
    w.Key("type"); w.String(type.c_str());
    w.Key("error_code"); w.String(r.error_code.c_str());
    w.Key("message"); w.String(r.error_message.c_str());
    if (r.stale) { w.Key("stale_used"); w.Bool(true); }
    w.EndObject();
  }
  w.EndArray();

  w.EndObject();

  res.status = any_ok ? 200 : 503;
  res.set_content(sb.GetString(), "application/json");
}

void Server::handle_api_hosts(const httplib::Request&, httplib::Response& res) {
  if (!health_) return json_error(res, 500, "no_runner", "health runner not initialized");
  HostsSnapshot snap = health_->snapshot();

  const std::string json = build_hosts_json(snap);
  res.status = 200;
  res.set_content(json, "application/json");
}

void Server::handle_api_hosts_stream(const httplib::Request&, httplib::Response& res) {
  if (!health_) return json_error(res, 500, "no_runner", "health runner not initialized");

  res.set_header("Content-Type", "text/event-stream");
  res.set_header("Cache-Control", "no-cache");
  res.set_header("Connection", "keep-alive");
  res.set_header("X-Accel-Buffering", "no");

  struct HostsStreamState {
    uint64_t last_version = 0;
    std::chrono::steady_clock::time_point last_keepalive{};
    std::deque<std::string> local_chunks;
  };

  auto st = std::make_shared<HostsStreamState>();
  st->last_version = health_->version();
  st->local_chunks.push_back(sse_json_event("hosts", build_hosts_json(health_->snapshot())));

  HealthRunner* runner = health_.get();

  res.set_chunked_content_provider(
      "text/event-stream",
      [st, runner](size_t /*offset*/, httplib::DataSink& sink) {
        if (!st->local_chunks.empty()) {
          auto chunk = std::move(st->local_chunks.front());
          st->local_chunks.pop_front();
          sink.write(chunk.data(), chunk.size());
          return true;
        }

        uint64_t new_ver = st->last_version;
        const bool changed = runner->wait_for_update(st->last_version, 15000, &new_ver);
        if (changed) {
          st->last_version = new_ver;
          const auto ev = sse_json_event("hosts", build_hosts_json(runner->snapshot()));
          sink.write(ev.data(), ev.size());
          return true;
        }

        const auto now = std::chrono::steady_clock::now();
        if (st->last_keepalive.time_since_epoch().count() == 0 || now - st->last_keepalive >= std::chrono::seconds(15)) {
          st->last_keepalive = now;
          const auto ka = sse_json_event("keepalive", "{}");
          sink.write(ka.data(), ka.size());
          return true;
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        return true;
      },
      [](bool /*success*/) {
        // no-op
      }
  );
}

void Server::handle_api_health(const httplib::Request&, httplib::Response& res) {
  if (!health_) return json_error(res, 500, "no_runner", "health runner not initialized");
  HostsSnapshot snap = health_->snapshot();
  int healthy = 0;
  for (const auto& h : snap.hosts) if (h.healthy) ++healthy;
  const int total = static_cast<int>(snap.hosts.size());
  const bool ok = (total > 0 && healthy == total);

  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("ok"); w.Bool(ok);
  w.Key("healthy_hosts"); w.Int(healthy);
  w.Key("total_hosts"); w.Int(total);
  w.Key("ts_ms"); w.Int64(snap.ts_ms);
  w.EndObject();

  res.status = ok ? 200 : 503;
  res.set_content(sb.GetString(), "application/json");
}

void Server::handle_api_format(const httplib::Request& req, httplib::Response& res) {
  rapidjson::Document doc;
  if (!parse_json_body(req, doc)) {
    return json_error(res, 400, "invalid_json", "Invalid JSON request body.");
  }
  if (!doc.HasMember("host_id") || !doc["host_id"].IsString()) {
    return json_error(res, 400, "missing_host_id", "Missing host_id.");
  }

  const std::string host_id = doc["host_id"].GetString();
  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) {
    return json_error(res, 404, "unknown_host", "Unknown host_id.");
  }

  if (health_) {
    HostsSnapshot hs = health_->snapshot();
    for (const auto& h : hs.hosts) {
      if (h.id == host_id && !h.healthy) {
        return json_error(res, 503, "host_down", "Selected host is down.");
      }
    }
  }

  auto format_one = [&](std::string sql_raw, std::string* out_pretty, std::string* err) -> bool {
    std::string sql = trim_sql(std::move(sql_raw));
    if (sql.empty()) {
      if (err) *err = "Missing SQL text.";
      return false;
    }
    std::string fmt_err;
    const auto formatted = try_format_query(*host, sql, 500 * 1024, &fmt_err);
    if (!formatted.has_value()) {
      if (err) *err = fmt_err.empty() ? "Failed to format query." : fmt_err;
      return false;
    }
    if (out_pretty) *out_pretty = postprocess_format_query(*formatted, 80);
    return true;
  };

  if (doc.HasMember("sqls") && doc["sqls"].IsArray()) {
    const auto& arr = doc["sqls"];
    rapidjson::StringBuffer sb;
    rapidjson::Writer<rapidjson::StringBuffer> w(sb);
    w.StartObject();
    w.Key("formatted_sqls");
    w.StartArray();
    for (rapidjson::SizeType i = 0; i < arr.Size(); ++i) {
      if (!arr[i].IsString()) {
        return json_error(res, 400, "invalid_sqls", "sqls must be an array of strings.");
      }
      std::string pretty;
      std::string err;
      if (!format_one(arr[i].GetString(), &pretty, &err)) {
        return json_error(res, 200, "format_failed", std::to_string(i));
      }
      w.String(pretty.c_str());
    }
    w.EndArray();
    w.EndObject();

    res.status = 200;
    res.set_content(sb.GetString(), "application/json");
    return;
  }

  if (!doc.HasMember("sql") || !doc["sql"].IsString()) {
    return json_error(res, 400, "missing_sql", "Missing SQL text.");
  }

  std::string pretty;
  std::string err;
  if (!format_one(doc["sql"].GetString(), &pretty, &err)) {
    return json_error(res, 422, "format_failed", err);
  }

  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("formatted_sql");
  w.String(pretty.c_str());
  w.EndObject();

  res.status = 200;
  res.set_content(sb.GetString(), "application/json");
}


void Server::handle_query_run(const httplib::Request& req, httplib::Response& res) {
  rapidjson::Document doc;
  if (!parse_json_body(req, doc)) {
    return json_error(res, 400, "invalid_json", "Invalid JSON request body.");
  }
  if (!doc.HasMember("sql") || !doc["sql"].IsString()) {
    return json_error(res, 400, "missing_sql", "Missing SQL text.");
  }
  if (!doc.HasMember("host_id") || !doc["host_id"].IsString()) {
    return json_error(res, 400, "missing_host_id", "Missing host_id.");
  }

  std::string sql_raw = doc["sql"].GetString();
  std::string sql = trim_sql(sql_raw);
  if (sql.empty()) {
    return json_error(res, 400, "missing_sql", "Missing SQL text.");
  }
  const std::string host_id = doc["host_id"].GetString();
  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) {
    return json_error(res, 404, "unknown_host", "Unknown host_id.");
  }

  // Block if health runner considers the host down.
  if (health_) {
    HostsSnapshot hs = health_->snapshot();
    for (const auto& h : hs.hosts) {
      if (h.id == host_id && !h.healthy) {
        return json_error(res, 503, "host_down", "Selected host is down.");
      }
    }
  }

  const std::string qid = gen_query_id();

  // 1) Create session + start execution.
  std::string client_err;
  auto client_query = make_client_from_uri(
    host->runner_uri,
    std::chrono::seconds(5),
    std::chrono::milliseconds(0),
    std::chrono::milliseconds(0),
    &client_err
  );
  if (!client_query) {
    return json_error(res, 503, "host_down", "Could not connect to host.");
  }

  // No default DB switching; users write db.table.
  auto session = std::make_shared<QuerySession>(qid, sql, "", client_query, cfg_.result_preview_row_limit);
  {
    std::lock_guard<std::mutex> lk(mu_);
    sessions_[qid] = session;
  }
  session->start();

  // 2) Mint cancel token.
  JwtClaims claims;
  claims.query_id = qid;
  claims.host_id = host_id;
  claims.issued_at_unix = now_unix_sec();
  const std::string cancel_token = jwt_.sign_cancel_token(claims);

  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("query_id"); w.String(qid.c_str());
  w.Key("cancel_token"); w.String(cancel_token.c_str());
  std::string stream = "api/query/stream?query_id=" + qid;
  w.Key("stream_url"); w.String(stream.c_str());
  w.EndObject();

  res.status = 200;
  res.set_content(sb.GetString(), "application/json");
}

void Server::handle_query_stream(const httplib::Request& req, httplib::Response& res) {
  const std::string qid = req.get_param_value("query_id");
  if (qid.empty()) {
    return json_error(res, 400, "missing_query_id", "Missing query_id query parameter.");
  }

  std::shared_ptr<QuerySession> session;
  {
    std::lock_guard<std::mutex> lk(mu_);
    auto it = sessions_.find(qid);
    if (it == sessions_.end()) return json_error(res, 404, "not_found", "Unknown query_id.");
    session = it->second;
  }

  // idempotent
  session->start();

  res.set_header("Content-Type", "text/event-stream");
  res.set_header("Cache-Control", "no-cache");
  res.set_header("Connection", "keep-alive");
  res.set_header("X-Accel-Buffering", "no");

  auto st = std::make_shared<StreamState>();
  st->session = session;
  st->query_id = qid;
  st->local_chunks.push_back(sse_json_event("meta", build_meta_json(qid)));

  Server* self = this;

  res.set_chunked_content_provider(
      "text/event-stream",
      [st, self](size_t /*offset*/, httplib::DataSink& sink) {
        if (!st->local_chunks.empty()) {
          auto chunk = std::move(st->local_chunks.front());
          st->local_chunks.pop_front();
          sink.write(chunk.data(), chunk.size());
          return true;
        }

        // Prioritize produced query chunks (result_meta/result_rows/error) before
        // periodic tick/done. Otherwise very fast queries can finish before the
        // first publish window and get closed without delivering their results.
        std::string produced;
        st->session->wait_pop_sse_chunk(produced, 0);
        if (!produced.empty()) {
          sink.write(produced.data(), produced.size());
          return true;
        }

        const auto now = std::chrono::steady_clock::now();
        if (st->last_publish.time_since_epoch().count() == 0 || now - st->last_publish >= std::chrono::milliseconds(250)) {
          const auto snap = st->session->snapshot();
          const auto tick = sse_json_event("tick", build_tick_json(snap, *st));
          sink.write(tick.data(), tick.size());

          if (snap.status == SessionStatus::Finished || snap.status == SessionStatus::Error || snap.status == SessionStatus::Canceled || snap.status == SessionStatus::ResultLimitReached) {
            const bool truncated = (snap.status == SessionStatus::ResultLimitReached);
            const auto done = sse_json_event("done", build_done_json(snap, "", truncated));
            sink.write(done.data(), done.size());
            sink.done();

            // Best-effort cleanup.
            {
              std::lock_guard<std::mutex> lk(self->mu_);
              self->sessions_.erase(st->query_id);
            }
            return false;
          }
          return true;
        }

        const bool cont = st->session->wait_pop_sse_chunk(produced, 30);
        if (!produced.empty()) {
          sink.write(produced.data(), produced.size());
          return true;
        }

        if (!cont) {
          const auto snap = st->session->snapshot();
          const auto finalTick = sse_json_event("tick", build_tick_json(snap, *st));
          sink.write(finalTick.data(), finalTick.size());
          const bool truncated = (snap.status == SessionStatus::ResultLimitReached);
          const auto done = sse_json_event("done", build_done_json(snap, "", truncated));
          sink.write(done.data(), done.size());
          sink.done();

          {
            std::lock_guard<std::mutex> lk(self->mu_);
            self->sessions_.erase(st->query_id);
          }
          return false;
        }

        if (st->last_keepalive.time_since_epoch().count() == 0 || now - st->last_keepalive >= std::chrono::seconds(15)) {
          st->last_keepalive = now;
          const auto ka = sse_json_event("keepalive", build_keepalive_json(st->query_id));
          sink.write(ka.data(), ka.size());
          return cont;
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        return cont;
      },
      [session](bool success) {
        if (!success) {
          session->request_cancel();
        }
      });
}

void Server::handle_query_cancel(const httplib::Request& req, httplib::Response& res) {
  rapidjson::Document doc;
  if (!parse_json_body(req, doc)) {
    return json_error(res, 400, "invalid_json", "Invalid JSON request body.");
  }
  if (!doc.HasMember("cancel_token") || !doc["cancel_token"].IsString()) {
    return json_error(res, 400, "missing_cancel_token", "Missing cancel_token.");
  }

  const std::string token = doc["cancel_token"].GetString();
  auto claims = jwt_.verify_cancel_token(token);
  if (!claims) {
    return json_error(res, 401, "invalid_token", "Invalid cancel_token.");
  }

  const std::string qid = claims->query_id;
  const std::string host_id = claims->host_id;

  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) {
    return json_error(res, 404, "unknown_host", "Unknown host_id.");
  }

  // Mark locally as canceled if we still have it.
  {
    std::lock_guard<std::mutex> lk(mu_);
    auto it = sessions_.find(qid);
    if (it != sessions_.end()) {
      it->second->request_cancel();
    }
  }

  // Kill on server via system user. No in-memory registry required.
  try {
    std::string err;
    auto c = make_client_from_uri(
      host->system_uri,
      std::chrono::seconds(5),
      std::chrono::seconds(5),
      std::chrono::seconds(5),
      &err
    );
    if (!c) {
      std::cerr << "[cancel] host=" << host_id << " qid=" << qid << " connect error: " << err << "\n";
    } else {
      const std::string qid_esc = escape_single_quotes(qid);
      const std::string kill_sql = "KILL QUERY WHERE query_id = '" + qid_esc + "'";
      c->Execute(kill_sql);
    }
  } catch (const std::exception& e) {
    // Spec: minimal response, log details in backend.
    std::cerr << "[cancel] host=" << host_id << " qid=" << qid << " error: " << e.what() << "\n";
  }

  res.status = 200;
  res.set_content("{\"ok\":true}", "application/json");
}

} // namespace chdash
