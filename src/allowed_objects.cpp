#include "allowed_objects.hpp"
#include "ch_block_value.hpp"

#include <algorithm>
#include <cstdint>
#include <exception>
#include <stdexcept>
#include <string_view>
#include <optional>
#include <cctype>
#include <utility>

namespace chdash {
namespace {

std::string quote_ident(std::string_view ident) {
  std::string out;
  out.reserve(ident.size() + 2);
  out.push_back('`');
  for (const char ch : ident) {
    if (ch == '`') out += "``";
    else out.push_back(ch);
  }
  out.push_back('`');
  return out;
}

std::string qualified_ident(std::string_view database, std::string_view table) {
  return quote_ident(database) + "." + quote_ident(table);
}

bool explorer_schema_visible(std::string_view database) {
  return database != "INFORMATION_SCHEMA" && database != "information_schema";
}

std::string block_string_at(const clickhouse::Block& block, size_t column, size_t row) {
  return ch_block_text_at(block, column, row);
}

bool block_bool_at(const clickhouse::Block& block, size_t column, size_t row, bool* ok) {
  if (ok) *ok = false;
  if (column >= block.GetColumnCount() || row >= block.GetRowCount()) return false;

  if (auto values = block[column]->As<clickhouse::ColumnUInt8>()) {
    if (ok) *ok = true;
    return values->At(row) != 0;
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

bool check_grant(clickhouse::Client& runner, const std::string& expression) {
  bool seen = false;
  bool granted = false;
  runner.Select("CHECK GRANT " + expression, [&](const clickhouse::Block& block) {
    if (seen || block.GetRowCount() == 0 || block.GetColumnCount() == 0) return;
    bool parsed = false;
    const bool value = block_bool_at(block, 0, 0, &parsed);
    if (!parsed) return;
    seen = true;
    granted = value;
  });
  return seen && granted;
}


bool is_access_denied_message(const std::string& message) {
  std::string lower;
  lower.reserve(message.size());
  for (const char ch : message) lower.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(ch))));
  return lower.find("not enough privileges") != std::string::npos ||
      lower.find("access denied") != std::string::npos ||
      lower.find("permission denied") != std::string::npos ||
      lower.find("insufficient privileges") != std::string::npos;
}

bool zero_row_column_probe(
    clickhouse::Client& runner,
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
    runner.Select(sql, [](const clickhouse::Block&) {});
    return true;
  } catch (const std::exception& e) {
    if (is_access_denied_message(e.what())) return false;
    throw;
  }
}

std::vector<std::string> show_databases(clickhouse::Client& runner) {
  std::vector<std::string> databases;
  runner.Select("SHOW DATABASES", [&](const clickhouse::Block& block) {
    databases.reserve(databases.size() + block.GetRowCount());
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      auto name = block_string_at(block, 0, row);
      if (!name.empty()) databases.push_back(std::move(name));
    }
  });
  std::sort(databases.begin(), databases.end());
  databases.erase(std::unique(databases.begin(), databases.end()), databases.end());
  return databases;
}

std::vector<std::string> show_tables(clickhouse::Client& runner, const std::string& database) {
  std::vector<std::string> tables;
  runner.Select("SHOW TABLES FROM " + quote_ident(database), [&](const clickhouse::Block& block) {
    tables.reserve(tables.size() + block.GetRowCount());
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      auto name = block_string_at(block, 0, row);
      if (!name.empty()) tables.push_back(std::move(name));
    }
  });
  std::sort(tables.begin(), tables.end());
  tables.erase(std::unique(tables.begin(), tables.end()), tables.end());
  return tables;
}

std::vector<std::string> show_dictionaries(clickhouse::Client& runner, const std::string& database) {
  std::vector<std::string> dictionaries;
  runner.Select("SHOW DICTIONARIES FROM " + quote_ident(database), [&](const clickhouse::Block& block) {
    dictionaries.reserve(dictionaries.size() + block.GetRowCount());
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      auto name = block_string_at(block, 0, row);
      if (!name.empty()) dictionaries.push_back(std::move(name));
    }
  });
  std::sort(dictionaries.begin(), dictionaries.end());
  dictionaries.erase(std::unique(dictionaries.begin(), dictionaries.end()), dictionaries.end());
  return dictionaries;
}

std::vector<std::string> describe_columns(
    clickhouse::Client& runner,
    const std::string& database,
    const std::string& table) {
  std::vector<std::string> columns;
  const std::string target = qualified_ident(database, table);
  auto load = [&](const std::string& sql) {
    runner.Select(sql, [&](const clickhouse::Block& block) {
      columns.reserve(columns.size() + block.GetRowCount());
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        auto name = block_string_at(block, 0, row);
        if (!name.empty()) columns.push_back(std::move(name));
      }
    });
  };

  load("DESCRIBE TABLE " + target + " SETTINGS describe_include_subcolumns = 0");

  std::sort(columns.begin(), columns.end());
  columns.erase(std::unique(columns.begin(), columns.end()), columns.end());
  return columns;
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

void discover_columns_recursive(
    clickhouse::Client& runner,
    const std::string& database,
    const std::string& table,
    const std::vector<std::string>& columns,
    size_t begin,
    size_t end,
    std::unordered_set<std::string>& allowed) {
  if (begin >= end) return;

  bool granted = false;
  try {
    granted = check_grant(runner, select_columns_expression(database, table, columns, begin, end));
  } catch (const std::exception&) {
    // Some ClickHouse/clickhouse-cpp combinations cannot decode CHECK GRANT
    // result variants (for example protocol type 97). A LIMIT 0 projection is
    // an exact permission probe: ClickHouse performs access analysis for every
    // referenced column but reads no table data and returns no unsupported
    // column payload to the client.
    granted = zero_row_column_probe(runner, database, table, columns, begin, end);
  }
  if (granted) {
    for (size_t i = begin; i < end; ++i) allowed.insert(columns[i]);
    return;
  }

  if (end - begin == 1) return;
  const size_t middle = begin + (end - begin) / 2;
  discover_columns_recursive(runner, database, table, columns, begin, middle, allowed);
  discover_columns_recursive(runner, database, table, columns, middle, end, allowed);
}

AllowedTable inspect_table(
    clickhouse::Client& runner,
    const std::string& database,
    const std::string& table) {
  AllowedTable result;
  result.database = database;
  result.table = table;

  const std::string target = qualified_ident(database, table);
  bool full_check_unavailable = false;
  try {
    if (check_grant(runner, "SELECT ON " + target)) {
      result.all_columns = true;
      return result;
    }
  } catch (const std::exception&) {
    // Fall through to exact column discovery. This avoids making a protocol
    // decoding limitation in CHECK GRANT fatal while keeping the ACL boundary
    // fail-closed at column granularity.
    full_check_unavailable = true;
  }

  const auto columns = describe_columns(runner, database, table);
  if (columns.empty()) return result;
  if (full_check_unavailable && zero_row_column_probe(runner, database, table, columns, 0, columns.size())) {
    result.all_columns = true;
    return result;
  }

  // Keep individual CHECK GRANT statements bounded for very wide schemas.
  // Fully granted chunks collapse to one check; denied chunks are split until
  // the exact readable columns are known.
  constexpr size_t kChunkColumns = 64;
  for (size_t begin = 0; begin < columns.size(); begin += kChunkColumns) {
    const size_t end = std::min(columns.size(), begin + kChunkColumns);
    discover_columns_recursive(runner, database, table, columns, begin, end, result.columns);
  }
  return result;
}

} // namespace

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
  if (!table.all_columns && table.columns.empty()) return;

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

std::vector<std::string> discover_visible_databases(clickhouse::Client& runner) {
  auto databases = show_databases(runner);
  databases.erase(
      std::remove_if(databases.begin(), databases.end(), [](const std::string& database) {
        return !explorer_schema_visible(database);
      }),
      databases.end());
  return databases;
}

std::vector<std::string> discover_visible_objects(clickhouse::Client& runner, const std::string& database) {
  if (!explorer_schema_visible(database)) return {};
  auto objects = show_tables(runner, database);
  auto dictionaries = show_dictionaries(runner, database);
  objects.insert(objects.end(), dictionaries.begin(), dictionaries.end());
  std::sort(objects.begin(), objects.end());
  objects.erase(std::unique(objects.begin(), objects.end()), objects.end());
  return objects;
}

std::optional<AllowedTable> discover_allowed_table(
    clickhouse::Client& runner,
    const std::string& database,
    const std::string& table) {
  if (!explorer_schema_visible(database) || database.empty() || table.empty()) return std::nullopt;
  const auto objects = discover_visible_objects(runner, database);
  if (!std::binary_search(objects.begin(), objects.end(), table)) return std::nullopt;
  auto entry = inspect_table(runner, database, table);
  if (!entry.all_columns && entry.columns.empty()) return std::nullopt;
  return entry;
}

AllowedObjectSet discover_allowed_objects(clickhouse::Client& runner) {
  AllowedObjectSet allowed;
  const auto databases = show_databases(runner);
  for (const auto& database : databases) {
    // INFORMATION_SCHEMA is a compatibility surface, not an Explorer object
    // namespace. system.tables is intentionally queried without these schemas,
    // so exclude them at the runner ACL boundary too to keep the comparison
    // symmetric and avoid false metadata-account privilege failures.
    if (!explorer_schema_visible(database)) continue;
    auto objects = show_tables(runner, database);
    auto dictionaries = show_dictionaries(runner, database);
    objects.insert(objects.end(), dictionaries.begin(), dictionaries.end());
    std::sort(objects.begin(), objects.end());
    objects.erase(std::unique(objects.begin(), objects.end()), objects.end());

    for (const auto& object : objects) {
      try {
        auto entry = inspect_table(runner, database, object);
        allowed.add_table(std::move(entry));
      } catch (const std::exception& e) {
        throw std::runtime_error("ACL discovery failed for " + database + "." + object + ": " + e.what());
      }
    }
  }
  return allowed;
}

} // namespace chdash
