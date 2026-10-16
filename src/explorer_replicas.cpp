// The replica counts of the Explorer, and the caches that its readers share.
//
// system.replicas answers queue_size / absolute_delay / is_readonly / is_session_expired from memory.
// total_replicas and active_replicas cost one Keeper (ZooKeeper) request per replicated table.
// The graph catalog is rebuilt every few seconds while the graph is open.
// The replica counts (the "nR" badge and the degraded check) are cached per server for kReplicaCountTtl.
// They are read again only for new tables, or when the entry expired. The read is restricted to the databases that are shown.
// Local-replica health (read-only, expired session, queue, delay) stays live on every build.
#include "explorer_catalog.hpp"

#include "explorer_sql.hpp"
#include "explorer_values.hpp"

#include <chrono>
#include <mutex>
#include <set>
#include <unordered_map>

namespace chdash {

using namespace explorer;

class ReplicaCountCache {
public:
  struct Counts {
    uint64_t total = 0;
    uint64_t active = 0;
  };

  std::unordered_map<std::string, Counts> get(
      ChExecutor& db,
      const std::vector<std::pair<std::string, std::string>>& tables,
      std::string* error) {
    const std::string scope = db.endpoint();
    const auto now = std::chrono::steady_clock::now();
    std::unordered_map<std::string, Counts> out;
    std::set<std::string> stale_databases;
    std::set<std::string> stale_tables;
    {
      std::lock_guard<std::mutex> lk(mu_);
      auto& entries = scopes_[scope];
      for (const auto& [database, table] : tables) {
        const std::string key = table_key(database, table);
        const auto it = entries.find(key);
        if (it != entries.end() && now - it->second.fetched_at < kReplicaCountTtl) {
          out[key] = it->second.counts;
        } else {
          stale_databases.insert(database);
          stale_tables.insert(table);
        }
      }
    }
    if (stale_databases.empty()) return out;

    std::vector<std::pair<std::string, Counts>> fetched;
    const bool ok = try_select(db,
      replica_counts_sql(std::vector<std::string>(stale_databases.begin(), stale_databases.end()),
                         std::vector<std::string>(stale_tables.begin(), stale_tables.end())),
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          fetched.emplace_back(table_key(block_string_at(block, 0, row), block_string_at(block, 1, row)),
                               Counts{parse_u64(block_string_at(block, 2, row)).value_or(0),
                                      parse_u64(block_string_at(block, 3, row)).value_or(0)});
        }
      }, error);
    if (!ok) return out;
    std::lock_guard<std::mutex> lk(mu_);
    auto& entries = scopes_[scope];
    for (auto& [key, counts] : fetched) {
      entries[key] = Entry{counts, now};
      out[key] = counts;
    }
    if (entries.size() > 100000) entries.clear();
    return out;
  }

private:
  static constexpr auto kReplicaCountTtl = std::chrono::seconds(60);

  struct Entry {
    Counts counts;
    std::chrono::steady_clock::time_point fetched_at;
  };

  std::mutex mu_;
  std::unordered_map<std::string, std::unordered_map<std::string, Entry>> scopes_;
};

std::unordered_map<std::string, ExplorerReplicaCounts> load_cached_replica_counts(
    ChExecutor& system,
    ExplorerCaches& caches,
    const std::vector<std::pair<std::string, std::string>>& tables,
    std::string* error) {
  std::unordered_map<std::string, ExplorerReplicaCounts> out;
  if (tables.empty()) return out;
  for (const auto& [key, counts] : caches.replica_counts->get(system, tables, error)) {
    out.emplace(key, ExplorerReplicaCounts{counts.total, counts.active});
  }
  return out;
}

ExplorerCaches::ExplorerCaches() : replica_counts(std::make_unique<ReplicaCountCache>()) {}
ExplorerCaches::~ExplorerCaches() = default;

}  // namespace chdash
