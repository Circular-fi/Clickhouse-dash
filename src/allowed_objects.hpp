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
  // The identity reads some columns only. `columns` lists them when the column-level inspection ran for one table.
  // That inspection is discover_allowed_table. A table-level discovery leaves `columns` empty. Then allows_column() stays false for them.
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

// ClickHouse refused the statement with ACCESS_DENIED (code 497). Only this answer means "not readable".
struct AclDenied : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// ClickHouse answered with another error about one object. Examples: a parameterized view, a Distributed table without its cluster, or a database dropped meanwhile.
// That object is left out and reported. The other objects are still checked.
struct AclObjectError : std::runtime_error {
  AclObjectError(int code, const std::string& message) : std::runtime_error(message), code(code) {}
  int code = 0;
};

// The answers of one ClickHouse identity about its own privileges. The source is the runner connection (make_acl_source), or a fake in the tests.
// The source uses only CHECK GRANT and zero-row probes. It never reads the grant list of the user (SHOW GRANTS, system.grants).
// A transport error (connection, timeout, protocol) is thrown as it is. It is not an answer.
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

// The bounds of one discovery. At most `max_objects` objects are checked in all. At most `max_objects_per_database` objects are probed
// to decide whether one database is readable. Nothing is checked after `deadline`. Past a bound, the answer says `truncated`.
// Nothing that was not checked is allowed.
struct AclBudget {
  size_t max_objects = 4000;
  size_t max_objects_per_database = 400;
  std::chrono::steady_clock::time_point deadline = std::chrono::steady_clock::time_point::max();
  size_t used = 0;

  bool spent() const { return used >= max_objects || std::chrono::steady_clock::now() >= deadline; }
};

// An object that ClickHouse could not answer. It is left out of the answer.
struct AclIssue {
  std::string database;
  std::string object;
  int code = 0;
  std::string message;
};

// The databases of the identity: those it reads all of, or at least one object of (sorted). The names come from SHOW
// DATABASES. The decision comes from SELECT. A runner may SHOW every database and read two of them.
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
  // The budget ended. The objects that were not checked are left out.
  bool truncated = false;
  std::vector<AclIssue> issues;
  bool contains(const std::string& table) const;
  size_t approx_bytes() const;
};

// Whether the identity reads `database`.`table`, and how. The check uses CHECK GRANT SELECT on the table. If that fails, it uses a zero-row SELECT.
// The zero-row SELECT is refused without a column grant. Returns nullopt when it reads nothing. Throws AclObjectError for another server error.
std::optional<AllowedTable> check_table_access(AclSource& source, const std::string& database, const std::string& table);

AclDatabases discover_databases(AclSource& source, AclBudget& budget);
AclObjects discover_objects(AclSource& source, const std::string& database, AclBudget& budget);

// The exact SELECT and column boundary of one object. The lazy table detail and data endpoints use it.
// Opening one table never checks the other tables. Returns nullopt when the object is not listed or no column is readable.
std::optional<AllowedTable> discover_allowed_table(AclSource& source, const std::string& database, const std::string& table);
std::optional<AllowedTable> discover_allowed_table(clickhouse::Client& runner, const std::string& database, const std::string& table);

// Return "SELECT ON `db`.`table`" when the client user has no SELECT on the table (CHECK GRANT). Else return nullopt.
// A server that does not answer in a readable way gives no answer. Return nullopt.
std::optional<std::string> missing_select_grant(clickhouse::Client& client, const std::string& database, const std::string& table);
std::optional<std::string> missing_select_grant(ChExecutor& db, const std::string& database, const std::string& table);

// Run `CHECK GRANT <expression>` on `client`. `decoded` reports whether the result could be read.
// Some protocol and result variants cannot be decoded.
bool check_grant_expression(clickhouse::Client& client, const std::string& expression, bool* decoded = nullptr);

bool explorer_schema_visible(const std::string& database);

} // namespace chdash
