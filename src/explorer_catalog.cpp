#include "explorer_catalog.hpp"
#include "ch_block_value.hpp"
#include "ch_block_numeric.hpp"
#include "json_clickhouse.hpp"

#include <algorithm>
#include <chrono>
#include <cctype>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <limits>
#include <map>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string_view>
#include <tuple>
#include <unordered_map>
#include <unordered_set>
#include <utility>

namespace chdash {
namespace {

uint64_t now_ms() {
  using namespace std::chrono;
  return static_cast<uint64_t>(duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count());
}

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

std::string quote_string(std::string_view value) {
  std::string out;
  out.reserve(value.size() + 2);
  out.push_back('\'');
  for (const char ch : value) {
    if (ch == '\\') out += "\\\\";
    else if (ch == '\'') out += "\\'";
    else out.push_back(ch);
  }
  out.push_back('\'');
  return out;
}

std::string qualified_ident(std::string_view database, std::string_view table) {
  return quote_ident(database) + "." + quote_ident(table);
}

std::vector<std::string> split_unit_separator(std::string_view value) {
  std::vector<std::string> out;
  size_t start = 0;
  for (size_t i = 0; i <= value.size(); ++i) {
    if (i != value.size() && value[i] != '\x1f') continue;
    if (i > start) out.emplace_back(value.substr(start, i - start));
    start = i + 1;
  }
  return out;
}

bool is_row_pseudo_object(std::string_view table) {
  std::string normalized;
  normalized.reserve(table.size());
  for (const char ch : table) normalized.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(ch))));
  return normalized == "row" || normalized == "_row";
}

std::optional<std::string> first_engine_argument(std::string_view engine_full, std::string_view engine_name) {
  size_t pos = 0;
  while (pos < engine_full.size() && std::isspace(static_cast<unsigned char>(engine_full[pos]))) ++pos;
  if (engine_full.substr(pos, engine_name.size()) != engine_name) return std::nullopt;
  pos += engine_name.size();
  while (pos < engine_full.size() && std::isspace(static_cast<unsigned char>(engine_full[pos]))) ++pos;
  if (pos >= engine_full.size() || engine_full[pos] != '(') return std::nullopt;
  ++pos;
  while (pos < engine_full.size() && std::isspace(static_cast<unsigned char>(engine_full[pos]))) ++pos;
  if (pos >= engine_full.size()) return std::nullopt;

  const char quote = engine_full[pos];
  if (quote == '\'' || quote == '`' || quote == '"') {
    ++pos;
    std::string value;
    while (pos < engine_full.size()) {
      const char ch = engine_full[pos++];
      if (ch == quote) {
        if (pos < engine_full.size() && engine_full[pos] == quote) {
          value.push_back(quote);
          ++pos;
          continue;
        }
        return value;
      }
      if (ch == '\\' && quote == '\'' && pos < engine_full.size()) {
        value.push_back(engine_full[pos++]);
      } else {
        value.push_back(ch);
      }
    }
    return std::nullopt;
  }

  const size_t start = pos;
  while (pos < engine_full.size() && engine_full[pos] != ',' && engine_full[pos] != ')') ++pos;
  size_t end = pos;
  while (end > start && std::isspace(static_cast<unsigned char>(engine_full[end - 1]))) --end;
  if (end == start) return std::nullopt;
  return std::string(engine_full.substr(start, end - start));
}


std::string table_key(std::string_view database, std::string_view table);

std::vector<std::string> parse_engine_arguments_local(std::string_view engine_full, std::string_view engine_name) {
  size_t pos = 0;
  while (pos < engine_full.size() && std::isspace(static_cast<unsigned char>(engine_full[pos]))) ++pos;
  if (engine_full.substr(pos, engine_name.size()) != engine_name) return {};
  pos += engine_name.size();
  while (pos < engine_full.size() && std::isspace(static_cast<unsigned char>(engine_full[pos]))) ++pos;
  if (pos >= engine_full.size() || engine_full[pos] != '(') return {};
  ++pos;

  auto trim = [](std::string value) {
    const auto first = value.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) return std::string{};
    const auto last = value.find_last_not_of(" \t\r\n");
    return value.substr(first, last - first + 1);
  };

  std::vector<std::string> args;
  std::string current;
  char quote = 0;
  int depth = 0;
  for (; pos < engine_full.size(); ++pos) {
    const char ch = engine_full[pos];
    if (quote) {
      if (ch == '\\' && quote == '\'' && pos + 1 < engine_full.size()) {
        current.push_back(engine_full[++pos]);
        continue;
      }
      if (ch == quote) {
        if (pos + 1 < engine_full.size() && engine_full[pos + 1] == quote) {
          current.push_back(quote);
          ++pos;
          continue;
        }
        quote = 0;
        continue;
      }
      current.push_back(ch);
      continue;
    }
    if (ch == '\'' || ch == '`' || ch == '"') { quote = ch; continue; }
    if (ch == '(') { ++depth; current.push_back(ch); continue; }
    if (ch == ')') {
      if (depth > 0) { --depth; current.push_back(ch); continue; }
      args.push_back(trim(std::move(current)));
      break;
    }
    if (ch == ',' && depth == 0) {
      args.push_back(trim(std::move(current)));
      current.clear();
      continue;
    }
    current.push_back(ch);
  }
  return args;
}

std::string resolve_buffer_database_arg(const std::string& arg, const std::string& source_database) {
  std::string compact;
  compact.reserve(arg.size());
  for (char ch : arg) {
    if (!std::isspace(static_cast<unsigned char>(ch))) compact.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(ch))));
  }
  if (compact == "currentdatabase()") return source_database;
  return arg;
}

void normalize_buffer_runtime_rows(std::vector<ExplorerTableSummary>& summaries) {
  // system.tables.total_rows for Buffer is the readable surface: resident rows
  // plus the underlying destination. Snapshot *those exact system.tables values*
  // before system.parts later replaces MergeTree row counts. Mixing a Buffer
  // total captured at T1 with a destination parts count captured at T2 makes a
  // flush race look like resident rows appearing/disappearing. The raw snapshot
  // also makes Buffer -> Buffer chains order-independent.
  std::unordered_map<std::string, std::optional<uint64_t>> raw_rows;
  raw_rows.reserve(summaries.size());
  for (const auto& table : summaries) {
    raw_rows.emplace(table_key(table.database, table.name), table.rows);
  }

  for (auto& table : summaries) {
    if (table.engine != "Buffer") continue;
    const auto own = raw_rows.find(table_key(table.database, table.name));
    const auto args = parse_engine_arguments_local(table.engine_full, "Buffer");
    if (own == raw_rows.end() || !own->second || args.size() < 2 || args[0].empty() || args[1].empty()) {
      table.rows.reset();
      continue;
    }

    const std::string target_database = resolve_buffer_database_arg(args[0], table.database);
    const auto target = raw_rows.find(table_key(target_database, args[1]));
    if (target == raw_rows.end() || !target->second) {
      // The target may be hidden by the runner ACL or unable to expose an exact
      // lightweight row count. In either case, resident Buffer rows are unknown.
      table.rows.reset();
      continue;
    }

    const uint64_t readable_rows = *own->second;
    const uint64_t target_readable_rows = *target->second;
    if (readable_rows < target_readable_rows) {
      // Never clamp an inconsistent cross-object snapshot to zero: zero would be
      // a fabricated resident-row count. A future refresh can resolve the race.
      table.rows.reset();
      continue;
    }
    table.rows = readable_rows - target_readable_rows;
  }
}

std::string table_key(std::string_view database, std::string_view table) {
  std::string key;
  key.reserve(database.size() + table.size() + 1);
  key.append(database.data(), database.size());
  key.push_back('\0');
  key.append(table.data(), table.size());
  return key;
}


struct ParsedQualifiedName {
  std::string database;
  std::string table;
};

std::optional<std::string> parse_relation_identifier(std::string_view text, size_t& pos) {
  while (pos < text.size() && std::isspace(static_cast<unsigned char>(text[pos]))) ++pos;
  if (pos >= text.size()) return std::nullopt;
  const char quote = text[pos];
  if (quote == '`' || quote == '"') {
    ++pos;
    std::string value;
    while (pos < text.size()) {
      const char ch = text[pos++];
      if (ch == quote) {
        if (pos < text.size() && text[pos] == quote) { value.push_back(quote); ++pos; continue; }
        return value;
      }
      value.push_back(ch);
    }
    return std::nullopt;
  }
  const size_t start = pos;
  while (pos < text.size()) {
    const char ch = text[pos];
    if (!(std::isalnum(static_cast<unsigned char>(ch)) || ch == '_' || ch == '$')) break;
    ++pos;
  }
  if (pos == start) return std::nullopt;
  return std::string(text.substr(start, pos - start));
}

std::optional<ParsedQualifiedName> parse_relation_name(
    std::string_view text,
    size_t& pos,
    const std::string& default_database) {
  auto first = parse_relation_identifier(text, pos);
  if (!first || first->empty()) return std::nullopt;
  while (pos < text.size() && std::isspace(static_cast<unsigned char>(text[pos]))) ++pos;
  if (pos < text.size() && text[pos] == '.') {
    ++pos;
    auto second = parse_relation_identifier(text, pos);
    if (!second || second->empty()) return std::nullopt;
    return ParsedQualifiedName{*first, *second};
  }
  return ParsedQualifiedName{default_database, *first};
}

bool relation_token_boundary(std::string_view text, size_t pos, size_t len) {
  const auto word = [](char ch) { return std::isalnum(static_cast<unsigned char>(ch)) || ch == '_'; };
  if (pos > 0 && word(text[pos - 1])) return false;
  if (pos + len < text.size() && word(text[pos + len])) return false;
  return true;
}

std::optional<size_t> find_relation_keyword_ci(
    std::string_view text,
    std::string_view keyword,
    size_t start = 0) {
  char quote = 0;
  int depth = 0;
  for (size_t i = start; i + keyword.size() <= text.size(); ++i) {
    const char ch = text[i];
    if (quote) {
      if (ch == '\\' && quote == '\'' && i + 1 < text.size()) { ++i; continue; }
      if (ch == quote) quote = 0;
      continue;
    }
    if (ch == '\'' || ch == '`' || ch == '"') { quote = ch; continue; }
    if (ch == '(') { ++depth; continue; }
    if (ch == ')') { if (depth > 0) --depth; continue; }
    if (depth != 0 || !relation_token_boundary(text, i, keyword.size())) continue;
    bool match = true;
    for (size_t j = 0; j < keyword.size(); ++j) {
      if (std::tolower(static_cast<unsigned char>(text[i + j])) !=
          std::tolower(static_cast<unsigned char>(keyword[j]))) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return std::nullopt;
}

std::vector<ParsedQualifiedName> parse_relation_sources(
    std::string_view select_sql,
    const std::string& default_database) {
  std::vector<ParsedQualifiedName> result;
  std::set<std::pair<std::string, std::string>> seen;
  for (std::string_view keyword : {std::string_view("FROM"), std::string_view("JOIN")}) {
    size_t start = 0;
    while (true) {
      const auto at = find_relation_keyword_ci(select_sql, keyword, start);
      if (!at) break;
      size_t pos = *at + keyword.size();
      while (pos < select_sql.size() && std::isspace(static_cast<unsigned char>(select_sql[pos]))) ++pos;
      if (pos < select_sql.size() && select_sql[pos] != '(') {
        auto parsed = parse_relation_name(select_sql, pos, default_database);
        if (parsed && seen.insert({parsed->database, parsed->table}).second) result.push_back(std::move(*parsed));
      }
      start = *at + keyword.size();
    }
  }
  return result;
}

std::optional<ParsedQualifiedName> parse_materialized_view_target(
    std::string_view create_sql,
    const std::string& default_database) {
  const auto mv = find_relation_keyword_ci(create_sql, "MATERIALIZED");
  if (!mv) return std::nullopt;
  const auto view = find_relation_keyword_ci(create_sql, "VIEW", *mv + 12);
  if (!view) return std::nullopt;
  const auto to = find_relation_keyword_ci(create_sql, "TO", *view + 4);
  if (!to) return std::nullopt;
  const auto as = find_relation_keyword_ci(create_sql, "AS", *view + 4);
  if (as && *to > *as) return std::nullopt;
  size_t pos = *to + 2;
  return parse_relation_name(create_sql, pos, default_database);
}

std::string block_string_at(const clickhouse::Block& block, size_t column, size_t row) {
  return ch_block_text_at(block, column, row);
}

std::optional<uint64_t> parse_u64(const std::string& value) {
  if (value.empty()) return std::nullopt;
  try {
    size_t pos = 0;
    const unsigned long long parsed = std::stoull(value, &pos, 10);
    if (pos != value.size()) return std::nullopt;
    return static_cast<uint64_t>(parsed);
  } catch (...) {
    return std::nullopt;
  }
}

std::optional<double> parse_double(const std::string& value) {
  if (value.empty()) return std::nullopt;
  try {
    size_t pos = 0;
    const double parsed = std::stod(value, &pos);
    if (pos != value.size() || !std::isfinite(parsed)) return std::nullopt;
    return parsed;
  } catch (...) {
    return std::nullopt;
  }
}

bool truthy(const std::string& value) {
  return value == "1" || value == "true" || value == "TRUE";
}

bool block_bool_at(const clickhouse::Block& block, size_t column, size_t row) {
  // DESCRIBE returns is_subcolumn as a native UInt8 on current ClickHouse
  // releases. Do not force it through the textual metadata decoder: that
  // decoder is intentionally strict and would reject a perfectly valid native
  // boolean column. Keep a textual fallback for older server/client variants.
  try {
    return ch_block_u64_at(block, column, row) != 0;
  } catch (const std::exception&) {
    return truthy(block_string_at(block, column, row));
  }
}

template <typename Fn>
bool try_select(clickhouse::Client& client, const std::string& sql, Fn&& fn, std::string* error = nullptr) {
  try {
    client.Select(sql, std::forward<Fn>(fn));
    return true;
  } catch (const std::exception& e) {
    if (error) *error = e.what();
    return false;
  }
}

struct MutableSummary {
  ExplorerTableSummary value;
  bool has_parts = false;
};

void classify_health(ExplorerTableSummary& table) {
  table.health = "healthy";
  table.warnings.clear();

  if (table.replication.available) {
    if (table.replication.readonly || table.replication.session_expired) {
      table.health = "error";
      table.warnings.push_back("Replica is read-only or its coordination session expired.");
    } else if (table.replication.absolute_delay_seconds > 60 || table.replication.queue_size > 1000) {
      table.health = "warning";
      table.warnings.push_back("Replication queue or delay is elevated.");
    } else if (table.replication.total_replicas > 0 &&
               table.replication.active_replicas < table.replication.total_replicas) {
      table.health = "warning";
      table.warnings.push_back("Not all replicas are currently active.");
    }
  }

  if (table.active_parts > 5000) {
    if (table.health == "healthy") table.health = "warning";
    table.warnings.push_back("Large number of active parts.");
  }
}

bool load_base_summaries(
    clickhouse::Client& system,
    clickhouse::Client& runner,
    const AllowedObjectSet& allowed,
    std::vector<ExplorerTableSummary>& summaries,
    std::string* error) {
  std::unordered_map<std::string, size_t> by_key;
  auto consume_tables = [&](const clickhouse::Block& block, bool has_storage_policy) {
    constexpr size_t kExpectedColumns = 13;
    if (block.GetRowCount() > 0 && block.GetColumnCount() < kExpectedColumns) {
      throw std::runtime_error(
          "system.tables metadata block has " + std::to_string(block.GetColumnCount()) +
          " columns; expected at least " + std::to_string(kExpectedColumns) + ".");
    }
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      const std::string database = block_string_at(block, 0, row);
      const std::string table = block_string_at(block, 1, row);
      if (!allowed.allows_table(database, table)) continue;
      const std::string key = table_key(database, table);
      if (by_key.count(key)) continue;

      ExplorerTableSummary summary;
      summary.database = database;
      summary.name = table;
      summary.engine = block_string_at(block, 2, row);
      summary.engine_full = block_string_at(block, 3, row);
      summary.sorting_key = block_string_at(block, 4, row);
      summary.primary_key = block_string_at(block, 5, row);
      summary.partition_key = block_string_at(block, 6, row);
      summary.sampling_key = block_string_at(block, 7, row);
      if (has_storage_policy) summary.storage_policy = block_string_at(block, 8, row);
      // system.tables is the authoritative lightweight source for engines that
      // do not create MergeTree parts (Memory, TinyLog/Log/StripeLog, Buffer,
      // dictionaries, etc.). MergeTree values are later replaced by the richer
      // system.parts aggregation, so this is a safe baseline rather than a
      // competing metric source.
      summary.rows = parse_u64(block_string_at(block, 9, row));
      const auto total_bytes = parse_u64(block_string_at(block, 10, row));
      const auto total_uncompressed_bytes = parse_u64(block_string_at(block, 11, row));
      summary.data_paths = split_unit_separator(block_string_at(block, 12, row));
      // system.tables.total_bytes is a resident-memory estimate for in-memory
      // engines. Keep Buffer/Memory/Dictionary bytes in resident_bytes so Browse
      // never presents RAM as database/ClickHouse on-disk footprint. Dictionary
      // bytes are replaced by system.dictionaries.bytes_allocated when loaded.
      if (summary.engine == "Buffer" || summary.engine == "Memory" || summary.engine == "Dictionary") {
        summary.resident_bytes = total_bytes;
        summary.logical_bytes.reset();
        summary.compressed_bytes.reset();
        summary.uncompressed_bytes.reset();
      } else {
        summary.logical_bytes = total_bytes;
        summary.compressed_bytes = total_bytes;
        summary.uncompressed_bytes = total_uncompressed_bytes;
        if (summary.engine == "TinyLog" || summary.engine == "Log" || summary.engine == "StripeLog") {
          summary.physical_bytes = total_bytes;
        }
      }
      by_key.emplace(std::move(key), summaries.size());
      summaries.push_back(std::move(summary));
    }
  };

  const std::string table_select =
    "SELECT toString(database), toString(name), toString(engine), toString(engine_full), toString(sorting_key), toString(primary_key), toString(partition_key), toString(sampling_key), toString(storage_policy), "
    "toString(total_rows), toString(total_bytes), toString(total_bytes_uncompressed), arrayStringConcat(data_paths, char(31)) "
    "FROM system.tables "
    "WHERE database NOT IN ('INFORMATION_SCHEMA', 'information_schema') ";

  std::string metadata_error;
  bool ok = try_select(system, table_select + "ORDER BY database, name",
    [&](const clickhouse::Block& block) { consume_tables(block, true); }, &metadata_error);

  // The technical account is an enrichment source, not the ACL authority. A
  // transient/native-protocol issue on its bulk system.tables stream must not
  // make every runner-readable object disappear. Retry the same backend-built
  // metadata query through the runner, whose AllowedObjectSet already defines
  // the exact visibility boundary.
  if (!ok) {
    summaries.clear();
    by_key.clear();
    std::string runner_error;
    ok = try_select(runner, table_select + "ORDER BY database, name",
      [&](const clickhouse::Block& block) { consume_tables(block, true); }, &runner_error);
    if (!ok) {
      if (error) {
        *error = "system.tables failed: " + metadata_error +
            "; runner metadata fallback failed: " + runner_error;
      }
      return false;
    }
  }

  // system.tables visibility can lag or differ for a narrowly privileged
  // technical account, especially for objects created after the process/test
  // stack started. Fill only the missing runner-authorized objects with a
  // targeted runner query. If an object disappeared between ACL discovery and
  // this lookup, simply omit that stale entry; never turn it into a global 503.
  for (const auto& entry : allowed.tables()) {
    const auto key = table_key(entry.database, entry.table);
    if (by_key.count(key)) continue;

    const std::string sql = table_select +
        "AND database = " + quote_string(entry.database) +
        " AND name = " + quote_string(entry.table) + " LIMIT 1";
    std::string runner_error;
    (void)try_select(runner, sql,
      [&](const clickhouse::Block& block) { consume_tables(block, true); }, &runner_error);
  }

  std::sort(summaries.begin(), summaries.end(), [](const auto& a, const auto& b) {
    if (a.database != b.database) return a.database < b.database;
    return a.name < b.name;
  });
  return true;
}

bool load_non_part_row_counts(
    clickhouse::Client& system,
    clickhouse::Client& runner,
    const AllowedObjectSet& allowed,
    std::unordered_map<std::string, ExplorerTableSummary*>& map,
    std::string* error) {
  // Dictionaries do not expose row counts through system.parts. When loaded,
  // system.dictionaries.element_count is the authoritative metadata value.
  std::string dictionary_error;
  const bool dictionaries_loaded = try_select(system,
    "SELECT toString(database), toString(name), toString(element_count), toString(bytes_allocated) FROM system.dictionaries",
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        const std::string database = block_string_at(block, 0, row);
        const std::string table = block_string_at(block, 1, row);
        if (!allowed.allows_table(database, table)) continue;
        const auto it = map.find(table_key(database, table));
        if (it == map.end()) continue;
        auto& target = *it->second;
        if (target.engine.find("Dictionary") == std::string::npos) continue;
        target.rows = parse_u64(block_string_at(block, 2, row));
        target.resident_bytes = parse_u64(block_string_at(block, 3, row));
        // Dictionary storage is an in-memory allocation. Its backing source is
        // a separate object and must not make the dictionary itself contribute
        // to database/ClickHouse disk totals.
        target.logical_bytes.reset();
        target.physical_bytes.reset();
        target.compressed_bytes.reset();
        target.uncompressed_bytes.reset();
      }
    }, &dictionary_error);
  if (!dictionaries_loaded && error && error->empty()) {
    *error = "Dictionary row metadata unavailable: " + dictionary_error;
  }

  // TinyLog/Log/StripeLog may legitimately report total_rows=0 in
  // system.tables on supported ClickHouse versions. Query the readable object
  // through runner_uri only in that ambiguous case. This is exact and never
  // crosses the established runner ACL boundary.
  for (auto& [key, target] : map) {
    if (!target) continue;
    const bool log_engine = target->engine == "TinyLog" || target->engine == "Log" || target->engine == "StripeLog";
    if (!log_engine || (target->rows && *target->rows > 0)) continue;
    const std::string sql = "SELECT toString(count()) FROM " + qualified_ident(target->database, target->name);
    std::string count_error;
    std::optional<uint64_t> exact;
    const bool counted = try_select(runner, sql, [&](const clickhouse::Block& block) {
      if (block.GetRowCount()) exact = parse_u64(block_string_at(block, 0, 0));
    }, &count_error);
    if (counted && exact) target->rows = exact;
    else if (!counted && error && error->empty()) *error = "Log-engine row count unavailable: " + count_error;
  }
  return true;
}

bool load_parts_summary(
    clickhouse::Client& system,
    const AllowedObjectSet& allowed,
    std::unordered_map<std::string, ExplorerTableSummary*>& map,
    std::string* error) {
  return try_select(system,
    "SELECT toString(database), toString(`table`), toString(sum(rows)), toString(sum(bytes_on_disk)), "
    "toString(sum(data_compressed_bytes)), toString(sum(data_uncompressed_bytes)), "
    "toString(count()), toString(uniqExact(partition)), "
    "arrayStringConcat(arraySort(groupUniqArray(disk_name)), ','), "
    "toString(max(modification_time)) "
    "FROM system.parts WHERE active GROUP BY database, `table`",
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        const std::string database = block_string_at(block, 0, row);
        const std::string table = block_string_at(block, 1, row);
        if (!allowed.allows_table(database, table)) continue;
        const auto it = map.find(table_key(database, table));
        if (it == map.end()) continue;
        auto& target = *it->second;
        target.rows = parse_u64(block_string_at(block, 2, row));
        target.resident_bytes = parse_u64(block_string_at(block, 3, row));
        target.logical_bytes = parse_u64(block_string_at(block, 3, row));
        target.compressed_bytes = parse_u64(block_string_at(block, 4, row));
        target.uncompressed_bytes = parse_u64(block_string_at(block, 5, row));
        target.active_parts = parse_u64(block_string_at(block, 6, row)).value_or(0);
        target.partitions = parse_u64(block_string_at(block, 7, row)).value_or(0);
        const std::string disks = block_string_at(block, 8, row);
        std::stringstream input(disks);
        for (std::string disk; std::getline(input, disk, ',');) {
          if (!disk.empty()) target.disks.push_back(std::move(disk));
        }
        target.last_part_time = block_string_at(block, 9, row);

        // A local non-replicated table's local footprint is its physical
        // footprint. Replicated/Distributed physical totals require a
        // cluster-wide mapping and are deliberately left unknown here.
        if (target.engine.find("Replicated") == std::string::npos && target.engine != "Distributed") {
          target.physical_bytes = target.logical_bytes;
        }
      }
    }, error);
}

void load_structure_bytes(
    clickhouse::Client& system,
    const AllowedObjectSet& allowed,
    std::unordered_map<std::string, ExplorerTableSummary*>& map,
    std::string* error) {
  std::string section_error;
  std::unordered_set<std::string> index_seen;
  const bool indexes_loaded = try_select(system,
    "SELECT toString(database), toString(`table`), toString(sum(secondary_indices_compressed_bytes)) "
    "FROM system.parts WHERE active GROUP BY database, `table`",
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        const std::string database = block_string_at(block, 0, row);
        const std::string table = block_string_at(block, 1, row);
        if (!allowed.allows_table(database, table)) continue;
        const auto key = table_key(database, table);
        const auto it = map.find(key);
        if (it == map.end()) continue;
        it->second->secondary_indices_bytes = parse_u64(block_string_at(block, 2, row));
        index_seen.insert(key);
      }
    }, &section_error);
  if (indexes_loaded) {
    // A successful system.parts query makes the absence of active parts a
    // known zero for on-disk index bytes. Keep unknown exclusively for failed
    // metadata reads instead of rendering a misleading 0% on errors.
    for (auto& [key, table] : map) {
      if (table && table->engine.find("MergeTree") != std::string::npos && !index_seen.count(key)) {
        table->secondary_indices_bytes = 0;
      }
    }
  } else {
    for (auto& [_, table] : map) if (table) table->secondary_indices_bytes.reset();
    if (error && error->empty() && !section_error.empty()) *error = "Skipping-index size query failed: " + section_error;
  }

  section_error.clear();
  std::unordered_set<std::string> projection_seen;
  const bool projections_loaded = try_select(system,
    "SELECT toString(database), toString(`table`), toString(sum(data_compressed_bytes)) "
    "FROM system.projection_parts WHERE active GROUP BY database, `table`",
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        const std::string database = block_string_at(block, 0, row);
        const std::string table = block_string_at(block, 1, row);
        if (!allowed.allows_table(database, table)) continue;
        const auto it = map.find(table_key(database, table));
        if (it == map.end()) continue;
        it->second->projection_bytes = parse_u64(block_string_at(block, 2, row));
        projection_seen.insert(table_key(database, table));
      }
    }, &section_error);
  if (projections_loaded) {
    // projection_parts has no row for tables with zero materialized projection
    // bytes (including empty MergeTrees). A successful query makes that absence
    // a known zero independently of the skipping-index query above.
    for (auto& [key, table] : map) {
      if (table && table->engine.find("MergeTree") != std::string::npos && !projection_seen.count(key)) {
        table->projection_bytes = 0;
      }
    }
  } else {
    for (auto& [_, table] : map) if (table) table->projection_bytes.reset();
    if (error && error->empty() && !section_error.empty()) *error = "Projection size query failed: " + section_error;
  }
}

bool load_query_ingress(
    clickhouse::Client& system,
    const AllowedObjectSet& allowed,
    std::unordered_map<std::string, ExplorerTableSummary*>& map,
    std::string* error) {
  return try_select(system,
    "SELECT toString(arrayJoin(tables)) AS object, "
    "toString(sumIf(written_rows, event_time >= now() - INTERVAL 1 MINUTE) / 60.0), "
    "toString(sumIf(written_rows, event_time >= now() - INTERVAL 5 MINUTE) / 300.0), "
    "toString(sum(written_rows) / 3600.0), "
    "toString(sumIf(written_bytes, event_time >= now() - INTERVAL 1 MINUTE) / 60.0), "
    "toString(sumIf(written_bytes, event_time >= now() - INTERVAL 5 MINUTE) / 300.0), "
    "toString(sum(written_bytes) / 3600.0), "
    "toString(sum(written_rows)), toString(sum(written_bytes)), "
    "toString(max(event_time)) "
    "FROM system.query_log "
    "WHERE event_time >= now() - INTERVAL 1 HOUR AND type = 'QueryFinish' AND written_rows > 0 "
    "GROUP BY object",
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        const std::string object = block_string_at(block, 0, row);
        const size_t dot = object.find('.');
        if (dot == std::string::npos) continue;
        const std::string database = object.substr(0, dot);
        const std::string table = object.substr(dot + 1);
        if (!allowed.allows_table(database, table)) continue;
        const auto it = map.find(table_key(database, table));
        if (it == map.end()) continue;
        auto& rate = it->second->client_ingress;
        rate.rows_per_second_1m = parse_double(block_string_at(block, 1, row));
        rate.rows_per_second_5m = parse_double(block_string_at(block, 2, row));
        rate.rows_per_second_1h = parse_double(block_string_at(block, 3, row));
        rate.bytes_per_second_1m = parse_double(block_string_at(block, 4, row));
        rate.bytes_per_second_5m = parse_double(block_string_at(block, 5, row));
        rate.bytes_per_second_1h = parse_double(block_string_at(block, 6, row));
        rate.rows_total_1h = parse_u64(block_string_at(block, 7, row));
        rate.bytes_total_1h = parse_u64(block_string_at(block, 8, row));
        rate.last_event_time = block_string_at(block, 9, row);
      }
    }, error);
}

bool load_part_ingress(
    clickhouse::Client& system,
    const AllowedObjectSet& allowed,
    std::unordered_map<std::string, ExplorerTableSummary*>& map,
    std::string* error) {
  return try_select(system,
    "SELECT toString(database), toString(`table`), "
    "toString(sumIf(rows, event_time >= now() - INTERVAL 1 MINUTE) / 60.0), "
    "toString(sumIf(rows, event_time >= now() - INTERVAL 5 MINUTE) / 300.0), "
    "toString(sum(rows) / 3600.0), "
    "toString(sumIf(size_in_bytes, event_time >= now() - INTERVAL 1 MINUTE) / 60.0), "
    "toString(sumIf(size_in_bytes, event_time >= now() - INTERVAL 5 MINUTE) / 300.0), "
    "toString(sum(size_in_bytes) / 3600.0), "
    "toString(sum(rows)), toString(sum(size_in_bytes)), "
    "toString(countIf(event_time >= now() - INTERVAL 1 MINUTE)), "
    "toString(max(event_time)) "
    "FROM system.part_log "
    "WHERE event_time >= now() - INTERVAL 1 HOUR AND event_type = 'NewPart' "
    "GROUP BY database, `table`",
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        const std::string database = block_string_at(block, 0, row);
        const std::string table = block_string_at(block, 1, row);
        if (!allowed.allows_table(database, table)) continue;
        const auto it = map.find(table_key(database, table));
        if (it == map.end()) continue;
        auto& rate = it->second->physical_ingress;
        rate.rows_per_second_1m = parse_double(block_string_at(block, 2, row));
        rate.rows_per_second_5m = parse_double(block_string_at(block, 3, row));
        rate.rows_per_second_1h = parse_double(block_string_at(block, 4, row));
        rate.bytes_per_second_1m = parse_double(block_string_at(block, 5, row));
        rate.bytes_per_second_5m = parse_double(block_string_at(block, 6, row));
        rate.bytes_per_second_1h = parse_double(block_string_at(block, 7, row));
        rate.rows_total_1h = parse_u64(block_string_at(block, 8, row));
        rate.bytes_total_1h = parse_u64(block_string_at(block, 9, row));
        rate.new_parts_per_minute = parse_u64(block_string_at(block, 10, row));
        rate.last_event_time = block_string_at(block, 11, row);
      }
    }, error);
}

bool load_replication(
    clickhouse::Client& system,
    const AllowedObjectSet& allowed,
    std::unordered_map<std::string, ExplorerTableSummary*>& map,
    std::string* error) {
  return try_select(system,
    "SELECT toString(database), toString(`table`), toString(total_replicas), toString(active_replicas), "
    "toString(queue_size), toString(absolute_delay), toString(is_readonly), "
    "toString(is_session_expired), toString(replica_name), toString(zookeeper_path) "
    "FROM system.replicas",
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        const std::string database = block_string_at(block, 0, row);
        const std::string table = block_string_at(block, 1, row);
        if (!allowed.allows_table(database, table)) continue;
        const auto it = map.find(table_key(database, table));
        if (it == map.end()) continue;
        auto& replica = it->second->replication;
        replica.available = true;
        replica.total_replicas = parse_u64(block_string_at(block, 2, row)).value_or(0);
        replica.active_replicas = parse_u64(block_string_at(block, 3, row)).value_or(0);
        replica.queue_size = parse_u64(block_string_at(block, 4, row)).value_or(0);
        replica.absolute_delay_seconds = parse_u64(block_string_at(block, 5, row)).value_or(0);
        replica.readonly = truthy(block_string_at(block, 6, row));
        replica.session_expired = truthy(block_string_at(block, 7, row));
        replica.replica_name = block_string_at(block, 8, row);
        replica.zookeeper_path = block_string_at(block, 9, row);
      }
    }, error);
}

bool load_database_summaries(
    clickhouse::Client& system,
    const AllowedObjectSet& allowed,
    const std::vector<ExplorerTableSummary>& tables,
    std::vector<ExplorerDatabaseSummary>& out,
    std::string* error) {
  std::map<std::string, ExplorerDatabaseSummary> by_database;
  for (const auto& table : tables) {
    auto& db = by_database[table.database];
    db.name = table.database;
    ++db.tables;
    db.rows += table.rows.value_or(0);
    // Database/ClickHouse footprint is disk-backed storage. Resident Memory,
    // Buffer and dictionary allocations are deliberately not mixed into it.
    db.bytes += table.logical_bytes.value_or(0);
  }

  struct Capacity { std::string host; std::string path; std::string type; std::optional<uint64_t> free; std::optional<uint64_t> total; };
  std::unordered_map<std::string, Capacity> capacity;
  std::string section_error;
  if (!try_select(system,
      "SELECT toString(hostName()), toString(name), toString(path), toString(type), toString(free_space), toString(total_space) FROM system.disks",
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          capacity[block_string_at(block, 1, row)] = {
            block_string_at(block, 0, row), block_string_at(block, 2, row), block_string_at(block, 3, row),
            parse_u64(block_string_at(block, 4, row)), parse_u64(block_string_at(block, 5, row))};
        }
      }, &section_error)) {
    if (error) *error = "Database disk capacity query failed: " + section_error;
    return false;
  }

  std::map<std::pair<std::string, std::string>, uint64_t> bytes_by_disk;
  section_error.clear();
  if (!try_select(system,
      "SELECT toString(database), toString(disk_name), toString(sum(bytes_on_disk)) FROM system.parts WHERE active GROUP BY database, disk_name",
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          const std::string database = block_string_at(block, 0, row);
          if (!allowed.allows_database(database)) continue;
          bytes_by_disk[{database, block_string_at(block, 1, row)}] = parse_u64(block_string_at(block, 2, row)).value_or(0);
        }
      }, &section_error)) {
    if (error) *error = "Database disk distribution query failed: " + section_error;
    return false;
  }

  // system.parts has no rows for the Log-family engines. Their table-level
  // total_bytes is still disk-backed, so fold it into the database disk
  // distribution when system.tables.data_paths resolves unambiguously to one
  // configured disk. This keeps the database total and its disk breakdown in
  // the same physical unit.
  for (const auto& table : tables) {
    const bool log_family = table.engine == "TinyLog" || table.engine == "Log" || table.engine == "StripeLog";
    if (!log_family || !table.logical_bytes || table.data_paths.empty()) continue;
    std::set<std::string> matched_disks;
    for (const auto& data_path : table.data_paths) {
      std::string best_disk;
      size_t best_prefix = 0;
      for (const auto& [disk_name, info] : capacity) {
        if (info.path.empty() || data_path.rfind(info.path, 0) != 0 || info.path.size() <= best_prefix) continue;
        best_disk = disk_name;
        best_prefix = info.path.size();
      }
      if (!best_disk.empty()) matched_disks.insert(best_disk);
    }
    if (matched_disks.size() == 1) {
      bytes_by_disk[{table.database, *matched_disks.begin()}] += *table.logical_bytes;
    }
  }

  for (auto& [name, db] : by_database) {
    std::set<std::string> disk_names;
    for (const auto& table : tables) if (table.database == name) disk_names.insert(table.disks.begin(), table.disks.end());
    // Log-family tables do not populate summary.disks through system.parts.
    // Include any disk resolved from their data_paths above so the database
    // breakdown actually exposes the same disk bytes already counted here.
    for (const auto& [key, _] : bytes_by_disk) {
      if (key.first == name) disk_names.insert(key.second);
    }
    for (const auto& disk_name : disk_names) {
      ExplorerDatabaseDisk disk;
      disk.name = disk_name;
      disk.bytes = bytes_by_disk[{name, disk_name}];
      if (auto it = capacity.find(disk_name); it != capacity.end()) {
        disk.host_name = it->second.host;
        disk.path = it->second.path;
        disk.type = it->second.type;
        disk.free_space = it->second.free;
        disk.total_space = it->second.total;
      }
      db.disks.push_back(std::move(disk));
    }
    out.push_back(std::move(db));
  }
  return true;
}

std::vector<std::string> allowed_columns_for_table(
    const AllowedObjectSet& allowed,
    const std::string& database,
    const std::string& table,
    clickhouse::Client& runner,
    std::vector<ExplorerPreviewColumn>* info,
    std::string* error) {
  std::vector<std::string> columns;
  const auto target = qualified_ident(database, table);
  std::string describe_error;
  const bool loaded = try_select(runner,
    "DESCRIBE TABLE " + target + " SETTINGS describe_include_subcolumns = 0",
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        const auto name = block_string_at(block, 0, row);
        if (name.empty() || !allowed.allows_column(database, table, name)) continue;
        columns.push_back(name);
        if (info) {
          ExplorerPreviewColumn column;
          column.name = name;
          column.type = block.GetColumnCount() > 1 ? block_string_at(block, 1, row) : std::string{};
          info->push_back(std::move(column));
        }
      }
    }, &describe_error);
  if (!loaded && error) *error = "DESCRIBE TABLE failed: " + describe_error;
  return columns;
}

} // namespace


bool load_explorer_catalog_index(
    clickhouse::Client& system,
    clickhouse::Client& runner,
    const AllowedObjectSet& allowed,
    ExplorerCatalog& out,
    std::string* error) {
  out = ExplorerCatalog{};
  out.generated_at_ms = now_ms();
  out.databases = allowed.databases();
  std::sort(out.databases.begin(), out.databases.end());

  std::unordered_set<std::string> seen;
  std::string table_filter = " WHERE database NOT IN ('INFORMATION_SCHEMA', 'information_schema') ";
  if (out.databases.size() == 1) {
    table_filter += "AND database = " + quote_string(out.databases.front()) + " ";
  }
  const std::string select_sql =
      "SELECT toString(database), toString(name), toString(engine), "
      "toString(total_rows), toString(total_bytes) FROM system.tables" + table_filter;

  auto consume = [&](const clickhouse::Block& block) {
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      const std::string database = block_string_at(block, 0, row);
      const std::string table = block_string_at(block, 1, row);
      if (!allowed.allows_table(database, table)) continue;
      const std::string key = table_key(database, table);
      if (!seen.insert(key).second) continue;
      ExplorerTableSummary item;
      item.database = database;
      item.name = table;
      item.engine = block_string_at(block, 2, row);
      item.rows = parse_u64(block_string_at(block, 3, row));
      const auto total_bytes = parse_u64(block_string_at(block, 4, row));
      if (item.engine == "Buffer" || item.engine == "Memory" || item.engine == "Dictionary") {
        item.resident_bytes = total_bytes;
      } else {
        item.logical_bytes = total_bytes;
        item.compressed_bytes = total_bytes;
      }
      out.tables.push_back(std::move(item));
    }
  };

  std::string system_error;
  bool loaded = try_select(system, select_sql + "ORDER BY database, name", consume, &system_error);
  if (!loaded) {
    out.tables.clear();
    seen.clear();
    std::string runner_error;
    loaded = try_select(runner, select_sql + "ORDER BY database, name", consume, &runner_error);
    if (!loaded) {
      if (error) {
        *error = "Lightweight system.tables catalog failed: " + system_error +
            "; runner fallback failed: " + runner_error;
      }
      return false;
    }
  }

  // Keep sidebar row/size statistics useful without loading the rich table
  // detail payload. For a single lazily-expanded database, one bounded parts
  // aggregation gives exact MergeTree rows/bytes for every visible table.
  if (out.databases.size() == 1) {
    std::unordered_map<std::string, ExplorerTableSummary*> by_name;
    for (auto& item : out.tables) by_name.emplace(item.name, &item);
    std::string ignored;
    (void)try_select(system,
      "SELECT toString(`table`), toString(sum(rows)), toString(sum(bytes_on_disk)) "
      "FROM system.parts WHERE active AND database = " + quote_string(out.databases.front()) +
      " GROUP BY `table`",
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          const auto it = by_name.find(block_string_at(block, 0, row));
          if (it == by_name.end() || !it->second) continue;
          it->second->rows = parse_u64(block_string_at(block, 1, row));
          const auto bytes = parse_u64(block_string_at(block, 2, row));
          it->second->logical_bytes = bytes;
          it->second->physical_bytes = bytes;
          it->second->compressed_bytes = bytes;
        }
      }, &ignored);
  }

  // The lightweight catalog intentionally asks only for identity + small
  // sidebar statistics. Fill newly created runner-visible objects one by one
  // if the technical
  // system.tables snapshot lags behind ACL discovery.
  for (const auto& entry : allowed.tables()) {
    const std::string key = table_key(entry.database, entry.table);
    if (seen.count(key)) continue;
    const std::string sql = select_sql +
        "AND database = " + quote_string(entry.database) +
        " AND name = " + quote_string(entry.table) + " LIMIT 1";
    std::string ignored;
    (void)try_select(runner, sql, consume, &ignored);
  }

  std::sort(out.tables.begin(), out.tables.end(), [](const auto& a, const auto& b) {
    if (a.database != b.database) return a.database < b.database;
    return a.name < b.name;
  });
  return true;
}

bool load_explorer_database_summaries(
    clickhouse::Client& runner,
    const std::vector<std::string>& databases,
    std::vector<ExplorerDatabaseSummary>& out,
    std::string* error) {
  out.clear();
  if (databases.empty()) return true;

  std::unordered_set<std::string> visible(databases.begin(), databases.end());
  const std::string query =
      "SELECT toString(database), toString(count()), "
      "toString(sum(if(engine IN ('Buffer','Memory','Dictionary'), toUInt64(0), ifNull(total_rows, toUInt64(0))))), "
      "toString(sum(if(engine IN ('Buffer','Memory','Dictionary'), toUInt64(0), ifNull(total_bytes, toUInt64(0))))) "
      "FROM system.tables "
      "WHERE database NOT IN ('INFORMATION_SCHEMA', 'information_schema') "
      "GROUP BY database ORDER BY database";

  std::string section_error;
  const bool loaded = try_select(runner, query, [&](const clickhouse::Block& block) {
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      const std::string database = block_string_at(block, 0, row);
      if (!visible.count(database)) continue;
      ExplorerDatabaseSummary summary;
      summary.name = database;
      summary.tables = parse_u64(block_string_at(block, 1, row)).value_or(0);
      summary.rows = parse_u64(block_string_at(block, 2, row)).value_or(0);
      summary.bytes = parse_u64(block_string_at(block, 3, row)).value_or(0);
      out.push_back(std::move(summary));
    }
  }, &section_error);
  if (!loaded) {
    if (error) *error = section_error;
    out.clear();
    return false;
  }

  std::sort(out.begin(), out.end(), [](const auto& a, const auto& b) {
    return a.name < b.name;
  });
  return true;
}


bool load_explorer_table_summary(
    clickhouse::Client& system,
    clickhouse::Client& runner,
    const AllowedObjectSet& allowed,
    const std::string& database,
    const std::string& table,
    ExplorerTableSummary& out,
    std::string* error) {
  if (!allowed.allows_table(database, table)) {
    if (error) *error = "object not found";
    return false;
  }

  out = ExplorerTableSummary{};
  const std::string db = quote_string(database);
  const std::string tbl = quote_string(table);
  const std::string base_sql =
      "SELECT toString(database), toString(name), toString(engine), toString(engine_full), "
      "toString(sorting_key), toString(primary_key), toString(partition_key), toString(sampling_key), "
      "toString(storage_policy), toString(total_rows), toString(total_bytes), "
      "toString(total_bytes_uncompressed), arrayStringConcat(data_paths, char(31)) "
      "FROM system.tables WHERE database = " + db + " AND name = " + tbl + " LIMIT 1";

  auto consume_base = [&](const clickhouse::Block& block) {
    if (!block.GetRowCount()) return;
    out.database = block_string_at(block, 0, 0);
    out.name = block_string_at(block, 1, 0);
    out.engine = block_string_at(block, 2, 0);
    out.engine_full = block_string_at(block, 3, 0);
    out.sorting_key = block_string_at(block, 4, 0);
    out.primary_key = block_string_at(block, 5, 0);
    out.partition_key = block_string_at(block, 6, 0);
    out.sampling_key = block_string_at(block, 7, 0);
    out.storage_policy = block_string_at(block, 8, 0);
    out.rows = parse_u64(block_string_at(block, 9, 0));
    const auto total_bytes = parse_u64(block_string_at(block, 10, 0));
    const auto total_uncompressed_bytes = parse_u64(block_string_at(block, 11, 0));
    out.data_paths = split_unit_separator(block_string_at(block, 12, 0));
    if (out.engine == "Buffer" || out.engine == "Memory" || out.engine == "Dictionary") {
      out.resident_bytes = total_bytes;
    } else {
      out.logical_bytes = total_bytes;
      out.compressed_bytes = total_bytes;
      out.uncompressed_bytes = total_uncompressed_bytes;
      if (out.engine == "TinyLog" || out.engine == "Log" || out.engine == "StripeLog") {
        out.physical_bytes = total_bytes;
      }
    }
  };

  std::string base_error;
  bool loaded = try_select(system, base_sql, consume_base, &base_error);
  if (!loaded || out.database.empty()) {
    out = ExplorerTableSummary{};
    std::string runner_error;
    loaded = try_select(runner, base_sql, consume_base, &runner_error);
    if (!loaded || out.database.empty()) {
      if (error) {
        *error = "Table summary metadata failed for " + database + "." + table +
            (runner_error.empty() ? std::string{} : ": " + runner_error);
      }
      return false;
    }
  }

  // Resolve exact rows / resident allocation for engines that do not own
  // MergeTree parts. All queries are restricted to the selected object.
  //
  // For Buffer, system.tables.total_rows is the readable Buffer surface and can
  // include the destination table. Explorer must display resident buffered rows,
  // not "buffer + destination". Subtract the destination's lightweight row
  // count from the same system.tables source, and leave the value unknown if the
  // two snapshots cannot be reconciled safely.
  if (out.engine == "Buffer") {
    const auto args = parse_engine_arguments_local(out.engine_full, "Buffer");
    if (out.rows && args.size() >= 2 && !args[1].empty()) {
      const std::string target_database = resolve_buffer_database_arg(args[0], database);
      const std::string target_table = args[1];
      std::optional<uint64_t> target_rows;
      const std::string target_sql =
          "SELECT toString(total_rows) FROM system.tables WHERE database = " + quote_string(target_database) +
          " AND name = " + quote_string(target_table) + " LIMIT 1";
      std::string target_error;
      bool target_loaded = try_select(system, target_sql,
        [&](const clickhouse::Block& block) {
          if (block.GetRowCount()) target_rows = parse_u64(block_string_at(block, 0, 0));
        }, &target_error);
      if (!target_loaded || !target_rows) {
        target_rows.reset();
        std::string runner_error;
        (void)try_select(runner, target_sql,
          [&](const clickhouse::Block& block) {
            if (block.GetRowCount()) target_rows = parse_u64(block_string_at(block, 0, 0));
          }, &runner_error);
      }
      if (target_rows && *out.rows >= *target_rows) out.rows = *out.rows - *target_rows;
      else out.rows.reset();
    }
  } else if (out.engine == "Dictionary") {
    std::string ignored;
    (void)try_select(system,
      "SELECT toString(element_count), toString(bytes_allocated) FROM system.dictionaries "
      "WHERE database = " + db + " AND name = " + tbl + " LIMIT 1",
      [&](const clickhouse::Block& block) {
        if (!block.GetRowCount()) return;
        out.rows = parse_u64(block_string_at(block, 0, 0));
        out.resident_bytes = parse_u64(block_string_at(block, 1, 0));
      }, &ignored);
  } else if ((out.engine == "TinyLog" || out.engine == "Log" || out.engine == "StripeLog") &&
             (!out.rows || *out.rows == 0)) {
    std::string ignored;
    (void)try_select(runner, "SELECT toString(count()) FROM " + qualified_ident(database, table),
      [&](const clickhouse::Block& block) {
        if (block.GetRowCount()) out.rows = parse_u64(block_string_at(block, 0, 0));
      }, &ignored);
  }

  if (out.engine.find("MergeTree") != std::string::npos) {
    std::string section_error;
    (void)try_select(system,
      "SELECT toString(sum(rows)), toString(sum(bytes_on_disk)), toString(sum(data_compressed_bytes)), "
      "toString(sum(data_uncompressed_bytes)), toString(count()), toString(uniqExact(partition)), "
      "arrayStringConcat(arraySort(groupUniqArray(disk_name)), ','), toString(max(modification_time)) "
      "FROM system.parts WHERE active AND database = " + db + " AND `table` = " + tbl,
      [&](const clickhouse::Block& block) {
        if (!block.GetRowCount()) return;
        out.rows = parse_u64(block_string_at(block, 0, 0));
        out.resident_bytes = parse_u64(block_string_at(block, 1, 0));
        out.logical_bytes = parse_u64(block_string_at(block, 1, 0));
        out.compressed_bytes = parse_u64(block_string_at(block, 2, 0));
        out.uncompressed_bytes = parse_u64(block_string_at(block, 3, 0));
        out.active_parts = parse_u64(block_string_at(block, 4, 0)).value_or(0);
        out.partitions = parse_u64(block_string_at(block, 5, 0)).value_or(0);
        const std::string disks = block_string_at(block, 6, 0);
        std::stringstream input(disks);
        for (std::string disk; std::getline(input, disk, ',');) if (!disk.empty()) out.disks.push_back(std::move(disk));
        out.last_part_time = block_string_at(block, 7, 0);
        if (out.engine.find("Replicated") == std::string::npos && out.engine != "Distributed") {
          out.physical_bytes = out.logical_bytes;
        }
      }, &section_error);

    section_error.clear();
    (void)try_select(system,
      "SELECT toString(sum(secondary_indices_compressed_bytes)) FROM system.parts "
      "WHERE active AND database = " + db + " AND `table` = " + tbl,
      [&](const clickhouse::Block& block) {
        if (block.GetRowCount()) out.secondary_indices_bytes = parse_u64(block_string_at(block, 0, 0)).value_or(0);
      }, &section_error);

    section_error.clear();
    (void)try_select(system,
      "SELECT toString(sum(data_compressed_bytes)) FROM system.projection_parts "
      "WHERE active AND database = " + db + " AND `table` = " + tbl,
      [&](const clickhouse::Block& block) {
        if (block.GetRowCount()) out.projection_bytes = parse_u64(block_string_at(block, 0, 0)).value_or(0);
      }, &section_error);
  }

  // Ingress and replication are detail-only metrics. Keep them lazy and scope
  // every system-log query to this exact table instead of scanning the server
  // catalog whenever Explorer opens.
  std::string ignored;
  const std::string object = quote_string(database + "." + table);
  (void)try_select(system,
    "SELECT toString(sumIf(written_rows, event_time >= now() - INTERVAL 1 MINUTE) / 60.0), "
    "toString(sumIf(written_rows, event_time >= now() - INTERVAL 5 MINUTE) / 300.0), "
    "toString(sum(written_rows) / 3600.0), "
    "toString(sumIf(written_bytes, event_time >= now() - INTERVAL 1 MINUTE) / 60.0), "
    "toString(sumIf(written_bytes, event_time >= now() - INTERVAL 5 MINUTE) / 300.0), "
    "toString(sum(written_bytes) / 3600.0), toString(sum(written_rows)), toString(sum(written_bytes)), "
    "toString(max(event_time)) FROM system.query_log "
    "WHERE event_time >= now() - INTERVAL 1 HOUR AND type = 'QueryFinish' AND written_rows > 0 "
    "AND has(tables, " + object + ")",
    [&](const clickhouse::Block& block) {
      if (!block.GetRowCount()) return;
      auto& rate = out.client_ingress;
      rate.rows_per_second_1m = parse_double(block_string_at(block, 0, 0));
      rate.rows_per_second_5m = parse_double(block_string_at(block, 1, 0));
      rate.rows_per_second_1h = parse_double(block_string_at(block, 2, 0));
      rate.bytes_per_second_1m = parse_double(block_string_at(block, 3, 0));
      rate.bytes_per_second_5m = parse_double(block_string_at(block, 4, 0));
      rate.bytes_per_second_1h = parse_double(block_string_at(block, 5, 0));
      rate.rows_total_1h = parse_u64(block_string_at(block, 6, 0));
      rate.bytes_total_1h = parse_u64(block_string_at(block, 7, 0));
      rate.last_event_time = block_string_at(block, 8, 0);
    }, &ignored);

  ignored.clear();
  (void)try_select(system,
    "SELECT toString(sumIf(rows, event_time >= now() - INTERVAL 1 MINUTE) / 60.0), "
    "toString(sumIf(rows, event_time >= now() - INTERVAL 5 MINUTE) / 300.0), "
    "toString(sum(rows) / 3600.0), "
    "toString(sumIf(size_in_bytes, event_time >= now() - INTERVAL 1 MINUTE) / 60.0), "
    "toString(sumIf(size_in_bytes, event_time >= now() - INTERVAL 5 MINUTE) / 300.0), "
    "toString(sum(size_in_bytes) / 3600.0), toString(sum(rows)), toString(sum(size_in_bytes)), "
    "toString(countIf(event_time >= now() - INTERVAL 1 MINUTE)), toString(max(event_time)) "
    "FROM system.part_log WHERE event_time >= now() - INTERVAL 1 HOUR AND event_type = 'NewPart' "
    "AND database = " + db + " AND `table` = " + tbl,
    [&](const clickhouse::Block& block) {
      if (!block.GetRowCount()) return;
      auto& rate = out.physical_ingress;
      rate.rows_per_second_1m = parse_double(block_string_at(block, 0, 0));
      rate.rows_per_second_5m = parse_double(block_string_at(block, 1, 0));
      rate.rows_per_second_1h = parse_double(block_string_at(block, 2, 0));
      rate.bytes_per_second_1m = parse_double(block_string_at(block, 3, 0));
      rate.bytes_per_second_5m = parse_double(block_string_at(block, 4, 0));
      rate.bytes_per_second_1h = parse_double(block_string_at(block, 5, 0));
      rate.rows_total_1h = parse_u64(block_string_at(block, 6, 0));
      rate.bytes_total_1h = parse_u64(block_string_at(block, 7, 0));
      rate.new_parts_per_minute = parse_u64(block_string_at(block, 8, 0));
      rate.last_event_time = block_string_at(block, 9, 0);
    }, &ignored);

  ignored.clear();
  (void)try_select(system,
    "SELECT toString(total_replicas), toString(active_replicas), toString(queue_size), "
    "toString(absolute_delay), toString(is_readonly), toString(is_session_expired), "
    "toString(replica_name), toString(zookeeper_path) FROM system.replicas "
    "WHERE database = " + db + " AND `table` = " + tbl + " LIMIT 1",
    [&](const clickhouse::Block& block) {
      if (!block.GetRowCount()) return;
      auto& replica = out.replication;
      replica.available = true;
      replica.total_replicas = parse_u64(block_string_at(block, 0, 0)).value_or(0);
      replica.active_replicas = parse_u64(block_string_at(block, 1, 0)).value_or(0);
      replica.queue_size = parse_u64(block_string_at(block, 2, 0)).value_or(0);
      replica.absolute_delay_seconds = parse_u64(block_string_at(block, 3, 0)).value_or(0);
      replica.readonly = truthy(block_string_at(block, 4, 0));
      replica.session_expired = truthy(block_string_at(block, 5, 0));
      replica.replica_name = block_string_at(block, 6, 0);
      replica.zookeeper_path = block_string_at(block, 7, 0);
    }, &ignored);

  classify_health(out);
  return true;
}

bool load_explorer_catalog(
    clickhouse::Client& system,
    clickhouse::Client& runner,
    const AllowedObjectSet& allowed,
    ExplorerCatalog& out,
    std::string* error) {
  out = ExplorerCatalog{};
  out.generated_at_ms = now_ms();
  out.databases = allowed.databases();
  std::sort(out.databases.begin(), out.databases.end());

  if (!load_base_summaries(system, runner, allowed, out.tables, error)) return false;

  std::unordered_map<std::string, ExplorerTableSummary*> map;
  map.reserve(out.tables.size());
  for (auto& table : out.tables) map.emplace(table_key(table.database, table.name), &table);

  std::string section_error;
  // Buffer total_rows and the destination total_rows must come from the same
  // system.tables snapshot. Normalize before system.parts replaces MergeTree
  // counts with a later physical snapshot.
  normalize_buffer_runtime_rows(out.tables);

  // Populate engines that do not own MergeTree parts before database totals and
  // graph nodes are derived from the catalog. Failures are intentionally
  // best-effort: metadata remains usable with an unknown row count.
  load_non_part_row_counts(system, runner, allowed, map, &section_error);
  section_error.clear();
  if (!load_parts_summary(system, allowed, map, &section_error)) {
    if (error) *error = "Parts summary query failed: " + section_error;
    return false;
  }
  section_error.clear();
  load_structure_bytes(system, allowed, map, &section_error);
  section_error.clear();
  if (!load_query_ingress(system, allowed, map, &section_error)) {
    if (error) *error = "Query ingress query failed: " + section_error;
    return false;
  }
  out.query_log_available = true;
  section_error.clear();
  if (!load_part_ingress(system, allowed, map, &section_error)) {
    if (error) *error = "Part ingress query failed: " + section_error;
    return false;
  }
  out.part_log_available = true;
  section_error.clear();
  if (!load_replication(system, allowed, map, &section_error)) {
    if (error) *error = "Replication metadata query failed: " + section_error;
    return false;
  }
  out.replication_available = true;

  section_error.clear();
  if (!load_database_summaries(system, allowed, out.tables, out.database_summaries, &section_error)) {
    if (error) *error = section_error;
    return false;
  }

  for (auto& table : out.tables) classify_health(table);
  return true;
}

bool load_explorer_table_detail(
    clickhouse::Client& system,
    clickhouse::Client& runner,
    const AllowedObjectSet& allowed,
    const std::string& database,
    const std::string& table,
    const ExplorerTableSummary& summary,
    ExplorerTableDetail& out,
    std::string* error) {
  if (!allowed.allows_table(database, table) ||
      summary.database != database || summary.name != table) {
    if (error) *error = "object not found";
    return false;
  }

  out = ExplorerTableDetail{};
  out.summary = summary;

  const std::string db = quote_string(database);
  const std::string tbl = quote_string(table);

  std::string section_error;
  const std::string ddl_sql =
      "SELECT toString(create_table_query) FROM system.tables WHERE database = " + db + " AND name = " + tbl + " LIMIT 1";
  auto load_ddl = [&](clickhouse::Client& client, std::string* load_error) {
    return try_select(client, ddl_sql,
      [&](const clickhouse::Block& block) {
        if (block.GetRowCount() == 0 || block.GetColumnCount() == 0) return;
        out.create_table_query = block_string_at(block, 0, 0);
      }, load_error);
  };
  bool table_loaded = load_ddl(system, &section_error);
  if (!table_loaded || out.create_table_query.empty()) {
    // Per-object metadata is safe to recover through runner_uri after the ACL
    // boundary has already accepted this exact object. This also handles newly
    // created runner-readable tables that are not yet visible to the technical
    // metadata connection.
    out.create_table_query.clear();
    std::string runner_error;
    table_loaded = load_ddl(runner, &runner_error);
    if (!table_loaded || out.create_table_query.empty()) {
      if (error) {
        *error = "DDL metadata query failed for " + database + "." + table +
            (runner_error.empty() ? std::string{} : ": " + runner_error);
      }
      return false;
    }
  }

  section_error.clear();
  // system.columns does not expose ttl_expression on every supported ClickHouse
  // release (notably 26.7). Keep the stable fields here and load column TTLs
  // from DESCRIBE TABLE below, whose schema contains ttl_expression.
  const std::string columns_sql =
    "SELECT toString(name), toString(type), toString(default_kind), toString(default_expression), toString(compression_codec), "
    "toString(data_compressed_bytes), toString(data_uncompressed_bytes) "
    "FROM system.columns WHERE database = " + db + " AND `table` = " + tbl + " ORDER BY position";
  auto load_columns = [&](clickhouse::Client& client, std::string* load_error) {
    return try_select(client, columns_sql,
      [&](const clickhouse::Block& block) {
        constexpr size_t kExpectedColumns = 7;
        if (block.GetRowCount() > 0 && block.GetColumnCount() < kExpectedColumns) {
          throw std::runtime_error(
              "system.columns metadata block has " + std::to_string(block.GetColumnCount()) +
              " columns; expected at least " + std::to_string(kExpectedColumns) + ".");
        }
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          const std::string name = block_string_at(block, 0, row);
          if (!allowed.allows_column(database, table, name)) continue;
          ExplorerColumnInfo column;
          column.name = name;
          column.type = block_string_at(block, 1, row);
          column.default_kind = block_string_at(block, 2, row);
          column.default_expression = block_string_at(block, 3, row);
          column.codec_expression = block_string_at(block, 4, row);
          column.compressed_bytes = parse_u64(block_string_at(block, 5, row));
          column.uncompressed_bytes = parse_u64(block_string_at(block, 6, row));
          out.columns.push_back(std::move(column));
        }
      }, load_error);
  };

  bool columns_loaded = load_columns(system, &section_error);
  if (!columns_loaded || out.columns.empty()) {
    out.columns.clear();
    std::string runner_error;
    columns_loaded = load_columns(runner, &runner_error);
    if (!columns_loaded) {
      if (error) *error = "Column metadata query failed: " + runner_error;
      return false;
    }
  }
  if (out.columns.empty()) {
    if (error) *error = "Column metadata query returned no readable columns for " + database + "." + table;
    return false;
  }

  // system.columns.compression_codec is intentionally empty when a column has
  // no explicit CODEC(). For MergeTree we can still expose what ClickHouse
  // actually used for those columns by reading the default codec recorded on
  // active parts. This is more useful than the ambiguous UI label "server
  // default" and also correctly represents tables whose old/new parts use
  // different defaults after a settings or compression-policy change.
  if (summary.engine.find("MergeTree") != std::string::npos) {
    std::string codec_error;
    (void)try_select(system,
      "SELECT arrayStringConcat(arraySort(groupUniqArray(default_compression_codec)), char(31)) "
      "FROM system.parts WHERE active AND database = " + db + " AND `table` = " + tbl,
      [&](const clickhouse::Block& block) {
        if (!block.GetRowCount() || !block.GetColumnCount()) return;
        out.default_compression_codecs = split_unit_separator(block_string_at(block, 0, 0));
        out.default_compression_codecs.erase(
          std::remove_if(out.default_compression_codecs.begin(), out.default_compression_codecs.end(),
            [](const std::string& value) { return value.empty(); }),
          out.default_compression_codecs.end());
      }, &codec_error);
  }

  // DESCRIBE TABLE is deliberately metadata-only and version-stable for column
  // TTLs. Include subcolumns so the Browse storage breakdown can expose named
  // Tuple fields (for example `<sensor_packet.station.code>`) instead of hiding
  // all tuple storage behind the parent column. The runner ACL is still applied
  // at the top-level column boundary: a subcolumn is visible only when its
  // longest matching top-level parent is readable.
  std::unordered_map<std::string, ExplorerColumnInfo*> columns_by_name;
  columns_by_name.reserve(out.columns.size());
  for (auto& column : out.columns) columns_by_name.emplace(column.name, &column);
  std::vector<ExplorerColumnInfo> described_subcolumns;
  section_error.clear();
  const std::string describe_sql =
    "DESCRIBE TABLE " + quote_ident(database) + "." + quote_ident(table) +
    " SETTINGS describe_include_subcolumns = 1";
  auto load_describe = [&](clickhouse::Client& client, std::string* load_error) {
    return try_select(client, describe_sql,
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          if (block.GetColumnCount() < 7) continue;
          const std::string name = block_string_at(block, 0, row);
          const bool is_subcolumn = block.GetColumnCount() >= 8 && block_bool_at(block, 7, row);
          if (!is_subcolumn) {
            const auto it = columns_by_name.find(name);
            if (it == columns_by_name.end()) continue;
            auto& column = *it->second;
            const std::string described_codec = block_string_at(block, 5, row);
            const std::string described_ttl = block_string_at(block, 6, row);
            if (column.codec_expression.empty() && !described_codec.empty()) column.codec_expression = described_codec;
            column.ttl_expression = described_ttl;
            continue;
          }

          ExplorerColumnInfo* parent = nullptr;
          size_t parent_length = 0;
          for (auto& candidate : out.columns) {
            const std::string prefix = candidate.name + ".";
            if (name.size() <= prefix.size() || name.compare(0, prefix.size(), prefix) != 0) continue;
            if (candidate.name.size() > parent_length) {
              parent = &candidate;
              parent_length = candidate.name.size();
            }
          }
          if (!parent || parent->type.find("Tuple(") == std::string::npos) continue;

          ExplorerColumnInfo subcolumn;
          subcolumn.name = name;
          subcolumn.type = block_string_at(block, 1, row);
          // Intermediate Tuple subcolumns are structural containers and do not
          // own a physical stream in MergeTree parts. Showing them would produce
          // a misleading size row with no bytes; keep the leaf tuple fields that
          // system.parts_columns can actually account for.
          if (subcolumn.type.rfind("Tuple(", 0) == 0 || subcolumn.type.rfind("NamedTuple(", 0) == 0) continue;
          subcolumn.default_kind = block_string_at(block, 2, row);
          subcolumn.default_expression = block_string_at(block, 3, row);
          subcolumn.codec_expression = block_string_at(block, 5, row);
          if (subcolumn.codec_expression.empty()) subcolumn.codec_expression = parent->codec_expression;
          subcolumn.ttl_expression = block_string_at(block, 6, row);
          subcolumn.is_subcolumn = true;
          subcolumn.parent_name = parent->name;
          described_subcolumns.push_back(std::move(subcolumn));
        }
      }, load_error);
  };

  bool describe_loaded = load_describe(system, &section_error);
  if (!describe_loaded) {
    described_subcolumns.clear();
    for (auto& column : out.columns) column.ttl_expression.clear();
    std::string runner_error;
    describe_loaded = load_describe(runner, &runner_error);
    if (!describe_loaded) {
      if (error) *error = "Column DESCRIBE metadata query failed: " + runner_error;
      return false;
    }
  }


  if (!described_subcolumns.empty()) {
    std::vector<ExplorerColumnInfo> ordered;
    ordered.reserve(out.columns.size() + described_subcolumns.size());
    for (auto& column : out.columns) {
      const std::string parent_name = column.name;
      ordered.push_back(std::move(column));
      for (auto& subcolumn : described_subcolumns) {
        if (subcolumn.parent_name == parent_name) ordered.push_back(std::move(subcolumn));
      }
    }
    out.columns = std::move(ordered);
  }

  // Compact parts physically interleave all columns in one data file. ClickHouse
  // intentionally reports column_data_* = 0 for those parts, including in
  // system.parts_columns. Exact per-column Compact compressed bytes therefore
  // do not exist as metadata. Keep exact *table/part-type* totals from
  // system.parts and use system.parts_columns only for the independently stored
  // Wide portion. This avoids both a user-data scan and fabricated allocations.
  uint64_t compact_parts = 0;
  uint64_t wide_parts = 0;
  uint64_t compact_on_disk = 0;
  uint64_t wide_on_disk = 0;
  uint64_t compact_compressed = 0;
  uint64_t compact_uncompressed = 0;
  uint64_t wide_compressed = 0;
  uint64_t wide_uncompressed = 0;
  section_error.clear();
  const bool column_part_types_loaded = try_select(system,
    "SELECT "
    "toString(countIf(part_type = 'Compact')), toString(countIf(part_type = 'Wide')), "
    "toString(sumIf(bytes_on_disk, part_type = 'Compact')), "
    "toString(sumIf(bytes_on_disk, part_type = 'Wide')), "
    "toString(sumIf(data_compressed_bytes, part_type = 'Compact')), "
    "toString(sumIf(data_uncompressed_bytes, part_type = 'Compact')), "
    "toString(sumIf(data_compressed_bytes, part_type = 'Wide')), "
    "toString(sumIf(data_uncompressed_bytes, part_type = 'Wide')) "
    "FROM system.parts WHERE active AND database = " + db + " AND `table` = " + tbl,
    [&](const clickhouse::Block& block) {
      if (!block.GetRowCount()) return;
      compact_parts = parse_u64(block_string_at(block, 0, 0)).value_or(0);
      wide_parts = parse_u64(block_string_at(block, 1, 0)).value_or(0);
      compact_on_disk = parse_u64(block_string_at(block, 2, 0)).value_or(0);
      wide_on_disk = parse_u64(block_string_at(block, 3, 0)).value_or(0);
      compact_compressed = parse_u64(block_string_at(block, 4, 0)).value_or(0);
      compact_uncompressed = parse_u64(block_string_at(block, 5, 0)).value_or(0);
      wide_compressed = parse_u64(block_string_at(block, 6, 0)).value_or(0);
      wide_uncompressed = parse_u64(block_string_at(block, 7, 0)).value_or(0);
    }, &section_error);
  if (!column_part_types_loaded) {
    if (error) *error = "Column storage-format query failed: " + section_error;
    return false;
  }

  out.column_storage.compact_parts = compact_parts;
  out.column_storage.wide_parts = wide_parts;
  if (compact_parts > 0) {
    out.column_storage.compact_on_disk_bytes = compact_on_disk;
    out.column_storage.compact_compressed_bytes = compact_compressed;
    out.column_storage.compact_uncompressed_bytes = compact_uncompressed;
  }
  if (wide_parts > 0) {
    out.column_storage.wide_on_disk_bytes = wide_on_disk;
    out.column_storage.wide_compressed_bytes = wide_compressed;
    out.column_storage.wide_uncompressed_bytes = wide_uncompressed;
  }

  if (compact_parts > 0 || wide_parts > 0) {
    // system.columns aggregates the same counters but does not distinguish part
    // format. Rebuild per-column size metrics from system.parts_columns so mixed
    // tables clearly mean "Wide bytes" instead of silently excluding Compact.
    for (auto& column : out.columns) {
      column.compressed_bytes.reset();
      column.uncompressed_bytes.reset();
      column.relative_weight.reset();
    }

    if (wide_parts > 0) {
      std::unordered_map<std::string, ExplorerColumnInfo*> column_by_name;
      std::unordered_map<std::string, ExplorerColumnInfo*> subcolumn_by_name;
      column_by_name.reserve(out.columns.size());
      subcolumn_by_name.reserve(out.columns.size());
      for (auto& column : out.columns) {
        if (column.is_subcolumn) subcolumn_by_name.emplace(column.name, &column);
        else column_by_name.emplace(column.name, &column);
      }

      bool saw_wide_column = false;
      section_error.clear();
      const bool wide_column_sizes_loaded = try_select(system,
        "SELECT toString(column), "
        "toString(sumIf(column_data_compressed_bytes, part_type = 'Wide')), "
        "toString(sumIf(column_data_uncompressed_bytes, part_type = 'Wide')) "
        "FROM system.parts_columns WHERE active AND database = " + db + " AND `table` = " + tbl +
        " GROUP BY column ORDER BY column",
        [&](const clickhouse::Block& block) {
          for (size_t row = 0; row < block.GetRowCount(); ++row) {
            const std::string name = block_string_at(block, 0, row);
            const auto it = column_by_name.find(name);
            if (it == column_by_name.end()) continue;
            const auto compressed = parse_u64(block_string_at(block, 1, row));
            const auto uncompressed = parse_u64(block_string_at(block, 2, row));
            if (!compressed || !uncompressed) continue;
            it->second->compressed_bytes = *compressed;
            it->second->uncompressed_bytes = *uncompressed;
            saw_wide_column = true;
          }
        }, &section_error);
      if (!wide_column_sizes_loaded) {
        out.unavailable_sections.push_back("wide_column_sizes");
      } else if (!saw_wide_column && wide_compressed > 0) {
        out.unavailable_sections.push_back("wide_column_sizes");
      }

      // Modern MergeTree parts expose exact nested-stream counters in the
      // `subcolumns.*` arrays. Aggregate them by the DESCRIBE-visible dot path
      // so named Tuple fields can be compared without reading user data.
      if (!subcolumn_by_name.empty()) {
        section_error.clear();
        const bool wide_subcolumn_sizes_loaded = try_select(system,
          "SELECT toString(column), toString(tupleElement(sc, 1)), "
          "toString(sum(tupleElement(sc, 2))), toString(sum(tupleElement(sc, 3))) "
          "FROM (SELECT column, arrayJoin(arrayZip(subcolumns.names, subcolumns.data_compressed_bytes, "
          "subcolumns.data_uncompressed_bytes)) AS sc FROM system.parts_columns "
          "WHERE active AND part_type = 'Wide' AND database = " + db + " AND `table` = " + tbl + ") "
          "GROUP BY column, tupleElement(sc, 1) ORDER BY column, tupleElement(sc, 1)",
          [&](const clickhouse::Block& block) {
            for (size_t row = 0; row < block.GetRowCount(); ++row) {
              const std::string parent = block_string_at(block, 0, row);
              const std::string relative = block_string_at(block, 1, row);
              const auto it = subcolumn_by_name.find(parent + "." + relative);
              if (it == subcolumn_by_name.end()) continue;
              const auto compressed = parse_u64(block_string_at(block, 2, row));
              const auto uncompressed = parse_u64(block_string_at(block, 3, row));
              if (compressed) it->second->compressed_bytes = *compressed;
              if (uncompressed) it->second->uncompressed_bytes = *uncompressed;
            }
          }, &section_error);
        if (!wide_subcolumn_sizes_loaded) {
          out.unavailable_sections.push_back("wide_subcolumn_sizes");
        }
      }
    }

    // Relative weight is always against the exact Wide data total. Top-level
    // Tuple rows and their subcolumn rows intentionally overlap semantically,
    // so summing visible rows would double-count nested storage.
    if (wide_compressed > 0) {
      for (auto& column : out.columns) {
        if (column.compressed_bytes) {
          column.relative_weight = static_cast<double>(*column.compressed_bytes) /
              static_cast<double>(wide_compressed);
        }
      }
    }

    if (compact_parts > 0 && wide_parts == 0) {
      out.unavailable_sections.push_back("column_sizes_compact_shared");
    } else if (compact_parts > 0) {
      out.unavailable_sections.push_back("column_sizes_mixed_shared");
    }
  }

  bool storage_loaded = try_select(system,
    "SELECT toString(disk_name), toString(sum(bytes_on_disk)), toString(sum(rows)), toString(count()) "
    "FROM system.parts WHERE active AND database = " + db + " AND `table` = " + tbl + " GROUP BY disk_name ORDER BY disk_name",
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        ExplorerStorageDisk disk;
        disk.disk = block_string_at(block, 0, row);
        disk.bytes = parse_u64(block_string_at(block, 1, row));
        disk.rows = parse_u64(block_string_at(block, 2, row));
        disk.parts = parse_u64(block_string_at(block, 3, row)).value_or(0);
        out.storage.push_back(std::move(disk));
      }
    }, &section_error);
  if (!storage_loaded) {
      if (error) *error = "Storage metadata query failed: " + section_error;
      return false;
    }

  // TinyLog/Log/StripeLog are persistent disk engines but do not create
  // MergeTree parts, so system.parts is correctly empty. Resolve their
  // system.tables.data_paths against system.disks and expose the physical
  // placement without inventing parts. When a table spans more than one disk
  // ClickHouse does not give us a per-path byte split here; leave per-disk bytes
  // unknown instead of duplicating the table total across every disk.
  const bool log_family = summary.engine == "TinyLog" || summary.engine == "Log" || summary.engine == "StripeLog";
  if (out.storage.empty() && log_family && !summary.data_paths.empty()) {
    struct DiskMeta {
      std::string name;
      std::string path;
      std::optional<uint64_t> free_space;
      std::optional<uint64_t> total_space;
    };
    std::vector<DiskMeta> disks;
    section_error.clear();
    const bool disks_loaded = try_select(system,
      "SELECT toString(name), toString(path), toString(free_space), toString(total_space) FROM system.disks",
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          disks.push_back({
            block_string_at(block, 0, row),
            block_string_at(block, 1, row),
            parse_u64(block_string_at(block, 2, row)),
            parse_u64(block_string_at(block, 3, row)),
          });
        }
      }, &section_error);
    if (!disks_loaded) {
      if (error) *error = "Log-engine disk metadata query failed: " + section_error;
      return false;
    }

    std::map<std::string, DiskMeta> matched;
    for (const auto& data_path : summary.data_paths) {
      const DiskMeta* best = nullptr;
      size_t best_prefix = 0;
      for (const auto& disk : disks) {
        if (disk.path.empty() || data_path.rfind(disk.path, 0) != 0 || disk.path.size() <= best_prefix) continue;
        best = &disk;
        best_prefix = disk.path.size();
      }
      if (best) matched.emplace(best->name, *best);
    }

    const bool exact_single_disk = matched.size() == 1;
    for (const auto& [name, disk_meta] : matched) {
      ExplorerStorageDisk disk;
      disk.disk = name;
      disk.path = disk_meta.path;
      disk.free_space = disk_meta.free_space;
      disk.total_space = disk_meta.total_space;
      if (exact_single_disk) {
        disk.bytes = summary.logical_bytes;
        disk.rows = summary.rows;
      }
      disk.parts = 0;
      out.storage.push_back(std::move(disk));
    }
  }
  if (storage_loaded && !out.storage.empty()) {
    // system.disks is queried once and only disk names already associated with
    // this allowed table are exposed to the caller. This prevents unrelated
    // infrastructure metadata from leaking through a table detail request.
    std::unordered_map<std::string, ExplorerStorageDisk*> storage_by_name;
    for (auto& disk : out.storage) storage_by_name.emplace(disk.disk, &disk);
    const bool disks_loaded = try_select(system,
      "SELECT toString(name), toString(path), toString(free_space), toString(total_space) FROM system.disks",
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          const auto it = storage_by_name.find(block_string_at(block, 0, row));
          if (it == storage_by_name.end()) continue;
          it->second->path = block_string_at(block, 1, row);
          it->second->free_space = parse_u64(block_string_at(block, 2, row));
          it->second->total_space = parse_u64(block_string_at(block, 3, row));
        }
      }, &section_error);
    if (!disks_loaded) {
      if (error) *error = "Disk capacity query failed: " + section_error;
      return false;
    }
  }

  bool parts_loaded = try_select(system,
    "SELECT toString(name), toString(partition), toString(disk_name), toString(rows), toString(bytes_on_disk), toString(marks), toString(files), "
    "toString(level), toString(dateDiff('second', modification_time, now())), toString(active) "
    "FROM system.parts WHERE database = " + db + " AND `table` = " + tbl + " "
    "ORDER BY active DESC, modification_time DESC LIMIT 1000",
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        ExplorerPartInfo part;
        part.name = block_string_at(block, 0, row);
        part.partition = block_string_at(block, 1, row);
        part.disk = block_string_at(block, 2, row);
        part.rows = parse_u64(block_string_at(block, 3, row)).value_or(0);
        part.bytes = parse_u64(block_string_at(block, 4, row)).value_or(0);
        part.marks = parse_u64(block_string_at(block, 5, row)).value_or(0);
        part.files = parse_u64(block_string_at(block, 6, row)).value_or(0);
        part.level = parse_u64(block_string_at(block, 7, row)).value_or(0);
        part.age_seconds = parse_u64(block_string_at(block, 8, row)).value_or(0);
        part.active = truthy(block_string_at(block, 9, row));
        out.parts.push_back(std::move(part));
      }
    }, &section_error);
  if (!parts_loaded) {
      if (error) *error = "Parts metadata query failed: " + section_error;
      return false;
    }

  bool partitions_loaded = try_select(system,
    "SELECT toString(partition), toString(sum(rows)), toString(sum(bytes_on_disk)), toString(count()) "
    "FROM system.parts WHERE active AND database = " + db + " AND `table` = " + tbl + " "
    "GROUP BY partition ORDER BY max(modification_time) DESC LIMIT 1000",
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        ExplorerPartitionInfo partition;
        partition.partition = block_string_at(block, 0, row);
        partition.rows = parse_u64(block_string_at(block, 1, row)).value_or(0);
        partition.bytes = parse_u64(block_string_at(block, 2, row)).value_or(0);
        partition.parts = parse_u64(block_string_at(block, 3, row)).value_or(0);
        out.partitions.push_back(std::move(partition));
      }
    }, &section_error);
  if (!partitions_loaded) {
      if (error) *error = "Partitions metadata query failed: " + section_error;
      return false;
    }

  bool indexes_loaded = try_select(system,
    "SELECT toString(name), toString(type), toString(expr), toString(data_compressed_bytes), toString(data_uncompressed_bytes) "
    "FROM system.data_skipping_indices WHERE database = " + db + " AND `table` = " + tbl + " ORDER BY name",
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        ExplorerIndexProjectionInfo item;
        item.name = block_string_at(block, 0, row);
        item.kind = "index:" + block_string_at(block, 1, row);
        item.expression = block_string_at(block, 2, row);
        item.compressed_bytes = parse_u64(block_string_at(block, 3, row));
        item.uncompressed_bytes = parse_u64(block_string_at(block, 4, row));
        out.indexes_and_projections.push_back(std::move(item));
      }
    }, &section_error);
  if (!indexes_loaded) {
      if (error) *error = "Skipping-index metadata query failed: " + section_error;
      return false;
    }

  bool projections_loaded = try_select(system,
    "SELECT toString(name), toString(type), toString(sorting_key) FROM system.projections "
    "WHERE database = " + db + " AND `table` = " + tbl + " ORDER BY name",
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        ExplorerIndexProjectionInfo item;
        item.name = block_string_at(block, 0, row);
        item.kind = "projection:" + block_string_at(block, 1, row);
        item.expression = block_string_at(block, 2, row);
        out.indexes_and_projections.push_back(std::move(item));
      }
    }, &section_error);
  if (!projections_loaded) {
      if (error) *error = "Projection metadata query failed: " + section_error;
      return false;
    }

  // `system.projections` describes the definition; the materialized storage
  // lives in `system.projection_parts`. Enrich each projection with its exact
  // local compressed data size so Browse can compare it to columns and indexes.
  section_error.clear();
  const bool projection_sizes_loaded = try_select(system,
    "SELECT toString(name), toString(sum(data_compressed_bytes)), toString(sum(data_uncompressed_bytes)), "
    "toString(sum(bytes_on_disk)) FROM system.projection_parts "
    "WHERE active AND database = " + db + " AND `table` = " + tbl + " GROUP BY name ORDER BY name",
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        const std::string name = block_string_at(block, 0, row);
        const auto compressed = parse_u64(block_string_at(block, 1, row));
        const auto uncompressed = parse_u64(block_string_at(block, 2, row));
        const auto on_disk = parse_u64(block_string_at(block, 3, row));
        for (auto& item : out.indexes_and_projections) {
          if (item.name == name && item.kind.rfind("projection:", 0) == 0) {
            item.compressed_bytes = compressed;
            item.uncompressed_bytes = uncompressed;
            item.on_disk_bytes = on_disk;
            break;
          }
        }
      }
    }, &section_error);
  if (!projection_sizes_loaded) out.unavailable_sections.push_back("projection_sizes");

  bool mutation_loaded = try_select(system,
    "SELECT toString(mutation_id), toString(command), toString(create_time), toString(is_done), toString(parts_to_do), "
    "toString(latest_failed_part), toString(latest_fail_time), toString(latest_fail_reason) "
    "FROM system.mutations WHERE database = " + db + " AND `table` = " + tbl + " ORDER BY create_time DESC LIMIT 100",
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        ExplorerMutationInfo mutation;
        mutation.mutation_id = block_string_at(block, 0, row);
        mutation.command = block_string_at(block, 1, row);
        mutation.create_time = block_string_at(block, 2, row);
        mutation.done = truthy(block_string_at(block, 3, row));
        mutation.parts_to_do = parse_u64(block_string_at(block, 4, row)).value_or(0);
        mutation.latest_failed_part = block_string_at(block, 5, row);
        mutation.latest_fail_time = block_string_at(block, 6, row);
        mutation.latest_fail_reason = block_string_at(block, 7, row);
        out.mutations.push_back(std::move(mutation));
      }
    }, &section_error);
  if (!mutation_loaded) {
      if (error) *error = "Mutation metadata query failed: " + section_error;
      return false;
    }

  bool merges_loaded = try_select(system,
    "SELECT toString(partition_id), toString(result_part_name), toString(elapsed), toString(progress), toString(num_parts), "
    "toString(rows_read), toString(bytes_read_uncompressed), toString(memory_usage) "
    "FROM system.merges WHERE database = " + db + " AND `table` = " + tbl + " ORDER BY elapsed DESC",
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        ExplorerMergeInfo merge;
        merge.partition = block_string_at(block, 0, row);
        merge.result_part_name = block_string_at(block, 1, row);
        merge.elapsed_seconds = parse_double(block_string_at(block, 2, row)).value_or(0);
        merge.progress = parse_double(block_string_at(block, 3, row)).value_or(0);
        merge.num_parts = parse_u64(block_string_at(block, 4, row)).value_or(0);
        merge.rows_read = parse_u64(block_string_at(block, 5, row)).value_or(0);
        merge.bytes_read = parse_u64(block_string_at(block, 6, row)).value_or(0);
        merge.memory_usage = parse_u64(block_string_at(block, 7, row)).value_or(0);
        out.merges.push_back(std::move(merge));
      }
    }, &section_error);
  if (!merges_loaded) {
      if (error) *error = "Merge metadata query failed: " + section_error;
      return false;
    }

  if (out.summary.engine == "Distributed") {
    const bool distribution_queue_loaded = try_select(system,
      "SELECT toString(data_path), toString(is_blocked), toString(error_count), toString(data_files), "
      "toString(data_compressed_bytes), toString(broken_data_files), "
      "toString(broken_data_compressed_bytes), toString(last_exception), toString(last_exception_time) "
      "FROM system.distribution_queue WHERE database = " + db + " AND `table` = " + tbl +
      " ORDER BY error_count DESC, data_compressed_bytes DESC LIMIT 100",
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          ExplorerDistributionQueueItem item;
          item.data_path = block_string_at(block, 0, row);
          item.blocked = truthy(block_string_at(block, 1, row));
          item.error_count = parse_u64(block_string_at(block, 2, row)).value_or(0);
          item.data_files = parse_u64(block_string_at(block, 3, row)).value_or(0);
          item.data_compressed_bytes = parse_u64(block_string_at(block, 4, row)).value_or(0);
          item.broken_data_files = parse_u64(block_string_at(block, 5, row)).value_or(0);
          item.broken_data_compressed_bytes = parse_u64(block_string_at(block, 6, row)).value_or(0);
          item.last_exception = block_string_at(block, 7, row);
          item.last_exception_time = block_string_at(block, 8, row);
          out.distribution_queue.push_back(std::move(item));
        }
      }, &section_error);
    if (!distribution_queue_loaded) {
      if (error) *error = "Distribution queue query failed: " + section_error;
      return false;
    }

    const auto cluster = first_engine_argument(out.summary.engine_full, "Distributed");
    if (cluster && !cluster->empty()) {
      const std::string cluster_sql = quote_string(*cluster);
      const bool topology_loaded = try_select(system,
        "SELECT toString(cluster), toString(shard_num), toString(replica_num), toString(host_name), toString(host_address), "
        "toString(port), toString(is_local), toString(errors_count), toString(slowdowns_count), "
        "toString(estimated_recovery_time) FROM system.clusters WHERE cluster = " + cluster_sql +
        " ORDER BY shard_num, replica_num",
        [&](const clickhouse::Block& block) {
          for (size_t row = 0; row < block.GetRowCount(); ++row) {
            ExplorerTopologyNode node;
            node.cluster = block_string_at(block, 0, row);
            node.shard_num = parse_u64(block_string_at(block, 1, row)).value_or(0);
            node.replica_num = parse_u64(block_string_at(block, 2, row)).value_or(0);
            node.host_name = block_string_at(block, 3, row);
            node.host_address = block_string_at(block, 4, row);
            node.port = parse_u64(block_string_at(block, 5, row)).value_or(0);
            node.is_local = truthy(block_string_at(block, 6, row));
            node.errors_count = parse_u64(block_string_at(block, 7, row)).value_or(0);
            node.slowdowns_count = parse_u64(block_string_at(block, 8, row)).value_or(0);
            node.estimated_recovery_time = parse_u64(block_string_at(block, 9, row)).value_or(0);
            out.topology.push_back(std::move(node));
          }
        }, &section_error);
      if (!topology_loaded) {
      if (error) *error = "Distributed topology query failed: " + section_error;
      return false;
    }
    } else {
      out.unavailable_sections.push_back("topology");
    }
  }

  if (out.summary.replication.available) {
    const bool queue_loaded = try_select(system,
      "SELECT toString(type), toString(create_time), toString(source_replica), toString(new_part_name), toString(num_tries), "
      "toString(last_attempt_time), toString(last_exception) FROM system.replication_queue WHERE database = " + db +
      " AND `table` = " + tbl + " ORDER BY create_time LIMIT 100",
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          ExplorerReplicationQueueItem item;
          item.type = block_string_at(block, 0, row);
          item.create_time = block_string_at(block, 1, row);
          item.source_replica = block_string_at(block, 2, row);
          item.new_part_name = block_string_at(block, 3, row);
          item.num_tries = parse_u64(block_string_at(block, 4, row)).value_or(0);
          item.last_attempt_time = block_string_at(block, 5, row);
          item.last_exception = block_string_at(block, 6, row);
          out.replication_queue.push_back(std::move(item));
        }
      }, &section_error);
    if (!queue_loaded) {
      if (error) *error = "Replication queue query failed: " + section_error;
      return false;
    }
  }

  // Structured lineage is security-filtered *before* it is exposed. On
  // system.tables, dependencies_* lists objects which depend on the current
  // object. Read both the selected row (downstream) and the reverse relation
  // (upstream) so a view/MV does not misleadingly show an empty Lineage tab.
  std::set<std::tuple<std::string, std::string, std::string>> dependency_seen;
  auto append_dependency = [&](const std::string& dep_db, const std::string& dep_table, const char* relation) {
    // ClickHouse may expose an internal `row`/`_row` pseudo dependency for
    // view-like objects. It is implementation metadata, not a navigable
    // ClickHouse object, so never expose it as Lineage.
    if (is_row_pseudo_object(dep_table)) return;
    if (!allowed.allows_table(dep_db, dep_table)) return;
    auto key = std::make_tuple(dep_db, dep_table, std::string(relation));
    if (!dependency_seen.insert(key).second) return;
    out.dependencies.push_back({dep_db, dep_table, relation});
  };

  // A MATERIALIZED VIEW ... TO db.table has an explicit sink which is not
  // consistently represented by dependencies_* on every supported build.
  // Parse that bounded top-level TO clause from the server-generated DDL so
  // MV detail always exposes both its SELECT inputs and its target when the
  // runner can read them.
  if (auto target = parse_materialized_view_target(out.create_table_query, database)) {
    append_dependency(target->database, target->table, "downstream");
  }

  // Buffer(database, table, ...) owns a routing edge to its flush destination.
  // Surface that relationship through the same downstream model used by Views,
  // MVs and ordinary tables instead of rendering a one-off "Flush target" card
  // in the browser.
  if (summary.engine == "Buffer") {
    const auto args = parse_engine_arguments_local(summary.engine_full, "Buffer");
    if (args.size() >= 2 && !args[0].empty() && !args[1].empty()) {
      append_dependency(args[0], args[1], "downstream");
    }
  }

  // Reverse Buffer(database, table, ...) routing as well. ClickHouse does not
  // consistently materialize Buffer engine destinations in dependencies_*, so
  // without this pass the Buffer showed its target as downstream while the
  // target could not show the same Buffer as upstream. Keep the relationship
  // symmetric and ACL-filtered for every Buffer table visible to the runner.
  section_error.clear();
  const bool buffer_upstream_loaded = try_select(system,
    "SELECT toString(database), toString(name), toString(engine_full) "
    "FROM system.tables WHERE engine = 'Buffer'",
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        const std::string buffer_db = block_string_at(block, 0, row);
        const std::string buffer_table = block_string_at(block, 1, row);
        if (!allowed.allows_table(buffer_db, buffer_table)) continue;
        const auto args = parse_engine_arguments_local(block_string_at(block, 2, row), "Buffer");
        if (args.size() < 2 || args[0].empty() || args[1].empty()) continue;
        if (args[0] == database && args[1] == table) {
          append_dependency(buffer_db, buffer_table, "upstream");
        }
      }
    }, &section_error);
  if (!buffer_upstream_loaded) {
    if (error) *error = "Buffer reverse-lineage query failed: " + section_error;
    return false;
  }

  const bool downstream_loaded = try_select(system,
    "SELECT toString(tupleElement(dep, 1)), toString(tupleElement(dep, 2)) "
    "FROM (SELECT arrayJoin(arrayZip(dependencies_database, dependencies_table)) AS dep "
    "FROM system.tables WHERE database = " + db + " AND name = " + tbl + ")",
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        append_dependency(block_string_at(block, 0, row), block_string_at(block, 1, row), "downstream");
      }
    }, &section_error);
  if (!downstream_loaded) {
    if (error) *error = "Downstream lineage query failed: " + section_error;
    return false;
  }

  const bool upstream_loaded = try_select(system,
    "SELECT toString(database), toString(name) "
    "FROM (SELECT database, name, arrayJoin(arrayZip(dependencies_database, dependencies_table)) AS dep FROM system.tables) "
    "WHERE toString(tupleElement(dep, 1)) = " + db + " AND toString(tupleElement(dep, 2)) = " + tbl,
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        append_dependency(block_string_at(block, 0, row), block_string_at(block, 1, row), "upstream");
      }
    }, &section_error);
  if (!upstream_loaded) {
    if (error) *error = "Upstream lineage query failed: " + section_error;
    return false;
  }

  // dependencies_* is not complete for ordinary View objects on all supported
  // ClickHouse builds. Augment it from system.tables.as_select using a bounded
  // FROM/JOIN identifier parser (no string/comment guessing). The same ACL
  // filter is applied before any object name is returned.
  section_error.clear();
  const bool select_dependencies_loaded = try_select(system,
    "SELECT toString(database), toString(name), toString(as_select) FROM system.tables WHERE notEmpty(as_select)",
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        const std::string view_db = block_string_at(block, 0, row);
        const std::string view_table = block_string_at(block, 1, row);
        if (!allowed.allows_table(view_db, view_table)) continue;
        const auto sources = parse_relation_sources(block_string_at(block, 2, row), view_db);
        for (const auto& source : sources) {
          if (view_db == database && view_table == table) {
            append_dependency(source.database, source.table, "upstream");
          }
          if (source.database == database && source.table == table) {
            append_dependency(view_db, view_table, "downstream");
          }
        }
      }
    }, &section_error);
  if (!select_dependencies_loaded) {
    if (error) *error = "View lineage query failed: " + section_error;
    return false;
  }

  // Scope totals must be larger than the selected table. The per-table ACL
  // object set intentionally contains only this table, so using it here makes
  // Table / Database and Table / ClickHouse incorrectly report 100%. Aggregate
  // the runner-visible catalog instead; only database-level totals are retained.
  section_error.clear();
  try {
    const auto visible_databases = discover_visible_databases(runner);
    std::vector<ExplorerDatabaseSummary> summaries;
    if (load_explorer_database_summaries(runner, visible_databases, summaries, &section_error)) {
      uint64_t clickhouse_bytes = 0;
      bool database_seen = false;
      for (const auto& summary_row : summaries) {
        clickhouse_bytes += summary_row.bytes;
        if (summary_row.name == database) {
          out.database_footprint_bytes = summary_row.bytes;
          database_seen = true;
        }
      }
      if (!summaries.empty()) out.clickhouse_footprint_bytes = clickhouse_bytes;
      if (!database_seen) out.database_footprint_bytes.reset();
    } else {
      out.unavailable_sections.push_back("footprint_scope");
    }
  } catch (const std::exception&) {
    out.unavailable_sections.push_back("footprint_scope");
  }

  return true;
}

bool load_explorer_functions(
    clickhouse::Client& runner,
    ExplorerFunctionsCatalog& out,
    std::string* error) {
  out = ExplorerFunctionsCatalog{};
  std::unordered_map<std::string, size_t> index_by_key;

  auto key_for = [](std::string_view kind, std::string_view name) {
    std::string key(kind);
    key.push_back('\0');
    key.append(name.data(), name.size());
    return key;
  };

  std::string documentation_error;
  const bool documentation_loaded = try_select(runner,
      "SELECT toString(name), toString(type), toString(description), toString(source) "
      "FROM system.documentation "
      "WHERE type IN ('Function', 'Aggregate Function', 'Table Function') "
      "ORDER BY type, name LIMIT 10000",
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          ExplorerFunctionInfo item;
          item.name = block_string_at(block, 0, row);
          item.kind = block_string_at(block, 1, row);
          item.category = item.kind;
          item.description = block_string_at(block, 2, row);
          item.source = block_string_at(block, 3, row);
          item.origin = "System";
          if (item.name.empty()) continue;
          const std::string key = key_for(item.kind, item.name);
          if (index_by_key.emplace(key, out.functions.size()).second) {
            out.functions.push_back(std::move(item));
          }
        }
      }, &documentation_error);
  if (!documentation_loaded) {
    if (error) {
      *error = "Function documentation query failed: " +
          (documentation_error.empty() ? std::string("unknown ClickHouse error") : documentation_error);
    }
    return false;
  }
  out.documentation_available = true;

  // The 26.7 system.functions schema exposes its documentation fields as
  // Strings (not arrays). Querying every structured field lets the UI present
  // syntax/arguments/return/examples independently while system.documentation
  // remains the source of the complete version-matched Markdown body.
  // This query runs with runner_uri so UDF discovery never becomes a metadata
  // privilege escalation path.
  std::string functions_error;
  const bool functions_loaded = try_select(runner,
      "SELECT toString(name), toString(is_aggregate), toString(origin), toString(create_query), "
      "toString(description), toString(syntax), toString(arguments), toString(parameters), "
      "toString(returned_value), toString(examples), toString(introduced_in), toString(categories) "
      "FROM system.functions ORDER BY name LIMIT 10000",
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          const std::string name = block_string_at(block, 0, row);
          if (name.empty()) continue;
          const bool aggregate = truthy(block_string_at(block, 1, row));
          const std::string kind = aggregate ? "Aggregate Function" : "Function";
          const std::string key = key_for(kind, name);

          ExplorerFunctionInfo* item = nullptr;
          if (auto it = index_by_key.find(key); it != index_by_key.end()) {
            item = &out.functions[it->second];
          } else {
            ExplorerFunctionInfo created;
            created.name = name;
            created.kind = kind;
            index_by_key.emplace(key, out.functions.size());
            out.functions.push_back(std::move(created));
            item = &out.functions.back();
          }

          item->origin = block_string_at(block, 2, row);
          item->user_defined = item->origin != "System" && !item->origin.empty();
          const std::string create_query = block_string_at(block, 3, row);
          const std::string short_description = block_string_at(block, 4, row);
          item->syntax = block_string_at(block, 5, row);
          item->arguments = block_string_at(block, 6, row);
          item->parameters = block_string_at(block, 7, row);
          item->returned_value = block_string_at(block, 8, row);
          item->examples = block_string_at(block, 9, row);
          item->introduced_in = block_string_at(block, 10, row);
          item->category = block_string_at(block, 11, row);
          if (item->category.empty()) item->category = item->kind;

          // Built-ins keep the richer assembled Markdown from
          // system.documentation. UDFs generally have no embedded docs, so use
          // the structured description/create query when that is all the
          // runner can expose.
          if (item->description.empty()) item->description = short_description;
          if (item->syntax.empty() && item->user_defined) item->syntax = create_query;
        }
      }, &functions_error);

  if (!functions_loaded) {
    if (error) {
      *error = "Function metadata query failed: " +
          (functions_error.empty() ? std::string("unknown ClickHouse error") : functions_error);
    }
    return false;
  }

  // Resolve documented aliases before the catalog is sent to the browser.
  // ClickHouse commonly documents aliases as `Alias of `target`.`. Keep the
  // chain bounded and cycle-safe so malformed/custom documentation can never
  // create unbounded recursion in the UI.
  auto lower = [](std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
      return static_cast<char>(std::tolower(ch));
    });
    return value;
  };
  auto alias_target = [](const std::string& description) -> std::string {
    const std::string marker = "Alias of `";
    const size_t begin = description.find(marker);
    if (begin == std::string::npos) return {};
    const size_t value_begin = begin + marker.size();
    const size_t value_end = description.find('`', value_begin);
    if (value_end == std::string::npos || value_end <= value_begin) return {};
    return description.substr(value_begin, value_end - value_begin);
  };
  std::unordered_map<std::string, size_t> function_by_name;
  for (size_t i = 0; i < out.functions.size(); ++i) {
    const std::string key = lower(out.functions[i].name);
    // Prefer scalar/aggregate functions over table functions on a rare name
    // collision because aliases in function documentation target callable names.
    if (!function_by_name.count(key) || out.functions[i].kind != "Table Function") {
      function_by_name[key] = i;
    }
  }
  constexpr size_t kMaxAliasDepth = 8;
  for (auto& item : out.functions) {
    std::unordered_set<std::string> visited;
    visited.insert(lower(item.name));
    std::string target = alias_target(item.description);
    for (size_t depth = 0; depth < kMaxAliasDepth && !target.empty(); ++depth) {
      const std::string key = lower(target);
      if (!visited.insert(key).second) break;
      const auto found = function_by_name.find(key);
      if (found == function_by_name.end()) break;
      const auto& aliased = out.functions[found->second];
      ExplorerFunctionAliasDocument resolved;
      resolved.name = aliased.name;
      resolved.description = aliased.description;
      resolved.syntax = aliased.syntax;
      resolved.arguments = aliased.arguments;
      resolved.parameters = aliased.parameters;
      resolved.returned_value = aliased.returned_value;
      resolved.examples = aliased.examples;
      resolved.introduced_in = aliased.introduced_in;
      item.alias_documents.push_back(std::move(resolved));
      target = alias_target(aliased.description);
    }
  }

  std::sort(out.functions.begin(), out.functions.end(), [](const auto& a, const auto& b) {
    if (a.kind != b.kind) return a.kind < b.kind;
    return a.name < b.name;
  });
  if (error) error->clear();
  return true;
}

bool load_explorer_preview(
    clickhouse::Client& runner,
    const AllowedObjectSet& allowed,
    const std::string& database,
    const std::string& table,
    size_t limit,
    ExplorerPreview& out,
    std::string* error) {
  if (!allowed.allows_table(database, table)) {
    if (error) *error = "object not found";
    return false;
  }
  limit = std::max<size_t>(1, std::min<size_t>(limit, 500));
  out = ExplorerPreview{};
  out.limit = limit;

  auto columns = allowed_columns_for_table(allowed, database, table, runner, &out.columns, error);
  if (columns.empty()) {
    if (error && error->empty()) *error = "no readable columns";
    return false;
  }

  // Preserve the native ClickHouse types and pass every cell through the same
  // JSON encoder used by Query results. This is critical for LowCardinality,
  // Nullable, Bool, Array, Tuple, Map and other nested types. Explorer must not
  // have a second string-only serialization path.
  std::string sql = "SELECT ";
  for (size_t i = 0; i < columns.size(); ++i) {
    if (i) sql += ", ";
    const std::string& declared_type = out.columns[i].type;
    out.columns[i].finalized_for_preview = declared_type.rfind("AggregateFunction(", 0) == 0;
    // clickhouse-cpp cannot deserialize native AggregateFunction state columns.
    // Finalize only the rows selected by the bounded preview and stringify the
    // result. This keeps Preview cheap (LIMIT <= 500), avoids a table-wide
    // aggregate/count query, and preserves the declared AggregateFunction type
    // in the metadata returned to the UI.
    if (declared_type.rfind("AggregateFunction(", 0) == 0) {
      sql += "toString(finalizeAggregation(" + quote_ident(columns[i]) + ")) AS " + quote_ident(columns[i]);
    } else {
      sql += quote_ident(columns[i]);
    }
  }
  sql += " FROM " + qualified_ident(database, table) + " LIMIT " + std::to_string(limit);

  try {
    runner.Select(sql, [&](const clickhouse::Block& block) {
      if (block.GetRowCount() == 0) return;
      if (block.GetColumnCount() != columns.size()) {
        throw std::runtime_error(
            "Explorer preview returned " + std::to_string(block.GetColumnCount()) +
            " columns; expected " + std::to_string(columns.size()) + ".");
      }
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        std::vector<std::string> values;
        values.reserve(columns.size());
        for (size_t i = 0; i < columns.size(); ++i) {
          rapidjson::StringBuffer cell_buffer;
          rapidjson::Writer<rapidjson::StringBuffer> cell_writer(cell_buffer);
          const std::string& declared_type = out.columns[i].type;
          if (declared_type.rfind("AggregateFunction(", 0) == 0) {
            // The SELECT projection above finalized/stringified the state, so
            // decode the returned String column by its runtime type while the
            // public preview metadata keeps the original AggregateFunction type.
            write_cell_json(cell_writer, block[i], row);
          } else if (!declared_type.empty()) {
            write_cell_json_declared(cell_writer, block[i], row, declared_type);
          } else {
            write_cell_json(cell_writer, block[i], row);
          }
          values.emplace_back(cell_buffer.GetString(), cell_buffer.GetSize());
        }
        out.rows.push_back(std::move(values));
      }
    });
  } catch (const std::exception& e) {
    if (error) *error = e.what();
    return false;
  }
  return true;
}

} // namespace chdash
