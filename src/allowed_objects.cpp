#include "allowed_objects.hpp"

#include "ch_block_numeric.hpp"
#include "ch_block_value.hpp"
#include "ch_client_pool.hpp"
#include "ch_executor.hpp"
#include "sql_literal.hpp"

#include <algorithm>
#include <cstdint>
#include <exception>
#include <optional>
#include <stdexcept>
#include <string_view>
#include <utility>

namespace chdash {
namespace {

using sql::quote_ident;

constexpr int kAccessDenied = 497;
// An answer keeps at most this many issues. The issues explain a gap. They are not a listing.
constexpr size_t kMaxIssues = 64;

std::string qualified_ident(std::string_view database, std::string_view table) {
  return quote_ident(database) + "." + quote_ident(table);
}

bool block_bool_at(const clickhouse::Block& block, size_t column, size_t row, bool* ok) {
  if (ok) *ok = false;
  if (column >= block.GetColumnCount() || row >= block.GetRowCount()) return false;

  bool flag_ok = false;
  const bool flag = ch_column_flag_at(block[column], row, &flag_ok);
  if (flag_ok) {
    if (ok) *ok = true;
    return flag;
  }
  if (auto values = block[column]->As<clickhouse::ColumnUInt64>()) {
    if (ok) *ok = true;
    return values->At(row) != 0;
  }
  if (auto values = block[column]->As<clickhouse::ColumnInt8>()) {
    if (ok) *ok = true;
    return values->At(row) != 0;
  }
  if (auto values = block[column]->As<clickhouse::ColumnString>()) {
    const std::string_view value = values->At(row);
    if (ok) *ok = true;
    return value == "1" || value == "true" || value == "TRUE" || value == "granted";
  }
  return false;
}

// CHECK GRANT on a connection. Returns nullopt when no row could be read.
std::optional<bool> select_check_grant(ChExecutor& db, const std::string& expression) {
  bool seen = false;
  bool granted = false;
  db.select("CHECK GRANT " + expression, [&](const clickhouse::Block& block) {
    if (seen || block.GetRowCount() == 0 || block.GetColumnCount() == 0) return;
    bool parsed = false;
    const bool value = block_bool_at(block, 0, 0, &parsed);
    if (!parsed) return;
    seen = true;
    granted = value;
  });
  if (!seen) return std::nullopt;
  return granted;
}

std::optional<bool> select_check_grant(clickhouse::Client& client, const std::string& expression) {
  BorrowedExecutor db(client);
  return select_check_grant(db, expression);
}

std::vector<std::string> select_names(clickhouse::Client& client, const std::string& sql) {
  std::vector<std::string> names;
  ch_select(client, sql, [&](const clickhouse::Block& block) {
    names.reserve(names.size() + block.GetRowCount());
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      auto name = ch_block_text_at(block, 0, row);
      if (!name.empty()) names.push_back(std::move(name));
    }
  });
  return names;
}

void sort_unique(std::vector<std::string>& names) {
  std::sort(names.begin(), names.end());
  names.erase(std::unique(names.begin(), names.end()), names.end());
}

class ClientAclSource final : public AclSource {
public:
  ClientAclSource(std::shared_ptr<clickhouse::Client> client, std::shared_ptr<ClickHouseClientPool> pool)
      : client_(std::move(client)), pool_(std::move(pool)) {}

  std::vector<std::string> show_databases() override {
    return guarded([&] {
      auto names = select_names(*client_, "SHOW DATABASES");
      sort_unique(names);
      return names;
    });
  }

  std::vector<std::string> show_objects(const std::string& database) override {
    auto names = guarded([&] { return select_names(*client_, "SHOW TABLES FROM " + quote_ident(database)); });
    // SHOW DICTIONARIES reads system.dictionaries.
    // A runner limited to a few databases (SHOW and SELECT on those only) has no grant on it. ClickHouse returns ACCESS_DENIED.
    // Such a runner sees no dictionary in the list, except the ones that SHOW TABLES already returns.
    // Any other error is a real failure.
    try {
      auto dictionaries = guarded([&] { return select_names(*client_, "SHOW DICTIONARIES FROM " + quote_ident(database)); });
      names.insert(names.end(), dictionaries.begin(), dictionaries.end());
    } catch (const AclDenied&) {
    }
    sort_unique(names);
    return names;
  }

  std::optional<bool> check_grant(const std::string& expression) override {
    if (check_grant_unreadable_) return std::nullopt;
    try {
      return select_check_grant(*client_, expression);
    } catch (const clickhouse::ServerException&) {
      // Some servers do not know this form of CHECK GRANT. The probes decide.
      return std::nullopt;
    } catch (const clickhouse::Error&) {
      // Some ClickHouse and clickhouse-cpp combinations cannot decode the CHECK GRANT answer. The answer has an unknown packet type.
      // The connection is then out of step. This source opens it again and stops asking CHECK GRANT.
      // If the connection cannot be opened again, the server is gone. That is a transport error.
      try {
        client_->ResetConnection();
      } catch (...) {
        if (pool_) pool_->invalidate(client_);
        throw;
      }
      check_grant_unreadable_ = true;
      return std::nullopt;
    } catch (...) {
      if (pool_) pool_->invalidate(client_);
      throw;
    }
  }

  void probe(const std::string& sql) override {
    guarded([&] {
      ch_select(*client_, sql, [](const clickhouse::Block&) {});
      return 0;
    });
  }

  std::vector<std::string> describe_columns(const std::string& database, const std::string& table) override {
    return guarded([&] {
      auto names = select_names(*client_, "DESCRIBE TABLE " + qualified_ident(database, table) +
                                              " SETTINGS describe_include_subcolumns = 0");
      sort_unique(names);
      return names;
    });
  }

private:
  // ACCESS_DENIED is the only "no". Another server error is about the object.
  // Anything else is a transport error. The connection is not given back to the pool.
  template <typename Fn>
  auto guarded(Fn&& fn) -> decltype(fn()) {
    try {
      return fn();
    } catch (const clickhouse::ServerException& error) {
      if (error.GetCode() == kAccessDenied) throw AclDenied(error.what());
      throw AclObjectError(error.GetCode(), error.what());
    } catch (...) {
      if (pool_) pool_->invalidate(client_);
      throw;
    }
  }

  std::shared_ptr<clickhouse::Client> client_;
  std::shared_ptr<ClickHouseClientPool> pool_;
  bool check_grant_unreadable_ = false;
};

void add_issue(std::vector<AclIssue>& issues, const std::string& database, const std::string& object, const AclObjectError& error) {
  if (issues.size() < kMaxIssues) issues.push_back(AclIssue{database, object, error.code, error.what()});
}

std::string select_columns_expression(
    const std::string& database,
    const std::string& table,
    const std::vector<std::string>& columns,
    size_t begin,
    size_t end) {
  std::string out = "SELECT(";
  for (size_t i = begin; i < end; ++i) {
    if (i != begin) out += ", ";
    out += quote_ident(columns[i]);
  }
  out += ") ON ";
  out += qualified_ident(database, table);
  return out;
}

// A LIMIT 0 projection is an exact permission probe. ClickHouse checks every referenced column and reads no data.
bool zero_row_column_probe(
    AclSource& source,
    const std::string& database,
    const std::string& table,
    const std::vector<std::string>& columns,
    size_t begin,
    size_t end) {
  if (begin >= end) return false;
  std::string sql = "SELECT ignore(";
  for (size_t i = begin; i < end; ++i) {
    if (i != begin) sql += ", ";
    sql += quote_ident(columns[i]);
  }
  sql += ") FROM " + qualified_ident(database, table) + " LIMIT 0";
  try {
    source.probe(sql);
    return true;
  } catch (const AclDenied&) {
    return false;
  }
}

void discover_columns_recursive(
    AclSource& source,
    const std::string& database,
    const std::string& table,
    const std::vector<std::string>& columns,
    size_t begin,
    size_t end,
    std::unordered_set<std::string>& allowed) {
  if (begin >= end) return;

  const auto checked = source.check_grant(select_columns_expression(database, table, columns, begin, end));
  const bool granted = checked ? *checked : zero_row_column_probe(source, database, table, columns, begin, end);
  if (granted) {
    for (size_t i = begin; i < end; ++i) allowed.insert(columns[i]);
    return;
  }

  if (end - begin == 1) return;
  const size_t middle = begin + (end - begin) / 2;
  discover_columns_recursive(source, database, table, columns, begin, middle, allowed);
  discover_columns_recursive(source, database, table, columns, middle, end, allowed);
}

AllowedTable inspect_table(AclSource& source, const std::string& database, const std::string& table) {
  AllowedTable result;
  result.database = database;
  result.table = table;

  const auto full = source.check_grant("SELECT ON " + qualified_ident(database, table));
  if (full && *full) {
    result.all_columns = true;
    return result;
  }

  std::vector<std::string> columns;
  try {
    columns = source.describe_columns(database, table);
  } catch (const AclDenied&) {
    return result;
  }
  if (columns.empty()) return result;
  if (!full && zero_row_column_probe(source, database, table, columns, 0, columns.size())) {
    result.all_columns = true;
    return result;
  }

  // Keep each CHECK GRANT statement bounded for very wide schemas.
  // A fully granted chunk becomes one check. A denied chunk is split until
  // the exact readable columns are known.
  constexpr size_t kChunkColumns = 64;
  for (size_t begin = 0; begin < columns.size(); begin += kChunkColumns) {
    const size_t end = std::min(columns.size(), begin + kChunkColumns);
    discover_columns_recursive(source, database, table, columns, begin, end, result.columns);
  }
  result.partial = !result.columns.empty();
  return result;
}

} // namespace

bool explorer_schema_visible(const std::string& database) {
  // INFORMATION_SCHEMA is a compatibility surface. It is not an Explorer object namespace.
  // system.tables is read without these schemas. So the ACL boundary leaves them out too.
  return database != "INFORMATION_SCHEMA" && database != "information_schema";
}

std::unique_ptr<AclSource> make_acl_source(std::shared_ptr<clickhouse::Client> client, std::shared_ptr<ClickHouseClientPool> pool) {
  return std::make_unique<ClientAclSource>(std::move(client), std::move(pool));
}

bool check_grant_expression(clickhouse::Client& client, const std::string& expression, bool* decoded) {
  const auto answer = select_check_grant(client, expression);
  if (decoded) *decoded = answer.has_value();
  return answer.value_or(false);
}

std::optional<std::string> missing_select_grant(ChExecutor& db, const std::string& database, const std::string& table) {
  try {
    const auto answer = select_check_grant(db, "SELECT ON " + qualified_ident(database, table));
    if (!answer || *answer) return std::nullopt;
    return "SELECT ON " + database + "." + table;
  } catch (const std::exception&) {
    return std::nullopt;
  }
}

std::optional<std::string> missing_select_grant(clickhouse::Client& client, const std::string& database, const std::string& table) {
  BorrowedExecutor db(client);
  return missing_select_grant(db, database, table);
}

std::string AllowedObjectSet::table_key(const std::string& database, const std::string& table) {
  std::string key;
  key.reserve(database.size() + table.size() + 1);
  key += database;
  key.push_back('\0');
  key += table;
  return key;
}

bool AllowedObjectSet::allows_database(const std::string& database) const {
  return database_index_.count(database) != 0;
}

bool AllowedObjectSet::allows_table(const std::string& database, const std::string& table) const {
  return table_index_.count(table_key(database, table)) != 0;
}

bool AllowedObjectSet::allows_column(
    const std::string& database,
    const std::string& table,
    const std::string& column) const {
  const auto it = table_index_.find(table_key(database, table));
  if (it == table_index_.end()) return false;
  const auto& entry = tables_[it->second];
  return entry.all_columns || entry.columns.count(column) != 0;
}

void AllowedObjectSet::add_table(AllowedTable table) {
  if (table.database.empty() || table.table.empty()) return;
  if (!table.all_columns && !table.partial && table.columns.empty()) return;

  if (database_index_.insert(table.database).second) databases_.push_back(table.database);
  const std::string key = table_key(table.database, table.table);
  const auto it = table_index_.find(key);
  if (it == table_index_.end()) {
    table_index_.emplace(key, tables_.size());
    tables_.push_back(std::move(table));
  } else {
    tables_[it->second] = std::move(table);
  }
}

size_t AllowedObjectSet::approx_bytes() const {
  size_t bytes = sizeof(*this);
  for (const auto& database : databases_) bytes += 2 * (sizeof(std::string) + database.size()) + 16;
  for (const auto& table : tables_) {
    bytes += sizeof(AllowedTable) + 2 * (table.database.size() + table.table.size()) + sizeof(std::string) + 32;
    for (const auto& column : table.columns) bytes += sizeof(std::string) + column.size() + 16;
  }
  return bytes;
}

size_t AclDatabases::approx_bytes() const {
  size_t bytes = sizeof(*this);
  for (const auto& name : databases) bytes += sizeof(std::string) + name.size();
  for (const auto& name : unverified) bytes += sizeof(std::string) + name.size();
  for (const auto& issue : issues) bytes += sizeof(AclIssue) + issue.database.size() + issue.object.size() + issue.message.size();
  return bytes;
}

bool AclObjects::contains(const std::string& table) const {
  const auto it = std::lower_bound(objects.begin(), objects.end(), table,
                                   [](const AllowedTable& entry, const std::string& name) { return entry.table < name; });
  return it != objects.end() && it->table == table;
}

size_t AclObjects::approx_bytes() const {
  size_t bytes = sizeof(*this);
  for (const auto& object : objects) bytes += sizeof(AllowedTable) + object.database.size() + object.table.size();
  for (const auto& issue : issues) bytes += sizeof(AclIssue) + issue.database.size() + issue.object.size() + issue.message.size();
  return bytes;
}

std::optional<AllowedTable> check_table_access(AclSource& source, const std::string& database, const std::string& table) {
  const std::string target = qualified_ident(database, table);
  AllowedTable out;
  out.database = database;
  out.table = table;
  const auto granted = source.check_grant("SELECT ON " + target);
  if (granted && *granted) {
    out.all_columns = true;
    return out;
  }
  // No SELECT on the whole table. ClickHouse is asked directly whether the identity reads any column.
  // A zero-row SELECT reads nothing. It is refused (ACCESS_DENIED) without a column grant. The decision is ClickHouse's.
  try {
    source.probe("SELECT 1 FROM " + target + " LIMIT 0");
  } catch (const AclDenied&) {
    return std::nullopt;
  }
  if (granted) {
    out.partial = true;
    return out;
  }
  // CHECK GRANT could not be read. A zero-row SELECT of every column shows a whole grant or a partial grant.
  std::vector<std::string> columns;
  try {
    columns = source.describe_columns(database, table);
  } catch (const AclDenied&) {
  }
  out.all_columns = !columns.empty() && zero_row_column_probe(source, database, table, columns, 0, columns.size());
  out.partial = !out.all_columns;
  return out;
}

AclObjects discover_objects(AclSource& source, const std::string& database, AclBudget& budget) {
  AclObjects out;
  if (!explorer_schema_visible(database) || database.empty()) return out;
  std::vector<std::string> names;
  try {
    names = source.show_objects(database);
  } catch (const AclDenied&) {
    return out;
  } catch (const AclObjectError& error) {
    add_issue(out.issues, database, {}, error);
    return out;
  }
  // One database-wide CHECK GRANT replaces one check per object. Use it when the identity reads the whole database.
  // The check is exact. A partial REVOKE on a table or a column inside the database makes it answer 0.
  const auto whole = source.check_grant("SELECT ON " + quote_ident(database) + ".*");
  if (whole && *whole) {
    out.objects.reserve(names.size());
    for (const auto& name : names) {
      AllowedTable entry;
      entry.database = database;
      entry.table = name;
      entry.all_columns = true;
      out.objects.push_back(std::move(entry));
    }
    return out;
  }
  for (const auto& name : names) {
    if (budget.spent()) {
      out.truncated = true;
      break;
    }
    ++budget.used;
    try {
      if (auto entry = check_table_access(source, database, name)) out.objects.push_back(std::move(*entry));
    } catch (const AclObjectError& error) {
      add_issue(out.issues, database, name, error);
    }
  }
  return out;
}

AclDatabases discover_databases(AclSource& source, AclBudget& budget) {
  AclDatabases out;
  for (const auto& database : source.show_databases()) {
    if (!explorer_schema_visible(database)) continue;
    if (budget.spent()) {
      out.unverified.push_back(database);
      out.truncated = true;
      continue;
    }
    const auto whole = source.check_grant("SELECT ON " + quote_ident(database) + ".*");
    if (whole && *whole) {
      out.databases.push_back(database);
      continue;
    }
    std::vector<std::string> names;
    try {
      names = source.show_objects(database);
    } catch (const AclDenied&) {
      continue;
    } catch (const AclObjectError& error) {
      add_issue(out.issues, database, {}, error);
      continue;
    }
    // The first readable object decides. A database that the budget did not reach is not hidden.
    // It is reported as unverified. Its name is what SHOW DATABASES gives the identity anyway.
    bool readable = false;
    bool decided = true;
    size_t probed = 0;
    for (const auto& name : names) {
      if (budget.spent() || probed >= budget.max_objects_per_database) {
        decided = false;
        break;
      }
      ++probed;
      ++budget.used;
      try {
        if (check_table_access(source, database, name)) {
          readable = true;
          break;
        }
      } catch (const AclObjectError& error) {
        add_issue(out.issues, database, name, error);
      }
    }
    if (readable) {
      out.databases.push_back(database);
    } else if (!decided) {
      out.unverified.push_back(database);
      out.truncated = true;
    }
  }
  sort_unique(out.databases);
  sort_unique(out.unverified);
  return out;
}

std::optional<AllowedTable> discover_allowed_table(AclSource& source, const std::string& database, const std::string& table) {
  if (!explorer_schema_visible(database) || database.empty() || table.empty()) return std::nullopt;
  std::vector<std::string> objects;
  try {
    objects = source.show_objects(database);
  } catch (const AclDenied&) {
    return std::nullopt;
  } catch (const AclObjectError& error) {
    constexpr int kUnknownDatabase = 81;
    if (error.code == kUnknownDatabase) return std::nullopt;
    throw;
  }
  if (!std::binary_search(objects.begin(), objects.end(), table)) return std::nullopt;
  auto entry = inspect_table(source, database, table);
  if (!entry.all_columns && entry.columns.empty()) return std::nullopt;
  return entry;
}

std::optional<AllowedTable> discover_allowed_table(clickhouse::Client& runner, const std::string& database, const std::string& table) {
  // The caller owns the connection. The pointer does not own it, and there is no pool to give it back to.
  std::shared_ptr<clickhouse::Client> client(&runner, [](clickhouse::Client*) {});
  ClientAclSource source(std::move(client), nullptr);
  return discover_allowed_table(source, database, table);
}

} // namespace chdash
