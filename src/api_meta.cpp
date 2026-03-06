#include "server.hpp"

#include "api_error.hpp"
#include "ch_uri.hpp"
#include "host_util.hpp"
#include "time_util.hpp"

#include <chrono>
#include <optional>
#include <string>
#include <vector>

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

namespace chdash {

void Server::handle_api_meta(const httplib::Request& req, httplib::Response& res) {
  if (!health_) return json_error(res, 500, "no_runner", "health runner not initialized");

  std::string host_id = "default";
  if (req.has_param("host_id")) host_id = req.get_param_value("host_id");

  std::string types_csv = "keywords";
  if (req.has_param("types")) types_csv = req.get_param_value("types");

  std::vector<std::string> types;
  {
    std::string cur;
    for (char c : types_csv) {
      if (c == ',') {
        if (!cur.empty()) types.push_back(cur);
        cur.clear();
        continue;
      }
      if (c == ' ' || c == '\t' || c == '\n' || c == '\r') continue;
      cur.push_back(c);
    }
    if (!cur.empty()) types.push_back(cur);
  }
  if (types.empty()) types.push_back("keywords");

  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) return json_error(res, 404, "unknown_host", "unknown host_id");

  const uint64_t ts_ms = static_cast<uint64_t>(now_ms());
  const uint64_t ttl_ms = 10ULL * 60ULL * 1000ULL;

  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);

  w.StartObject();
  w.Key("version"); w.Uint(1);
  w.Key("host_id"); w.String(host_id.c_str());
  w.Key("generated_at_ms"); w.Uint64(ts_ms);

  w.Key("data");
  w.StartObject();

  struct ErrItem { std::string type; std::string code; std::string message; bool stale = false; };
  std::vector<ErrItem> errors;

  auto fetch_keywords = [&](MetaKeywords& out, std::string& err_code, std::string& err_msg) -> bool {
    out.updated_at_ms = ts_ms;

    std::string err;
    auto client = make_client_from_uri(
        host->runner_uri,
        std::chrono::seconds(5),
        std::chrono::seconds(10),
        std::chrono::seconds(10),
        &err
    );
    if (!client) {
      err_code = "clickhouse_connect";
      err_msg = err;
      return false;
    }

    try {
      client->Select("SELECT keyword FROM system.keywords", [&](const clickhouse::Block& b) {
        if (b.GetRowCount() == 0 || b.GetColumnCount() == 0) return;
        auto col = b[0]->As<clickhouse::ColumnString>();
        if (!col) return;
        const size_t n = b.GetRowCount();
        out.items.reserve(out.items.size() + n);
        for (size_t i = 0; i < n; ++i) {
          const std::string_view sv = col->At(i);
          out.items.emplace_back(sv.data(), sv.size());
        }
      });
    } catch (const std::exception& e) {
      err_code = "clickhouse_error";
      err_msg = e.what();
      return false;
    }

    return true;
  };

  auto fetch_functions = [&](MetaFunctions& out, std::string& err_code, std::string& err_msg) -> bool {
    out.updated_at_ms = ts_ms;

    std::string err;
    auto client = make_client_from_uri(
        host->runner_uri,
        std::chrono::seconds(5),
        std::chrono::seconds(10),
        std::chrono::seconds(10),
        &err
    );
    if (!client) {
      err_code = "clickhouse_connect";
      err_msg = err;
      return false;
    }

    try {
      client->Select("SELECT name, is_aggregate, case_insensitive FROM system.functions", [&](const clickhouse::Block& b) {
        if (b.GetRowCount() == 0 || b.GetColumnCount() < 3) return;
        auto col_name = b[0]->As<clickhouse::ColumnString>();
        auto col_agg = b[1]->As<clickhouse::ColumnUInt8>();
        auto col_ci = b[2]->As<clickhouse::ColumnUInt8>();
        if (!col_name || !col_agg || !col_ci) return;
        const size_t n = b.GetRowCount();
        out.items.reserve(out.items.size() + n);
        for (size_t i = 0; i < n; ++i) {
          const std::string_view sv = col_name->At(i);
          MetaFunction f;
          f.name.assign(sv.data(), sv.size());
          f.is_aggregate = col_agg->At(i) != 0;
          f.case_insensitive = col_ci->At(i) != 0;
          out.items.push_back(std::move(f));
        }
      });
    } catch (const std::exception& e) {
      err_code = "clickhouse_error";
      err_msg = e.what();
      return false;
    }

    return true;
  };

  for (const auto& t : types) {
    if (t == "keywords") {
      auto r = meta_keywords_cache_.get_or_refresh(host_id, ts_ms, ttl_ms, 5000, fetch_keywords);
      if (!r.has_value) {
        errors.push_back({"keywords", r.error_code.empty() ? "clickhouse_error" : r.error_code, r.error_message, false});
        continue;
      }
      if (r.had_error) {
        errors.push_back({"keywords", r.error_code, r.error_message, true});
      }
      w.Key("keywords");
      w.StartObject();
      w.Key("updated_at_ms"); w.Uint64(r.value.updated_at_ms);
      if (r.stale) {
        w.Key("stale"); w.Bool(true);
      }
      w.Key("items");
      w.StartArray();
      for (const auto& kw : r.value.items) w.String(kw.c_str());
      w.EndArray();
      w.EndObject();
      continue;
    }

    if (t == "functions") {
      auto r = meta_functions_cache_.get_or_refresh(host_id, ts_ms, ttl_ms, 5000, fetch_functions);
      if (!r.has_value) {
        errors.push_back({"functions", r.error_code.empty() ? "clickhouse_error" : r.error_code, r.error_message, false});
        continue;
      }
      if (r.had_error) {
        errors.push_back({"functions", r.error_code, r.error_message, true});
      }
      w.Key("functions");
      w.StartObject();
      w.Key("updated_at_ms"); w.Uint64(r.value.updated_at_ms);
      if (r.stale) {
        w.Key("stale"); w.Bool(true);
      }
      w.Key("items");
      w.StartArray();
      for (const auto& fn : r.value.items) {
        w.StartObject();
        w.Key("name"); w.String(fn.name.c_str());
        w.Key("is_aggregate"); w.Bool(fn.is_aggregate);
        w.Key("case_insensitive"); w.Bool(fn.case_insensitive);
        w.EndObject();
      }
      w.EndArray();
      w.EndObject();
      continue;
    }

    errors.push_back({t, "unsupported_type", "unsupported type", false});
  }

  w.EndObject();

  w.Key("errors");
  w.StartArray();
  for (const auto& e : errors) {
    w.StartObject();
    w.Key("type"); w.String(e.type.c_str());
    w.Key("code"); w.String(e.code.c_str());
    w.Key("message"); w.String(e.message.c_str());
    w.Key("stale"); w.Bool(e.stale);
    w.EndObject();
  }
  w.EndArray();

  w.EndObject();

  if (!errors.empty()) {
    bool fatal = true;
    for (const auto& e : errors) {
      if (e.stale) { fatal = false; break; }
    }
    if (fatal) {
      res.status = 503;
      res.set_content(sb.GetString(), "application/json");
      return;
    }
  }

  res.status = 200;
  res.set_content(sb.GetString(), "application/json");
}

} // namespace chdash
