#pragma once

#include <clickhouse/client.h>

#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace chdash {

struct AllowedTable {
  std::string database;
  std::string table;
  bool all_columns = false;
  std::unordered_set<std::string> columns;
};

class AllowedObjectSet {
public:
  bool allows_database(const std::string& database) const;
  bool allows_table(const std::string& database, const std::string& table) const;
  bool allows_column(
      const std::string& database,
      const std::string& table,
      const std::string& column) const;

  const std::vector<std::string>& databases() const { return databases_; }
  const std::vector<AllowedTable>& tables() const { return tables_; }

  void add_table(AllowedTable table);

private:
  static std::string table_key(const std::string& database, const std::string& table);

  std::vector<std::string> databases_;
  std::unordered_set<std::string> database_index_;
  std::vector<AllowedTable> tables_;
  std::unordered_map<std::string, size_t> table_index_;
};

// Build the authorization boundary with the same native ClickHouse connection
// that represents the user's runner context. This function never consults the
// system account and never infers privileges from SHOW GRANTS/system.grants.
//
// CHECK GRANT is authoritative. Tables with a full SELECT grant are accepted
// immediately. For column-level grants, DESCRIBE is used only to enumerate
// candidate columns and CHECK GRANT SELECT(col...) determines the readable set.
AllowedObjectSet discover_allowed_objects(clickhouse::Client& runner);

// Lightweight Explorer discovery helpers. These execute in the runner context
// and intentionally avoid scanning/inspecting every table up front. The
// sidebar first asks only for databases, then for the objects of one database.
std::vector<std::string> discover_visible_databases(clickhouse::Client& runner);
std::vector<std::string> discover_visible_objects(clickhouse::Client& runner, const std::string& database);

// Resolve the exact SELECT/column boundary for one object only. This is used by
// lazy table detail/data endpoints so opening Explorer never expands ACL checks
// across unrelated databases. Returns nullopt when the object is not visible or
// has no readable columns.
std::optional<AllowedTable> discover_allowed_table(
    clickhouse::Client& runner,
    const std::string& database,
    const std::string& table);

} // namespace chdash
