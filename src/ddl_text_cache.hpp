#pragma once

#include "ch_block_value.hpp"

#include <clickhouse/client.h>

#include <chrono>
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
// open), so the formatted texts are cached per server/account and reused as
// long as the object's metadata_modification_time is unchanged.
//
// Staleness guards: an object modified in the last kRecentSeconds is always
// re-read (the timestamp has one-second granularity, so two DDL changes in the
// same second would otherwise be indistinguishable), and entries are re-read
// after kMaxAge regardless.
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
  static DdlTextCache& instance() {
    static DdlTextCache cache;
    return cache;
  }

  // SQL fragment for the cheap identity query: it must be selected next to
  // database/name so callers can build DdlObjectVersion rows.
  static constexpr const char* kVersionColumns =
      "toString(metadata_modification_time), toString(toUInt8(metadata_modification_time >= now() - 2))";

  // Return the DDL texts of `objects` (keyed "database\0name"), reading only
  // missing/changed ones from `client`. `account` separates caches of
  // differently privileged connections (secrets may be masked differently).
  std::unordered_map<std::string, DdlTexts> get(
      clickhouse::Client& client,
      const std::string& account,
      const std::vector<DdlObjectVersion>& objects) {
    const std::string scope = endpoint_scope(client, account);
    const auto now = std::chrono::steady_clock::now();
    std::unordered_map<std::string, DdlTexts> out;
    out.reserve(objects.size());
    std::map<std::string, std::set<std::string>> missing_by_database;
    std::unordered_map<std::string, const DdlObjectVersion*> wanted;
    {
      std::lock_guard<std::mutex> lk(mu_);
      auto& entries = scopes_[scope];
      for (const auto& object : objects) {
        const std::string key = object_key(object.database, object.name);
        wanted.emplace(key, &object);
        const auto it = entries.find(key);
        if (!object.recently_modified && it != entries.end() &&
            it->second.metadata_modification_time == object.metadata_modification_time &&
            now - it->second.fetched_at < kMaxAge) {
          out.emplace(key, it->second.texts);
          continue;
        }
        missing_by_database[object.database].insert(object.name);
      }
    }
    if (missing_by_database.empty()) return out;

    // database / name predicates are applied by system.tables before the DDL
    // columns are formatted. A cold cache reads each database once.
    for (const auto& [database, names] : missing_by_database) {
      std::string sql =
          "SELECT toString(database), toString(name), toString(engine_full), toString(create_table_query), "
          "toString(as_select) FROM system.tables WHERE database = " + quote(database);
      if (names.size() <= kMaxNamesPerQuery) {
        sql += " AND name IN (";
        bool first = true;
        for (const auto& name : names) {
          if (!first) sql += ", ";
          first = false;
          sql += quote(name);
        }
        sql += ")";
      }
      std::vector<std::pair<std::string, DdlTexts>> fetched;
      client.Select(sql, [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          const std::string key = object_key(ch_block_text_at(block, 0, row), ch_block_text_at(block, 1, row));
          if (!wanted.count(key)) continue;
          fetched.emplace_back(key, DdlTexts{ch_block_text_at(block, 2, row), ch_block_text_at(block, 3, row),
                                             ch_block_text_at(block, 4, row)});
        }
      });
      std::lock_guard<std::mutex> lk(mu_);
      auto& entries = scopes_[scope];
      for (auto& [key, texts] : fetched) {
        const DdlObjectVersion& version = *wanted.at(key);
        if (!version.recently_modified) {
          entries[key] = Entry{version.metadata_modification_time, now, texts};
        } else {
          entries.erase(key);
        }
        out[key] = std::move(texts);
      }
      if (entries.size() > kMaxEntriesPerScope) prune_locked(entries, now);
    }
    return out;
  }

  static std::string object_key(const std::string& database, const std::string& name) {
    std::string key = database;
    key.push_back('\0');
    key += name;
    return key;
  }

private:
  static constexpr auto kMaxAge = std::chrono::minutes(10);
  static constexpr size_t kMaxNamesPerQuery = 2000;
  static constexpr size_t kMaxEntriesPerScope = 200000;

  struct Entry {
    std::string metadata_modification_time;
    std::chrono::steady_clock::time_point fetched_at;
    DdlTexts texts;
  };

  static std::string quote(const std::string& value) {
    std::string out = "'";
    for (const char ch : value) {
      if (ch == '\\' || ch == '\'') out.push_back('\\');
      out.push_back(ch);
    }
    out.push_back('\'');
    return out;
  }

  static std::string endpoint_scope(clickhouse::Client& client, const std::string& account) {
    std::string scope = account;
    scope.push_back('\0');
    if (const auto& endpoint = client.GetCurrentEndpoint()) {
      scope += endpoint->host + ":" + std::to_string(endpoint->port);
    }
    return scope;
  }

  static void prune_locked(std::unordered_map<std::string, Entry>& entries,
                           std::chrono::steady_clock::time_point now) {
    for (auto it = entries.begin(); it != entries.end();) {
      if (now - it->second.fetched_at >= kMaxAge) it = entries.erase(it);
      else ++it;
    }
    if (entries.size() > kMaxEntriesPerScope) entries.clear();
  }

  std::mutex mu_;
  std::unordered_map<std::string, std::unordered_map<std::string, Entry>> scopes_;
};

} // namespace chdash
