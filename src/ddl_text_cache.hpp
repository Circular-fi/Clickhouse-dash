#pragma once

#include "ch_block_value.hpp"

#include <clickhouse/client.h>

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

// system.tables formats engine_full / create_table_query / as_select from the
// stored DDL of every object it returns: each of those columns costs ~120 ms
// per 2k objects, while identity columns cost ~15 ms. The Explorer graph and
// its catalog re-read them on every refresh (the graph live-refreshes while
// open), so the formatted texts are cached per identity and reused as long as
// the object's metadata_modification_time is unchanged.
//
// The identity (`account`) is the digest of the URI of the connection
// (acl_identity_key): ClickHouse masks the secrets of engine_full and
// create_table_query by user (display_secrets_in_show_and_select), so two users
// never share a text, even on the same server.
//
// Staleness guards: an object modified in the last kRecentSeconds is always
// re-read (the timestamp has one-second granularity, so two DDL changes in the
// same second would otherwise be indistinguishable), and entries are re-read
// after kMaxAge regardless. Memory: an LRU bounded in entries and bytes.
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
  // Reads the texts of some objects of one database: (object_key, texts) pairs.
  using Fetch = std::function<std::vector<std::pair<std::string, DdlTexts>>(
      const std::string& database, const std::vector<std::string>& names)>;

  static DdlTextCache& instance() {
    static DdlTextCache cache;
    return cache;
  }

  DdlTextCache(size_t max_entries = 200000, size_t max_bytes = 128u << 20)
      : max_entries_(max_entries), max_bytes_(max_bytes) {}

  // SQL fragment for the cheap identity query: it must be selected next to
  // database/name so callers can build DdlObjectVersion rows.
  static constexpr const char* kVersionColumns =
      "toString(metadata_modification_time), toString(toUInt8(metadata_modification_time >= now() - 2))";

  // Return the DDL texts of `objects` (keyed "database\0name"), reading only
  // missing/changed ones from `client`, as `account`.
  std::unordered_map<std::string, DdlTexts> get(
      clickhouse::Client& client,
      const std::string& account,
      const std::vector<DdlObjectVersion>& objects) {
    return get(account, objects, [&client](const std::string& database, const std::vector<std::string>& names) {
      return read_texts(client, database, names);
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

    // database / name predicates are applied by system.tables before the DDL
    // columns are formatted. A cold cache reads kMaxNamesPerQuery names per
    // query: never a whole database.
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

  static std::string quote(const std::string& value) {
    std::string out = "'";
    for (const char ch : value) {
      if (ch == '\\' || ch == '\'') out.push_back('\\');
      out.push_back(ch);
    }
    out.push_back('\'');
    return out;
  }

  static std::vector<std::pair<std::string, DdlTexts>> read_texts(
      clickhouse::Client& client, const std::string& database, const std::vector<std::string>& names) {
    std::string sql =
        "SELECT toString(database), toString(name), toString(engine_full), toString(create_table_query), "
        "toString(as_select) FROM system.tables WHERE database = " + quote(database) + " AND name IN (";
    for (size_t i = 0; i < names.size(); ++i) {
      if (i) sql += ", ";
      sql += quote(names[i]);
    }
    sql += ")";
    std::vector<std::pair<std::string, DdlTexts>> fetched;
    client.Select(sql, [&](const clickhouse::Block& block) {
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
