#pragma once

#include "allowed_objects.hpp"
#include "ttl_cache.hpp"

#include <chrono>
#include <cstddef>
#include <functional>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace chdash {

class ClickHouseClientPool;

// One ClickHouse identity. The key holds its answers. It also says how to connect as this identity.
// Two hosts share answers only when they connect with the same URI. The URI has the same user, password, server and settings.
// The key is a digest of that URI.
struct AclAccess {
  std::string key;
  std::function<std::unique_ptr<AclSource>(std::string* error)> connect;
};

std::string acl_identity_key(const std::string& uri);
AclAccess make_acl_access(const std::shared_ptr<ClickHouseClientPool>& pool, const std::string& uri);

// The ACL of an identity could not be read. The cause can be a connection error, a timeout, a protocol error or the budget of the request.
// This is not an answer. Nothing is allowed, and nothing is kept beyond the short back-off of the cache.
struct AclUnavailable : std::runtime_error {
  AclUnavailable(std::string code, const std::string& message) : std::runtime_error(message), code(std::move(code)) {}
  std::string code;
};

// Every object that the identity reads, at table level. This list covers the Explorer graph and catalog,
// the filters of the execution statistics, analysis, exports, and MCP.
struct AclTableSet {
  AllowedObjectSet allowed;
  // A bound stopped the discovery. The objects that were not checked are left out.
  bool truncated = false;
  std::vector<std::string> unverified_databases;
  std::vector<AclIssue> issues;
  size_t approx_bytes() const;
};

// What each identity may read. The discovery uses CHECK GRANT and zero-row probes, run as that identity.
// It never reads the grant list. The answers are kept per identity and shared by every page and route:
// the Explorer, the System pages, the execution statistics, analysis, exports and MCP. One discovery runs per key at a time.
// The discovery is bounded in objects and time.
class AclService {
public:
  struct Options {
    std::chrono::milliseconds ttl{std::chrono::seconds(60)};
    // After the TTL, the answer is served for this long. One refresh runs in the background meanwhile.
    std::chrono::milliseconds stale_for{std::chrono::seconds(60)};
    std::chrono::milliseconds failure_backoff{std::chrono::seconds(2)};
    std::chrono::milliseconds wait{std::chrono::seconds(60)};
    // One discovery (the databases, or the objects of one database) stops after this time or after this many objects.
    std::chrono::milliseconds discovery_time{std::chrono::seconds(20)};
    size_t max_objects = 4000;
    size_t max_objects_per_database = 400;
    size_t max_entries = 8192;
    size_t max_bytes = 64u << 20;
    std::function<bool(std::function<void()>)> submit;
  };

  explicit AclService(Options options);

  // The databases that the identity reads all of or at least one object of. Throws AclUnavailable.
  std::shared_ptr<const AclDatabases> databases(const AclAccess& access);
  // The objects of one database that the identity reads. Throws AclUnavailable.
  std::shared_ptr<const AclObjects> objects(const AclAccess& access, const std::string& database);
  // Whether the identity reads `database`.`table`. Only this object is checked. No other object of the database is checked.
  bool table_readable(const AclAccess& access, const std::string& database, const std::string& table);
  // Every object that the identity reads. Throws AclUnavailable.
  std::shared_ptr<const AclTableSet> table_set(const AclAccess& access);

  // Use refresh=1 after changes of grants. The next answers for the identity are read after this call.
  void invalidate(const AclAccess& access);
  // It does the same for one database (a refresh of one Explorer branch or table): its objects, its single-object answers,
  // and the set of every object.
  void invalidate(const AclAccess& access, const std::string& database);

  const Options& options() const { return options_; }

private:
  template <typename Value>
  static std::shared_ptr<const Value> answer(const typename TtlCache<std::string, Value>::Result& result);
  AclBudget budget() const;

  Options options_;
  TtlCache<std::string, AclDatabases> databases_;
  TtlCache<std::string, AclObjects> objects_;
  TtlCache<std::string, bool> readable_;
  TtlCache<std::string, AclTableSet> sets_;
};

// The answers of one identity for one request. Each database is asked once, then the answer is kept.
class AclView {
public:
  AclView(AclService& service, AclAccess access) : service_(service), access_(std::move(access)) {}

  // The databases that the identity reads (sorted). Throws AclUnavailable.
  const std::vector<std::string>& databases();
  bool database_visible(const std::string& database);
  // The identity lists and reads `database`.`table`. Throws AclUnavailable.
  bool visible(const std::string& database, const std::string& table);
  // The readable objects of one database (sorted). Throws AclUnavailable.
  const AclObjects& objects(const std::string& database);
  // Whether the identity reads one object. Only this object is checked. The database is not enumerated, unless this view already did so.
  // This method serves the neighbours of a table (lineage). Throws AclUnavailable.
  bool readable(const std::string& database, const std::string& table);
  bool truncated();

private:
  AclService& service_;
  AclAccess access_;
  std::shared_ptr<const AclDatabases> databases_;
  std::unordered_map<std::string, std::shared_ptr<const AclObjects>> objects_;
};

} // namespace chdash
