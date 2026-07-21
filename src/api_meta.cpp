#include "server.hpp"

#include "api_error.hpp"
#include "ch_uri.hpp"
#include "host_util.hpp"
#include "time_util.hpp"

#include <algorithm>
#include <chrono>
#include <cctype>
#include <iterator>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_set>
#include <utility>
#include <vector>

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

namespace chdash {
namespace {

std::string lower_ascii(std::string_view s) {
  std::string out;
  out.reserve(s.size());
  for (char ch : s) {
    if (ch >= 'A' && ch <= 'Z') out.push_back(static_cast<char>(ch - 'A' + 'a'));
    else out.push_back(ch);
  }
  return out;
}


int compare_ascii_ci(std::string_view a, std::string_view b) {
  const size_t n = std::min(a.size(), b.size());
  for (size_t i = 0; i < n; ++i) {
    const char ac = (a[i] >= 'A' && a[i] <= 'Z') ? static_cast<char>(a[i] - 'A' + 'a') : a[i];
    const char bc = (b[i] >= 'A' && b[i] <= 'Z') ? static_cast<char>(b[i] - 'A' + 'a') : b[i];
    if (ac < bc) return -1;
    if (ac > bc) return 1;
  }
  if (a.size() < b.size()) return -1;
  if (a.size() > b.size()) return 1;
  return 0;
}

std::string block_string_at(const clickhouse::Block& b, size_t col, size_t row) {
  if (col >= b.GetColumnCount()) return {};
  auto c = b[col]->As<clickhouse::ColumnString>();
  if (!c) return {};
  const std::string_view sv = c->At(row);
  return std::string(sv.data(), sv.size());
}

bool block_truthy_at(const clickhouse::Block& b, size_t col, size_t row) {
  if (col >= b.GetColumnCount()) return false;
  if (auto c = b[col]->As<clickhouse::ColumnUInt8>()) return c->At(row) != 0;
  if (auto s = b[col]->As<clickhouse::ColumnString>()) {
    const std::string_view sv = s->At(row);
    return sv == "1" || sv == "true" || sv == "TRUE";
  }
  return false;
}

std::string quote_ident(std::string_view ident) {
  std::string out;
  out.reserve(ident.size() + 2);
  out.push_back('`');
  for (char ch : ident) {
    if (ch == '`') out += "``";
    else out.push_back(ch);
  }
  out.push_back('`');
  return out;
}

std::string qualified_ident(std::string_view database, std::string_view table) {
  if (database.empty()) return quote_ident(table);
  return quote_ident(database) + "." + quote_ident(table);
}

bool is_system_info_database(std::string_view db) {
  return db == "INFORMATION_SCHEMA" || db == "information_schema";
}

} // namespace

void Server::handle_api_meta(const httplib::Request& req, httplib::Response& res) {
  if (!health_) return json_error(res, 500, "no_runner", "health runner not initialized");

  std::string host_id = "default";
  if (req.has_param("host_id")) host_id = req.get_param_value("host_id");

  std::string types_csv = "keywords";
  if (req.has_param("types")) types_csv = req.get_param_value("types");

  std::vector<std::string> types;
  {
    std::unordered_set<std::string> seen_types;
    auto add_type = [&](std::string type) {
      if (!type.empty() && seen_types.insert(type).second) types.push_back(std::move(type));
    };
    std::string cur;
    for (char c : types_csv) {
      if (c == ',') {
        add_type(std::move(cur));
        cur.clear();
        continue;
      }
      if (c == ' ' || c == '\t' || c == '\n' || c == '\r') continue;
      cur.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(c))));
    }
    add_type(std::move(cur));
  }
  if (types.empty()) types.push_back("keywords");

  const std::string column_database = req.has_param("database")
    ? req.get_param_value("database")
    : std::string{};
  const std::string column_table = req.has_param("table")
    ? req.get_param_value("table")
    : std::string{};
  const bool columns_requested = std::find(types.begin(), types.end(), "columns") != types.end();
  const bool scoped_columns = !column_database.empty() && !column_table.empty();
  if (columns_requested && (column_database.empty() != column_table.empty())) {
    return json_error(
      res,
      400,
      "invalid_column_scope",
      "Both database and table are required for scoped column metadata."
    );
  }

  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) return json_error(res, 404, "unknown_host", "unknown host_id");

  const uint64_t ts_ms = static_cast<uint64_t>(now_ms());
  const uint64_t ttl_ms = 10ULL * 60ULL * 1000ULL;

  rapidjson::StringBuffer sb(nullptr, 16 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);

  w.StartObject();
  w.Key("version"); w.Uint(1);
  w.Key("host_id"); w.String(host_id.c_str());
  w.Key("generated_at_ms"); w.Uint64(ts_ms);

  w.Key("data");
  w.StartObject();

  struct ErrItem { std::string type; std::string code; std::string message; bool stale = false; };
  std::vector<ErrItem> errors;

  // A multi-type metadata request is sequential. Reuse one exclusive pooled
  // connection instead of acquiring/releasing a client for every cache miss.
  std::shared_ptr<clickhouse::Client> request_client;
  std::string request_client_error;
  bool request_client_attempted = false;
  auto make_client = [&]() {
    if (request_client) return std::pair{request_client, std::string{}};
    if (request_client_attempted) return std::pair{request_client, request_client_error};
    request_client_attempted = true;
    request_client = client_pool_ ? client_pool_->acquire(
        host->runner_uri,
        std::chrono::seconds(5),
        std::chrono::seconds(10),
        std::chrono::seconds(10),
        &request_client_error
    ) : make_client_from_uri(
        host->runner_uri,
        std::chrono::seconds(5),
        std::chrono::seconds(10),
        std::chrono::seconds(10),
        &request_client_error
    );
    return std::pair{request_client, request_client_error};
  };

  auto fetch_keywords = [&](MetaKeywords& out, std::string& err_code, std::string& err_msg) -> bool {
    out.updated_at_ms = ts_ms;

    auto client_result = make_client();
    auto client = std::move(client_result.first);
    std::string err = std::move(client_result.second);
    if (!client) {
      err_code = "clickhouse_connect";
      err_msg = err;
      return false;
    }

    try {
      client->Select("SELECT keyword FROM system.keywords ORDER BY lower(keyword), keyword", [&](const clickhouse::Block& b) {
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

    auto client_result = make_client();
    auto client = std::move(client_result.first);
    std::string err = std::move(client_result.second);
    if (!client) {
      err_code = "clickhouse_connect";
      err_msg = err;
      return false;
    }

    std::vector<std::string> aggregate_names;
    std::vector<bool> aggregate_case_insensitive;
    std::vector<std::string> combinators;
    std::unordered_set<std::string> seen;

    auto reset_loaded_functions = [&]() {
      out.items.clear();
      aggregate_names.clear();
      aggregate_case_insensitive.clear();
      seen.clear();
    };

    auto add_function = [&](std::string name, bool is_aggregate, bool case_insensitive, std::string origin) {
      if (name.empty()) return;
      const std::string key = lower_ascii(name);
      if (!seen.insert(key).second) return;
      MetaFunction f;
      f.name = std::move(name);
      f.is_aggregate = is_aggregate;
      f.case_insensitive = case_insensitive;
      f.origin = std::move(origin);
      f.is_user_defined = f.origin == "SQLUserDefined" || f.origin == "ExecutableUserDefined" || f.origin == "WasmUserDefined";
      out.items.push_back(std::move(f));
    };

    auto load_functions_from_system = [&](const std::string& sql, bool with_origin, bool with_create_query) {
      client->Select(sql, [&](const clickhouse::Block& b) {
        if (b.GetRowCount() == 0 || b.GetColumnCount() < 3) return;
        auto col_name = b[0]->As<clickhouse::ColumnString>();
        auto col_agg = b[1]->As<clickhouse::ColumnUInt8>();
        auto col_ci = b[2]->As<clickhouse::ColumnUInt8>();
        if (!col_name || !col_agg || !col_ci) return;
        const size_t n = b.GetRowCount();
        out.items.reserve(out.items.size() + n);
        for (size_t i = 0; i < n; ++i) {
          const std::string_view sv = col_name->At(i);
          std::string name(sv.data(), sv.size());
          const bool is_aggregate = col_agg->At(i) != 0;
          const bool case_insensitive = col_ci->At(i) != 0;
          std::string origin = "System";
          if (with_origin && b.GetColumnCount() >= 4) {
            origin = block_string_at(b, 3, i);
            if (origin.empty()) origin = "System";
          } else if (with_create_query && b.GetColumnCount() >= 4) {
            const std::string create_query = block_string_at(b, 3, i);
            origin = create_query.empty() ? "System" : "SQLUserDefined";
          }
          if (is_aggregate) {
            aggregate_names.push_back(name);
            aggregate_case_insensitive.push_back(case_insensitive);
          }
          add_function(std::move(name), is_aggregate, case_insensitive, std::move(origin));
        }
      });
    };

    auto load_functions_from_show = [&]() {
      client->Select("SHOW FUNCTIONS", [&](const clickhouse::Block& b) {
        if (b.GetRowCount() == 0 || b.GetColumnCount() == 0) return;
        auto col_name = b[0]->As<clickhouse::ColumnString>();
        if (!col_name) return;
        const size_t n = b.GetRowCount();
        out.items.reserve(out.items.size() + n);
        for (size_t i = 0; i < n; ++i) {
          const std::string_view sv = col_name->At(i);
          add_function(std::string(sv.data(), sv.size()), false, false, "System");
        }
      });
    };

    try {
      try {
        // `origin` is the most precise source for user-defined functions.
        // It can be System, SQLUserDefined, ExecutableUserDefined, or WasmUserDefined on recent ClickHouse versions.
        load_functions_from_system("SELECT name, is_aggregate, case_insensitive, toString(origin) AS origin FROM system.functions", true, false);
      } catch (const std::exception&) {
        reset_loaded_functions();
        try {
          // Older versions exposed create_query before origin was available/reliable.
          load_functions_from_system("SELECT name, is_aggregate, case_insensitive, toString(create_query) AS create_query FROM system.functions", false, true);
        } catch (const std::exception&) {
          reset_loaded_functions();
          // Last-resort ACL-friendly fallback. SHOW FUNCTIONS does not expose aggregate/case/origin metadata.
          load_functions_from_show();
        }
      }

      try {
        client->Select("SELECT name FROM system.aggregate_function_combinators WHERE is_internal = 0", [&](const clickhouse::Block& b) {
          if (b.GetRowCount() == 0 || b.GetColumnCount() == 0) return;
          auto col_name = b[0]->As<clickhouse::ColumnString>();
          if (!col_name) return;
          const size_t n = b.GetRowCount();
          combinators.reserve(combinators.size() + n);
          for (size_t i = 0; i < n; ++i) {
            const std::string_view sv = col_name->At(i);
            std::string name(sv.data(), sv.size());
            if (!name.empty()) combinators.push_back(std::move(name));
          }
        });
      } catch (const std::exception&) {
        // Fallback only for old/restricted servers. Keep it conservative.
        combinators = {"If", "Array", "Map", "ForEach", "Distinct", "State", "Merge", "MergeState", "SimpleState", "OrNull", "OrDefault", "Resample"};
      }

      for (size_t i = 0; i < aggregate_names.size(); ++i) {
        const std::string& base = aggregate_names[i];
        const bool ci = i < aggregate_case_insensitive.size() ? aggregate_case_insensitive[i] : false;
        for (const std::string& combinator : combinators) {
          add_function(base + combinator, true, ci, "System");
        }
      }

      std::sort(out.items.begin(), out.items.end(), [](const MetaFunction& a, const MetaFunction& b) {
        const int ci = compare_ascii_ci(a.name, b.name);
        if (ci != 0) return ci < 0;
        return a.name < b.name;
      });
    } catch (const std::exception& e) {
      err_code = "clickhouse_error";
      err_msg = e.what();
      return false;
    }

    return true;
  };

  auto fetch_catalog = [&](const std::string& type, MetaCatalog& out, std::string& err_code, std::string& err_msg) -> bool {
    out.updated_at_ms = ts_ms;

    auto client_result = make_client();
    auto client = std::move(client_result.first);
    std::string err = std::move(client_result.second);
    if (!client) {
      err_code = "clickhouse_connect";
      err_msg = err;
      return false;
    }

    auto fetch_databases_acl = [&]() -> std::vector<std::string> {
      std::vector<std::string> databases;
      client->Select("SHOW DATABASES", [&](const clickhouse::Block& b) {
        if (b.GetRowCount() == 0 || b.GetColumnCount() == 0) return;
        auto col = b[0]->As<clickhouse::ColumnString>();
        if (!col) return;
        const size_t n = b.GetRowCount();
        databases.reserve(databases.size() + n);
        for (size_t i = 0; i < n; ++i) {
          const std::string_view sv = col->At(i);
          std::string db(sv.data(), sv.size());
          if (!db.empty() && !is_system_info_database(db)) databases.push_back(std::move(db));
        }
      });
      std::sort(databases.begin(), databases.end(), [](const std::string& a, const std::string& b) {
        const int ci = compare_ascii_ci(a, b);
        return ci != 0 ? ci < 0 : a < b;
      });
      databases.erase(std::unique(databases.begin(), databases.end()), databases.end());
      return databases;
    };

    auto fetch_tables_for_database = [&](const std::string& database) -> std::vector<MetaCatalogItem> {
      std::vector<MetaCatalogItem> tables;
      const std::string dbq = quote_ident(database);
      bool loaded = false;

      try {
        client->Select("SHOW FULL TABLES FROM " + dbq, [&](const clickhouse::Block& b) {
          const size_t n = b.GetRowCount();
          if (!n || b.GetColumnCount() == 0) return;
          loaded = true;
          tables.reserve(tables.size() + n);
          for (size_t i = 0; i < n; ++i) {
            MetaCatalogItem item;
            item.database = database;
            item.name = block_string_at(b, 0, i);
            if (b.GetColumnCount() >= 2) item.detail = block_string_at(b, 1, i);
            if (!item.name.empty()) tables.push_back(std::move(item));
          }
        });
      } catch (const std::exception&) {
        tables.clear();
      }

      if (!loaded) {
        client->Select("SHOW TABLES FROM " + dbq, [&](const clickhouse::Block& b) {
          const size_t n = b.GetRowCount();
          if (!n || b.GetColumnCount() == 0) return;
          tables.reserve(tables.size() + n);
          for (size_t i = 0; i < n; ++i) {
            MetaCatalogItem item;
            item.database = database;
            item.name = block_string_at(b, 0, i);
            if (!item.name.empty()) tables.push_back(std::move(item));
          }
        });
      }

      std::sort(tables.begin(), tables.end(), [](const MetaCatalogItem& a, const MetaCatalogItem& b) {
        const int ci = compare_ascii_ci(a.name, b.name);
        return ci != 0 ? ci < 0 : a.name < b.name;
      });
      return tables;
    };

    auto fetch_all_tables_acl = [&]() -> std::vector<MetaCatalogItem> {
      std::vector<MetaCatalogItem> tables;
      const auto databases = fetch_databases_acl();
      for (const auto& db : databases) {
        try {
          auto db_tables = fetch_tables_for_database(db);
          tables.insert(tables.end(), std::make_move_iterator(db_tables.begin()), std::make_move_iterator(db_tables.end()));
        } catch (const std::exception&) {
          // Ignore databases the current ClickHouse user cannot inspect.
        }
      }
      std::sort(tables.begin(), tables.end(), [](const MetaCatalogItem& a, const MetaCatalogItem& b) {
        int ci = compare_ascii_ci(a.database, b.database);
        if (ci != 0) return ci < 0;
        if (a.database != b.database) return a.database < b.database;
        ci = compare_ascii_ci(a.name, b.name);
        return ci != 0 ? ci < 0 : a.name < b.name;
      });
      return tables;
    };

    auto fetch_all_tables_system = [&]() -> std::optional<std::vector<MetaCatalogItem>> {
      std::vector<MetaCatalogItem> tables;
      try {
        client->Select(
          "SELECT database, name, engine "
          "FROM system.tables "
          "WHERE database NOT IN ('INFORMATION_SCHEMA', 'information_schema') "
          "ORDER BY lower(database), database, lower(name), name",
          [&](const clickhouse::Block& b) {
            const size_t n = b.GetRowCount();
            if (!n || b.GetColumnCount() < 2) return;
            tables.reserve(tables.size() + n);
            for (size_t i = 0; i < n; ++i) {
              MetaCatalogItem item;
              item.database = block_string_at(b, 0, i);
              item.name = block_string_at(b, 1, i);
              if (b.GetColumnCount() >= 3) item.detail = block_string_at(b, 2, i);
              if (!item.database.empty() && !item.name.empty()) tables.push_back(std::move(item));
            }
          }
        );
      } catch (const std::exception&) {
        return std::nullopt;
      }
      return tables;
    };

    auto fetch_all_columns_system = [&]() -> std::optional<std::vector<MetaCatalogItem>> {
      std::vector<MetaCatalogItem> columns;
      try {
        client->Select(
          "SELECT database, `table`, name, type "
          "FROM system.columns "
          "WHERE database NOT IN ('INFORMATION_SCHEMA', 'information_schema') "
          "ORDER BY lower(database), database, lower(table), table, lower(name), name",
          [&](const clickhouse::Block& b) {
            const size_t n = b.GetRowCount();
            if (!n || b.GetColumnCount() < 4) return;
            columns.reserve(columns.size() + n);
            for (size_t i = 0; i < n; ++i) {
              MetaCatalogItem item;
              item.database = block_string_at(b, 0, i);
              item.table = block_string_at(b, 1, i);
              item.name = block_string_at(b, 2, i);
              item.type = block_string_at(b, 3, i);
              if (!item.database.empty() && !item.table.empty() && !item.name.empty()) {
                columns.push_back(std::move(item));
              }
            }
          }
        );
      } catch (const std::exception&) {
        return std::nullopt;
      }
      return columns;
    };

    auto fetch_scoped_columns_system = [&]() -> std::optional<std::vector<MetaCatalogItem>> {
      std::vector<MetaCatalogItem> columns;
      try {
        clickhouse::Query query(
          "SELECT database, `table`, name, type "
          "FROM system.columns "
          "WHERE database = {database:String} AND `table` = {table:String} "
          "ORDER BY lower(name), name"
        );
        query.SetParam("database", column_database);
        query.SetParam("table", column_table);
        query.OnData([&](const clickhouse::Block& block) {
          const size_t row_count = block.GetRowCount();
          if (!row_count || block.GetColumnCount() < 4) return;
          columns.reserve(columns.size() + row_count);
          for (size_t row = 0; row < row_count; ++row) {
            MetaCatalogItem item;
            item.database = block_string_at(block, 0, row);
            item.table = block_string_at(block, 1, row);
            item.name = block_string_at(block, 2, row);
            item.type = block_string_at(block, 3, row);
            if (!item.name.empty()) columns.push_back(std::move(item));
          }
        });
        client->Select(query);
      } catch (const std::exception&) {
        return std::nullopt;
      }
      return columns;
    };

    auto describe_table_acl = [&](const MetaCatalogItem& table) -> std::vector<MetaCatalogItem> {
      std::vector<MetaCatalogItem> columns;
      const std::string table_ref = qualified_ident(table.database, table.name);
      auto load = [&](const std::string& sql) {
        client->Select(sql, [&](const clickhouse::Block& b) {
          const size_t n = b.GetRowCount();
          if (!n || b.GetColumnCount() < 2) return;
          columns.reserve(columns.size() + n);
          for (size_t i = 0; i < n; ++i) {
            MetaCatalogItem item;
            item.database = table.database;
            item.table = table.name;
            item.name = block_string_at(b, 0, i);
            item.type = block_string_at(b, 1, i);
            if (b.GetColumnCount() >= 8 && block_truthy_at(b, 7, i)) item.detail = "subcolumn";
            if (!item.name.empty()) columns.push_back(std::move(item));
          }
        });
      };

      try {
        load("DESCRIBE TABLE " + table_ref + " SETTINGS describe_include_subcolumns = 1");
      } catch (const std::exception&) {
        columns.clear();
        load("DESCRIBE TABLE " + table_ref);
      }

      return columns;
    };

    try {
      if (type == "databases") {
        const auto databases = fetch_databases_acl();
        out.items.reserve(databases.size());
        for (const auto& db : databases) {
          MetaCatalogItem item;
          item.name = db;
          out.items.push_back(std::move(item));
        }
      } else if (type == "tables") {
        if (auto fast_tables = fetch_all_tables_system(); fast_tables.has_value()) {
          out.items = std::move(*fast_tables);
        } else {
          out.items = fetch_all_tables_acl();
        }
      } else if (type == "columns") {
        if (scoped_columns) {
          if (auto fast_columns = fetch_scoped_columns_system(); fast_columns.has_value()) {
            out.items = std::move(*fast_columns);
          } else {
            MetaCatalogItem table;
            table.database = column_database;
            table.name = column_table;
            out.items = describe_table_acl(table);
          }
        } else if (auto fast_columns = fetch_all_columns_system(); fast_columns.has_value()) {
          out.items = std::move(*fast_columns);
        } else {
          const auto tables = fetch_all_tables_acl();
          for (const auto& table : tables) {
            try {
              auto cols = describe_table_acl(table);
              out.items.insert(out.items.end(), std::make_move_iterator(cols.begin()), std::make_move_iterator(cols.end()));
            } catch (const std::exception&) {
              // Table can be visible through SHOW but not DESCRIBE-able for this user; skip it.
            }
          }
        }
      } else {
        std::string sql;
        if (type == "table_functions") {
          sql = "SELECT name FROM system.table_functions ORDER BY lower(name), name";
        } else if (type == "formats") {
          sql = "SELECT name FROM system.formats ORDER BY lower(name), name";
        } else if (type == "settings") {
          sql = "SELECT name, type FROM system.settings ORDER BY lower(name), name";
        } else if (type == "data_types") {
          sql = "SELECT name, alias_to FROM system.data_type_families ORDER BY lower(name), name";
        } else {
          err_code = "unsupported_type";
          err_msg = "unsupported type";
          return false;
        }

        client->Select(sql, [&](const clickhouse::Block& b) {
          const size_t n = b.GetRowCount();
          if (!n) return;
          out.items.reserve(out.items.size() + n);
          for (size_t i = 0; i < n; ++i) {
            MetaCatalogItem item;
            if (type == "settings") {
              item.name = block_string_at(b, 0, i);
              item.type = block_string_at(b, 1, i);
            } else if (type == "data_types") {
              item.name = block_string_at(b, 0, i);
              if (b.GetColumnCount() >= 2) item.parent = block_string_at(b, 1, i);
            } else {
              item.name = block_string_at(b, 0, i);
            }
            if (!item.name.empty()) out.items.push_back(std::move(item));
          }
        });
      }

      std::sort(out.items.begin(), out.items.end(), [](const MetaCatalogItem& a, const MetaCatalogItem& b) {
        int ci = compare_ascii_ci(a.database, b.database);
        if (ci != 0) return ci < 0;
        if (a.database != b.database) return a.database < b.database;

        ci = compare_ascii_ci(a.table, b.table);
        if (ci != 0) return ci < 0;
        if (a.table != b.table) return a.table < b.table;

        ci = compare_ascii_ci(a.name, b.name);
        if (ci != 0) return ci < 0;
        return a.name < b.name;
      });
    } catch (const std::exception& e) {
      err_code = "clickhouse_error";
      err_msg = e.what();
      return false;
    }

    return true;
  };

  auto write_catalog = [&](const std::string& type, const MetaCatalog& cat, bool stale) {
    w.Key(type.c_str());
    w.StartObject();
    w.Key("updated_at_ms"); w.Uint64(cat.updated_at_ms);
    if (stale) {
      w.Key("stale"); w.Bool(true);
    }
    w.Key("items");
    w.StartArray();
    for (const auto& item : cat.items) {
      w.StartObject();
      w.Key("name"); w.String(item.name.c_str());
      if (!item.database.empty()) { w.Key("database"); w.String(item.database.c_str()); }
      if (!item.table.empty()) { w.Key("table"); w.String(item.table.c_str()); }
      if (!item.type.empty()) { w.Key("type"); w.String(item.type.c_str()); }
      if (!item.detail.empty()) { w.Key("detail"); w.String(item.detail.c_str()); }
      if (!item.parent.empty()) { w.Key("parent"); w.String(item.parent.c_str()); }
      w.EndObject();
    }
    w.EndArray();
    w.EndObject();
  };

  const std::unordered_set<std::string> catalog_types = {
      "databases", "tables", "columns", "table_functions", "formats", "settings", "data_types"};

  for (const auto& t : types) {
    if (t == "keywords") {
      auto r = meta_keywords_cache_.get_or_refresh(host_id, ts_ms, ttl_ms, 5000, fetch_keywords);
      if (!r.has_value) {
        errors.push_back({"keywords", r.error_code.empty() ? "clickhouse_error" : r.error_code, r.error_message, false});
        continue;
      }
      if (r.had_error) errors.push_back({"keywords", r.error_code, r.error_message, true});
      w.Key("keywords");
      w.StartObject();
      w.Key("updated_at_ms"); w.Uint64(r.value->updated_at_ms);
      if (r.stale) w.Key("stale");
      if (r.stale) w.Bool(true);
      w.Key("items");
      w.StartArray();
      for (const auto& kw : r.value->items) w.String(kw.c_str());
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
      if (r.had_error) errors.push_back({"functions", r.error_code, r.error_message, true});
      w.Key("functions");
      w.StartObject();
      w.Key("updated_at_ms"); w.Uint64(r.value->updated_at_ms);
      if (r.stale) {
        w.Key("stale"); w.Bool(true);
      }
      w.Key("items");
      w.StartArray();
      for (const auto& fn : r.value->items) {
        w.StartObject();
        w.Key("name"); w.String(fn.name.c_str());
        w.Key("is_aggregate"); w.Bool(fn.is_aggregate);
        w.Key("case_insensitive"); w.Bool(fn.case_insensitive);
        w.Key("is_user_defined"); w.Bool(fn.is_user_defined);
        if (!fn.origin.empty()) { w.Key("origin"); w.String(fn.origin.c_str()); }
        w.EndObject();
      }
      w.EndArray();
      w.EndObject();
      continue;
    }

    if (catalog_types.find(t) != catalog_types.end()) {
      std::string cache_key = host_id + "::" + t;
      if (t == "columns" && scoped_columns) {
        cache_key += "::" + column_database + "::" + column_table;
      }
      auto fetch = [&](MetaCatalog& out, std::string& err_code, std::string& err_msg) -> bool {
        return fetch_catalog(t, out, err_code, err_msg);
      };
      auto r = meta_catalog_cache_.get_or_refresh(cache_key, ts_ms, ttl_ms, 5000, fetch);
      if (!r.has_value) {
        errors.push_back({t, r.error_code.empty() ? "clickhouse_error" : r.error_code, r.error_message, false});
        continue;
      }
      if (r.had_error) errors.push_back({t, r.error_code, r.error_message, true});
      write_catalog(t, *r.value, r.stale);
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
      res.set_content(sb.GetString(), sb.GetSize(), "application/json");
      return;
    }
  }

  res.status = 200;
  res.set_content(sb.GetString(), sb.GetSize(), "application/json");
}

} // namespace chdash
