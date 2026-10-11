#pragma once

#include <clickhouse/client.h>

#include <chrono>
#include <cstddef>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace chdash {

class ClickHouseClientPool;
class ChExecutor;

struct AllowedTable {
  std::string database;
  std::string table;
  // SELECT on the whole table (CHECK GRANT).
  bool all_columns = false;
  // The identity reads some columns only. `columns` lists them when the column-level inspection ran (one table:
  // discover_allowed_table); a table-level discovery leaves it empty, so allows_column() stays false for them.
  bool partial = false;
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
  size_t approx_bytes() const;

private:
  static std::string table_key(const std::string& database, const std::string& table);

  std::vector<std::string> databases_;
  std::unordered_set<std::string> database_index_;
  std::vector<AllowedTable> tables_;
  std::unordered_map<std::string, size_t> table_index_;
};

// ClickHouse refused the statement: ACCESS_DENIED (code 497). Only this answer means "not readable".
struct AclDenied : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// ClickHouse answered another error about one object (a parameterized view, a Distributed table without its cluster,
// a database dropped meanwhile): that object is left out and reported, the others are still checked.
struct AclObjectError : std::runtime_error {
  AclObjectError(int code, const std::string& message) : std::runtime_error(message), code(code) {}
  int code = 0;
};

// What one ClickHouse identity answers about its own privileges: the runner connection (make_acl_source), or a fake in
// the tests. CHECK GRANT and zero-row probes only: the grant list of the user (SHOW GRANTS, system.grants) is never read.
// A transport error (connection, timeout, protocol) is thrown as it is: it is not an answer.
class AclSource {
public:
  virtual ~AclSource() = default;
  virtual std::vector<std::string> show_databases() = 0;
  // SHOW TABLES and SHOW DICTIONARIES of one database, sorted and unique. Throws AclObjectError when ClickHouse refuses.
  virtual std::vector<std::string> show_objects(const std::string& database) = 0;
  // CHECK GRANT <expression>: true or false; nullopt when the answer cannot be read.
  virtual std::optional<bool> check_grant(const std::string& expression) = 0;
  // A statement that reads no row. Throws AclDenied (ACCESS_DENIED) or AclObjectError (another server error).
  virtual void probe(const std::string& sql) = 0;
  // DESCRIBE TABLE, without subcolumns. Throws AclDenied or AclObjectError.
  virtual std::vector<std::string> describe_columns(const std::string& database, const std::string& table) = 0;
};

// The runner connection as an AclSource. A transport error makes the pool drop the connection.
std::unique_ptr<AclSource> make_acl_source(std::shared_ptr<clickhouse::Client> client, std::shared_ptr<ClickHouseClientPool> pool);

// The bounds of one discovery: at most `max_objects` objects checked in all, `max_objects_per_database` objects probed
// to decide whether one database is readable, and nothing after `deadline`. Past a bound the answer says `truncated`;
// nothing that was not checked is allowed.
struct AclBudget {
  size_t max_objects = 4000;
  size_t max_objects_per_database = 400;
  std::chrono::steady_clock::time_point deadline = std::chrono::steady_clock::time_point::max();
  size_t used = 0;

  bool spent() const { return used >= max_objects || std::chrono::steady_clock::now() >= deadline; }
};

// An object that ClickHouse could not answer about (left out of the answer).
struct AclIssue {
  std::string database;
  std::string object;
  int code = 0;
  std::string message;
};

// The databases of the identity: those it reads all of, or at least one object of (sorted). The names come from SHOW
// DATABASES and the decision from SELECT: a runner may SHOW every database and read two of them.
struct AclDatabases {
  std::vector<std::string> databases;
  // Listed by SHOW, but the budget ended before an answer. They are never in `databases`.
  std::vector<std::string> unverified;
  bool truncated = false;
  std::vector<AclIssue> issues;
  size_t approx_bytes() const;
};

// The objects of one database that the identity reads, at table level (sorted by name).
struct AclObjects {
  std::vector<AllowedTable> objects;
  // The budget ended: the objects not checked are left out.
  bool truncated = false;
  std::vector<AclIssue> issues;
  bool contains(const std::string& table) const;
  size_t approx_bytes() const;
};

// Whether the identity reads `database`.`table` and how: CHECK GRANT SELECT on the table, else a zero-row SELECT (it is
// refused without a column grant). Returns nullopt when it reads nothing. Throws AclObjectError for another server error.
std::optional<AllowedTable> check_table_access(AclSource& source, const std::string& database, const std::string& table);

AclDatabases discover_databases(AclSource& source, AclBudget& budget);
AclObjects discover_objects(AclSource& source, const std::string& database, AclBudget& budget);

// The exact SELECT/column boundary of one object, for the lazy table detail and data endpoints: opening one table never
// checks the other ones. Returns nullopt when the object is not listed or no column is readable.
std::optional<AllowedTable> discover_allowed_table(AclSource& source, const std::string& database, const std::string& table);
std::optional<AllowedTable> discover_allowed_table(clickhouse::Client& runner, const std::string& database, const std::string& table);

// "SELECT ON `db`.`table`" when the user of the client has no SELECT on the table (CHECK GRANT), else nullopt.
// A server that does not answer in a readable way says nothing: nullopt.
std::optional<std::string> missing_select_grant(clickhouse::Client& client, const std::string& database, const std::string& table);
std::optional<std::string> missing_select_grant(ChExecutor& db, const std::string& database, const std::string& table);

// Run `CHECK GRANT <expression>` on `client`. `decoded` reports whether the
// result could be read (some protocol/result variants cannot be decoded).
bool check_grant_expression(clickhouse::Client& client, const std::string& expression, bool* decoded = nullptr);

bool explorer_schema_visible(const std::string& database);

} // namespace chdash
