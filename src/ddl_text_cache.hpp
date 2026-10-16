#pragma once

#include "ch_block_value.hpp"
#include "ch_executor.hpp"
#include "sql_params.hpp"

#include <algorithm>
#include <chrono>
#include <functional>
#include <list>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace chdash {

// system.tables formats engine_full, create_table_query and as_select from the stored DDL of every object it returns.
// Each of those columns costs ~120 ms per 2k objects.
// Identity columns cost ~15 ms.
// The Explorer graph and its catalog re-read these columns on every refresh.
// The graph refreshes live while it is open.
//
// The formatted texts are cached per identity. A cached text is reused while the object's metadata_modification_time is unchanged.
//
// The identity (`account`) is the digest of the URI of the connection (acl_identity_key).
// ClickHouse masks the secrets of engine_full and create_table_query by user (display_secrets_in_show_and_select).
// Therefore two users never share a text, even on the same server.
//
// Staleness guards: an object modified in the last kRecentSeconds is always re-read.
// The timestamp has one-second granularity. Two DDL changes in the same second cannot be told apart.
// Entries are re-read after kMaxAge regardless.
//
// Memory: the cache is an LRU, bounded in entries and in bytes.
struct DdlTexts {
  std::string engine_full;
  std::string create_table_query;
  std::string as_select;
};

struct DdlObjectVersion {
  std::string database;
  std::string name;
  std::string metadata_modification_time;
  bool recently_modified = false;
};

class DdlTextCache {
public:
  // Reads the texts of some objects of one database. The result is (object_key, texts) pairs.
  using Fetch = std::function<std::vector<std::pair<std::string, DdlTexts>>(
      const std::string& database, const std::vector<std::string>& names)>;

  DdlTextCache(size_t max_entries = 200000, size_t max_bytes = 128u << 20)
      : max_entries_(max_entries), max_bytes_(max_bytes) {}

  // SQL fragment for the cheap identity query.
  // It must be selected next to database/name. Callers then build DdlObjectVersion rows.
  static constexpr const char* kVersionColumns =
      "toString(metadata_modification_time), toString(toUInt8(metadata_modification_time >= now() - 2))";

  // Returns the DDL texts of `objects` (keyed "database\0name").
  // It reads only the missing or changed objects from `db`, as `account`.
  std::unordered_map<std::string, DdlTexts> get(
      ChExecutor& db,
      const std::string& account,
      const std::vector<DdlObjectVersion>& objects) {
    return get(account, objects, [&db](const std::string& database, const std::vector<std::string>& names) {
      return read_texts(db, database, names);
    });
  }

  std::unordered_map<std::string, DdlTexts> get(
      const std::string& account,
      const std::vector<DdlObjectVersion>& objects,
      const Fetch& fetch) {
    const auto now = std::chrono::steady_clock::now();
    std::unordered_map<std::string, DdlTexts> out;
    out.reserve(objects.size());
    std::map<std::string, std::set<std::string>> missing_by_database;
    std::unordered_map<std::string, const DdlObjectVersion*> wanted;
    {
      std::lock_guard<std::mutex> lk(mu_);
      for (const auto& object : objects) {
        const std::string key = object_key(object.database, object.name);
        wanted.emplace(key, &object);
        const auto it = entries_.find(scoped_key(account, key));
        if (!object.recently_modified && it != entries_.end() &&
            it->second.metadata_modification_time == object.metadata_modification_time &&
            now - it->second.fetched_at < kMaxAge) {
          lru_.splice(lru_.begin(), lru_, it->second.lru);
          out.emplace(key, it->second.texts);
          continue;
        }
        missing_by_database[object.database].insert(object.name);
      }
    }
    if (missing_by_database.empty()) return out;

    // system.tables applies the database and name predicates before it formats the DDL columns.
    // A cold cache reads kMaxNamesPerQuery names per query.
    // Never read a whole database.
    for (const auto& [database, names] : missing_by_database) {
      std::vector<std::string> batch;
      batch.reserve(std::min(names.size(), kMaxNamesPerQuery));
      for (auto name = names.begin(); name != names.end();) {
        batch.push_back(*name);
        ++name;
        if (batch.size() < kMaxNamesPerQuery && name != names.end()) continue;
        auto fetched = fetch(database, batch);
        batch.clear();
        std::lock_guard<std::mutex> lk(mu_);
        for (auto& [key, texts] : fetched) {
          const auto version = wanted.find(key);
          if (version == wanted.end()) continue;
          if (!version->second->recently_modified) {
            store_locked(scoped_key(account, key), version->second->metadata_modification_time, now, texts);
          } else {
            erase_locked(scoped_key(account, key));
          }
          out[key] = std::move(texts);
        }
      }
    }
    return out;
  }

  static std::string object_key(const std::string& database, const std::string& name) {
    std::string key = database;
    key.push_back('\0');
    key += name;
    return key;
  }

  size_t size() const {
    std::lock_guard<std::mutex> lk(mu_);
    return entries_.size();
  }

  size_t bytes() const {
    std::lock_guard<std::mutex> lk(mu_);
    return bytes_;
  }

  static constexpr size_t kMaxNamesPerQuery = 2000;

private:
  static constexpr auto kMaxAge = std::chrono::minutes(10);

  struct Entry {
    std::string metadata_modification_time;
    std::chrono::steady_clock::time_point fetched_at;
    DdlTexts texts;
    size_t bytes = 0;
    std::list<std::string>::iterator lru;
  };

  static std::string scoped_key(const std::string& account, const std::string& key) {
    std::string out = account;
    out.push_back('\x1f');
    out += key;
    return out;
  }

  // The database and the names are query parameters of the statement, one parameter each. A name may hold any byte.
  static std::vector<std::pair<std::string, DdlTexts>> read_texts(
      ChExecutor& db, const std::string& database, const std::vector<std::string>& names) {
    SqlParams params;
    const std::string database_placeholder = params.text(database);
    const std::string name_list = params.texts(names);
    const std::string sql =
        "SELECT toString(database), toString(name), toString(engine_full), toString(create_table_query), "
        "toString(as_select) FROM system.tables WHERE database = " + database_placeholder + " AND name IN (" + name_list + ")";
    std::vector<std::pair<std::string, DdlTexts>> fetched;
    db.select(sql, params.list(), [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        fetched.emplace_back(object_key(ch_block_text_at(block, 0, row), ch_block_text_at(block, 1, row)),
                             DdlTexts{ch_block_text_at(block, 2, row), ch_block_text_at(block, 3, row),
                                      ch_block_text_at(block, 4, row)});
      }
    });
    return fetched;
  }

  void store_locked(const std::string& key, const std::string& mtime, std::chrono::steady_clock::time_point now,
                    const DdlTexts& texts) {
    erase_locked(key);
    lru_.push_front(key);
    Entry entry{mtime, now, texts, 0, lru_.begin()};
    entry.bytes = 2 * key.size() + mtime.size() + texts.engine_full.size() + texts.create_table_query.size() +
                  texts.as_select.size() + sizeof(Entry) + 64;
    bytes_ += entry.bytes;
    entries_.emplace(key, std::move(entry));
    while (!lru_.empty() && (entries_.size() > max_entries_ || bytes_ > max_bytes_)) {
      const std::string victim = lru_.back();
      erase_locked(victim);
    }
  }

  void erase_locked(const std::string& key) {
    const auto it = entries_.find(key);
    if (it == entries_.end()) return;
    bytes_ -= std::min(bytes_, it->second.bytes);
    lru_.erase(it->second.lru);
    entries_.erase(it);
  }

  const size_t max_entries_;
  const size_t max_bytes_;
  mutable std::mutex mu_;
  std::unordered_map<std::string, Entry> entries_;
  std::list<std::string> lru_;  // the most recently used first
  size_t bytes_ = 0;
};

} // namespace chdash
