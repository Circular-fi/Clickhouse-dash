#include "explorer_graph.hpp"
#include "ch_block_value.hpp"

#include <algorithm>
#include <chrono>
#include <cctype>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <map>
#include <optional>
#include <set>
#include <sstream>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace chdash {
namespace {

uint64_t now_ms() {
  using namespace std::chrono;
  return static_cast<uint64_t>(duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count());
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

bool truthy(const std::string& value) {
  return value == "1" || value == "true" || value == "TRUE";
}

bool is_row_pseudo_object(std::string_view table) {
  std::string normalized;
  normalized.reserve(table.size());
  for (const char ch : table) normalized.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(ch))));
  return normalized == "row" || normalized == "_row";
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

std::vector<std::string> split_unit_separator(std::string_view value) {
  std::vector<std::string> out;
  size_t start = 0;
  while (start <= value.size()) {
    const size_t pos = value.find(static_cast<char>(31), start);
    const size_t end = pos == std::string_view::npos ? value.size() : pos;
    if (end > start) out.emplace_back(value.substr(start, end - start));
    if (pos == std::string_view::npos) break;
    start = pos + 1;
  }
  return out;
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

std::string table_node_id(std::string_view database, std::string_view table) {
  return "table:" + std::string(database) + "." + std::string(table);
}

std::string table_key(std::string_view database, std::string_view table) {
  std::string out(database);
  out.push_back('\0');
  out.append(table.data(), table.size());
  return out;
}

std::string lower_ascii(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return value;
}

bool contains_ci(std::string_view haystack, std::string_view needle) {
  if (needle.empty() || haystack.size() < needle.size()) return false;
  for (size_t i = 0; i + needle.size() <= haystack.size(); ++i) {
    bool match = true;
    for (size_t j = 0; j < needle.size(); ++j) {
      if (std::tolower(static_cast<unsigned char>(haystack[i + j])) !=
          std::tolower(static_cast<unsigned char>(needle[j]))) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

std::vector<std::string> parse_engine_arguments(std::string_view engine_full, std::string_view engine_name) {
  size_t pos = 0;
  while (pos < engine_full.size() && std::isspace(static_cast<unsigned char>(engine_full[pos]))) ++pos;
  if (engine_full.substr(pos, engine_name.size()) != engine_name) return {};
  pos += engine_name.size();
  while (pos < engine_full.size() && std::isspace(static_cast<unsigned char>(engine_full[pos]))) ++pos;
  if (pos >= engine_full.size() || engine_full[pos] != '(') return {};
  ++pos;

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
      auto trim = [](std::string value) {
        const auto first = value.find_first_not_of(" \t\r\n");
        if (first == std::string::npos) return std::string{};
        const auto last = value.find_last_not_of(" \t\r\n");
        return value.substr(first, last - first + 1);
      };
      args.push_back(trim(std::move(current)));
      break;
    }
    if (ch == ',' && depth == 0) {
      const auto first = current.find_first_not_of(" \t\r\n");
      const auto last = current.find_last_not_of(" \t\r\n");
      args.push_back(first == std::string::npos ? std::string{} : current.substr(first, last - first + 1));
      current.clear();
      continue;
    }
    current.push_back(ch);
  }
  return args;
}

struct QualifiedName {
  std::string database;
  std::string table;
};

std::optional<std::string> parse_identifier_token(std::string_view text, size_t& pos) {
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

std::optional<QualifiedName> parse_qualified_name(std::string_view text, size_t& pos, const std::string& default_database) {
  auto first = parse_identifier_token(text, pos);
  if (!first || first->empty()) return std::nullopt;
  while (pos < text.size() && std::isspace(static_cast<unsigned char>(text[pos]))) ++pos;
  if (pos < text.size() && text[pos] == '.') {
    ++pos;
    auto second = parse_identifier_token(text, pos);
    if (!second || second->empty()) return std::nullopt;
    return QualifiedName{*first, *second};
  }
  return QualifiedName{default_database, *first};
}

bool token_boundary(std::string_view text, size_t pos, size_t len) {
  const auto is_word = [](char ch) {
    return std::isalnum(static_cast<unsigned char>(ch)) || ch == '_';
  };
  if (pos > 0 && is_word(text[pos - 1])) return false;
  if (pos + len < text.size() && is_word(text[pos + len])) return false;
  return true;
}

std::optional<size_t> find_keyword_ci(std::string_view text, std::string_view keyword, size_t start = 0) {
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
    if (depth != 0 || !token_boundary(text, i, keyword.size())) continue;
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

std::optional<QualifiedName> qualified_after_keyword(
    std::string_view text,
    std::string_view keyword,
    const std::string& default_database) {
  const auto at = find_keyword_ci(text, keyword);
  if (!at) return std::nullopt;
  size_t pos = *at + keyword.size();
  return parse_qualified_name(text, pos, default_database);
}

std::optional<std::string> parse_ttl_destination(std::string_view text, size_t& pos) {
  while (pos < text.size() && std::isspace(static_cast<unsigned char>(text[pos]))) ++pos;
  if (pos >= text.size()) return std::nullopt;
  if (text[pos] != '\'') return parse_identifier_token(text, pos);
  ++pos;
  std::string value;
  while (pos < text.size()) {
    const char ch = text[pos++];
    if (ch == '\'') {
      if (pos < text.size() && text[pos] == '\'') { value.push_back('\''); ++pos; continue; }
      return value;
    }
    if (ch == '\\' && pos < text.size()) { value.push_back(text[pos++]); continue; }
    value.push_back(ch);
  }
  return std::nullopt;
}

std::string trim_copy(std::string_view value) {
  const auto first = value.find_first_not_of(" \t\r\n,");
  if (first == std::string_view::npos) return {};
  const auto last = value.find_last_not_of(" \t\r\n");
  return std::string(value.substr(first, last - first + 1));
}

std::string compact_spaces(std::string_view value) {
  std::string out;
  out.reserve(value.size());
  bool pending_space = false;
  char quote = 0;
  for (size_t i = 0; i < value.size(); ++i) {
    const char ch = value[i];
    if (quote) {
      if (pending_space && !out.empty()) { out.push_back(' '); pending_space = false; }
      out.push_back(ch);
      if (ch == '\\' && quote == '\'' && i + 1 < value.size()) out.push_back(value[++i]);
      else if (ch == quote) quote = 0;
      continue;
    }
    if (ch == '\'' || ch == '`' || ch == '"') {
      if (pending_space && !out.empty()) { out.push_back(' '); pending_space = false; }
      quote = ch;
      out.push_back(ch);
      continue;
    }
    if (std::isspace(static_cast<unsigned char>(ch))) {
      pending_space = !out.empty();
      continue;
    }
    if (pending_space && !out.empty()) out.push_back(' ');
    pending_space = false;
    out.push_back(ch);
  }
  return trim_copy(out);
}

std::vector<std::string> split_top_level_commas(std::string_view text) {
  std::vector<std::string> parts;
  size_t start = 0;
  int depth = 0;
  char quote = 0;
  for (size_t i = 0; i < text.size(); ++i) {
    const char ch = text[i];
    if (quote) {
      if (ch == '\\' && quote == '\'' && i + 1 < text.size()) { ++i; continue; }
      if (ch == quote) {
        if (i + 1 < text.size() && text[i + 1] == quote) { ++i; continue; }
        quote = 0;
      }
      continue;
    }
    if (ch == '\'' || ch == '`' || ch == '"') { quote = ch; continue; }
    if (ch == '(' || ch == '[' || ch == '{') { ++depth; continue; }
    if (ch == ')' || ch == ']' || ch == '}') { if (depth > 0) --depth; continue; }
    if (ch == ',' && depth == 0) {
      const auto part = trim_copy(text.substr(start, i - start));
      if (!part.empty()) parts.push_back(part);
      start = i + 1;
    }
  }
  const auto tail = trim_copy(text.substr(start));
  if (!tail.empty()) parts.push_back(tail);
  return parts;
}

std::optional<size_t> find_last_top_level_plus(std::string_view text, size_t before) {
  char quote = 0;
  int depth = 0;
  std::optional<size_t> result;
  const size_t limit = std::min(before, text.size());
  for (size_t i = 0; i < limit; ++i) {
    const char ch = text[i];
    if (quote) {
      if (ch == '\\' && quote == '\'' && i + 1 < limit) { ++i; continue; }
      if (ch == quote) quote = 0;
      continue;
    }
    if (ch == '\'' || ch == '`' || ch == '"') { quote = ch; continue; }
    if (ch == '(' || ch == '[' || ch == '{') { ++depth; continue; }
    if (ch == ')' || ch == ']' || ch == '}') { if (depth > 0) --depth; continue; }
    if (ch == '+' && depth == 0) result = i;
  }
  return result;
}

std::string ttl_unit_short(std::string unit) {
  std::transform(unit.begin(), unit.end(), unit.begin(), [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
  if (!unit.empty() && unit.back() == 's') unit.pop_back();
  if (unit == "second") return "s";
  if (unit == "minute") return "m";
  if (unit == "hour") return "h";
  if (unit == "day") return "d";
  if (unit == "week") return "w";
  if (unit == "month") return "mo";
  if (unit == "quarter") return "q";
  if (unit == "year") return "y";
  return unit;
}

void derive_ttl_timing(std::string_view expression, std::string& base_expression, std::string& offset_label) {
  static const std::pair<std::string_view, std::string_view> functions[] = {
      {"toIntervalSecond", "s"}, {"toIntervalMinute", "m"}, {"toIntervalHour", "h"},
      {"toIntervalDay", "d"}, {"toIntervalWeek", "w"}, {"toIntervalMonth", "mo"},
      {"toIntervalQuarter", "q"}, {"toIntervalYear", "y"},
  };

  for (const auto& [function_name, suffix] : functions) {
    const auto at = find_keyword_ci(expression, function_name);
    if (!at) continue;
    size_t pos = *at + function_name.size();
    while (pos < expression.size() && std::isspace(static_cast<unsigned char>(expression[pos]))) ++pos;
    if (pos >= expression.size() || expression[pos] != '(') continue;
    ++pos;
    while (pos < expression.size() && std::isspace(static_cast<unsigned char>(expression[pos]))) ++pos;
    const size_t value_start = pos;
    while (pos < expression.size()) {
      const char ch = expression[pos];
      if (!(std::isdigit(static_cast<unsigned char>(ch)) || ch == '.' || ch == '-' || ch == '+')) break;
      ++pos;
    }
    const std::string value = trim_copy(expression.substr(value_start, pos - value_start));
    if (value.empty()) continue;
    offset_label = "+" + value + std::string(suffix);
    if (const auto plus = find_last_top_level_plus(expression, *at)) {
      base_expression = compact_spaces(expression.substr(0, *plus));
    }
    return;
  }

  const auto interval_at = find_keyword_ci(expression, "INTERVAL");
  if (interval_at) {
    size_t pos = *interval_at + 8;
    while (pos < expression.size() && std::isspace(static_cast<unsigned char>(expression[pos]))) ++pos;
    const size_t value_start = pos;
    while (pos < expression.size()) {
      const char ch = expression[pos];
      if (!(std::isdigit(static_cast<unsigned char>(ch)) || ch == '.' || ch == '-' || ch == '+')) break;
      ++pos;
    }
    const std::string value = trim_copy(expression.substr(value_start, pos - value_start));
    while (pos < expression.size() && std::isspace(static_cast<unsigned char>(expression[pos]))) ++pos;
    const size_t unit_start = pos;
    while (pos < expression.size() && std::isalpha(static_cast<unsigned char>(expression[pos]))) ++pos;
    const std::string unit = std::string(expression.substr(unit_start, pos - unit_start));
    if (!value.empty() && !unit.empty()) {
      offset_label = "+" + value + ttl_unit_short(unit);
      if (const auto plus = find_last_top_level_plus(expression, *interval_at)) {
        base_expression = compact_spaces(expression.substr(0, *plus));
      }
    }
  }
}

std::vector<ExplorerGraphTtlRule> parse_table_ttl_rules(std::string_view ddl) {
  std::vector<ExplorerGraphTtlRule> out;
  const auto ttl_at = find_keyword_ci(ddl, "TTL");
  if (!ttl_at) return out;

  const size_t start = *ttl_at + 3;
  size_t end = ddl.size();
  for (std::string_view terminal : {std::string_view("SETTINGS"), std::string_view("COMMENT")}) {
    if (const auto at = find_keyword_ci(ddl, terminal, start)) end = std::min(end, *at);
  }
  if (end <= start) return out;

  for (const auto& raw_rule : split_top_level_commas(ddl.substr(start, end - start))) {
    ExplorerGraphTtlRule rule;
    rule.action = "delete"; // A bare ClickHouse TTL expression means DELETE.

    struct ActionMatch { size_t at; std::string_view keyword; std::string action; std::string target_kind; };
    std::vector<ActionMatch> actions;
    const auto add_action = [&](std::string_view keyword, std::string action, std::string target_kind = {}) {
      if (const auto at = find_keyword_ci(raw_rule, keyword)) actions.push_back({*at, keyword, std::move(action), std::move(target_kind)});
    };
    add_action("RECOMPRESS", "recompress", "codec");
    add_action("TO VOLUME", "move", "volume");
    add_action("TO DISK", "move", "disk");
    add_action("DELETE", "delete");
    add_action("GROUP BY", "group_by", "expression");
    std::sort(actions.begin(), actions.end(), [](const auto& a, const auto& b) { return a.at < b.at; });

    const size_t action_at = actions.empty() ? raw_rule.size() : actions.front().at;
    rule.expression = compact_spaces(raw_rule.substr(0, action_at));
    if (rule.expression.empty()) continue;
    rule.base_expression = rule.expression;
    derive_ttl_timing(rule.expression, rule.base_expression, rule.offset_label);

    if (!actions.empty()) {
      const auto& action = actions.front();
      rule.action = action.action;
      rule.target_kind = action.target_kind;
      size_t pos = action.at + action.keyword.size();
      if (rule.action == "move") {
        auto destination = parse_ttl_destination(raw_rule, pos);
        if (destination) rule.target = *destination;
      } else if (rule.action == "recompress") {
        std::string detail = compact_spaces(raw_rule.substr(pos));
        const auto open = detail.find('(');
        if (open != std::string::npos && detail.back() == ')' && contains_ci(detail.substr(0, open), "CODEC")) {
          detail = trim_copy(std::string_view(detail).substr(open + 1, detail.size() - open - 2));
        }
        rule.target = std::move(detail);
      } else {
        rule.target = compact_spaces(raw_rule.substr(pos));
      }
    }

    if (rule.expression.size() > 180) rule.expression = rule.expression.substr(0, 177) + "…";
    if (rule.base_expression.size() > 96) rule.base_expression = rule.base_expression.substr(0, 93) + "…";
    if (rule.target.size() > 128) rule.target = rule.target.substr(0, 125) + "…";
    out.push_back(std::move(rule));
  }
  return out;
}

std::vector<QualifiedName> parse_select_sources(std::string_view select_sql, const std::string& default_database) {
  std::vector<QualifiedName> result;
  std::set<std::pair<std::string, std::string>> seen;
  for (std::string_view keyword : {std::string_view("FROM"), std::string_view("JOIN")}) {
    size_t start = 0;
    while (true) {
      const auto at = find_keyword_ci(select_sql, keyword, start);
      if (!at) break;
      size_t pos = *at + keyword.size();
      while (pos < select_sql.size() && std::isspace(static_cast<unsigned char>(select_sql[pos]))) ++pos;
      // A subquery after FROM/JOIN is intentionally ignored. The graph is
      // best-effort and never invents object names from SQL text.
      if (pos < select_sql.size() && select_sql[pos] != '(') {
        auto q = parse_qualified_name(select_sql, pos, default_database);
        if (q && seen.insert({q->database, q->table}).second) result.push_back(std::move(*q));
      }
      start = *at + keyword.size();
    }
  }
  return result;
}

std::string classify_node(const std::string& engine, const std::string& ddl) {
  if (engine == "MaterializedView") {
    return contains_ci(ddl, "REFRESH EVERY") || contains_ci(ddl, "REFRESH AFTER")
        ? "refreshable_materialized_view"
        : "materialized_view";
  }
  if (engine == "View" || engine == "ParameterizedView") return "view";
  if (engine == "Distributed") return "distributed";
  if (engine == "Buffer") return "buffer";
  if (engine == "Kafka" || engine == "RabbitMQ" || engine == "NATS" || engine == "S3Queue") return "stream_engine";
  if (contains_ci(engine, "Dictionary")) return "dictionary";
  if (engine == "Remote" || engine == "RemoteSecure" || engine == "URL" || engine == "MySQL" || engine == "PostgreSQL") return "external";
  if (contains_ci(engine, "MergeTree")) return "mergetree";
  if (engine == "TinyLog") return "tinylog";
  if (engine == "StripeLog") return "stripelog";
  if (engine == "Log") return "log";
  if (engine == "Memory") return "memory";
  return "table";
}

struct RawTable {
  std::string database;
  std::string name;
  std::string engine;
  std::string engine_full;
  std::string ddl;
  std::string as_select;
  std::vector<std::string> data_paths;
};

void add_edge_unique(ExplorerGraph& graph, std::unordered_set<std::string>& seen, ExplorerGraphEdge edge) {
  const std::string key = edge.from + "\0" + edge.to + "\0" + edge.kind;
  if (!seen.insert(key).second) return;
  edge.id = "edge:" + std::to_string(graph.edges.size() + 1);
  graph.edges.push_back(std::move(edge));
}

ExplorerGraphNodeActivity& activity_for(
    std::unordered_map<std::string, size_t>& index,
    ExplorerGraphActivity& out,
    const std::string& database,
    const std::string& table) {
  const std::string id = table_node_id(database, table);
  const auto it = index.find(id);
  if (it != index.end()) return out.nodes[it->second];
  ExplorerGraphNodeActivity value;
  value.node_id = id;
  const size_t next = out.nodes.size();
  out.nodes.push_back(std::move(value));
  index.emplace(id, next);
  return out.nodes.back();
}

} // namespace

bool load_explorer_graph(
    clickhouse::Client& system,
    const AllowedObjectSet& allowed,
    const ExplorerCatalog& catalog,
    ExplorerGraph& out,
    std::string* error) {
  out = ExplorerGraph{};
  out.generated_at_ms = now_ms();
  out.metric_scope = catalog.metric_scope;

  std::unordered_map<std::string, const ExplorerTableSummary*> summary_by_key;
  for (const auto& summary : catalog.tables) {
    summary_by_key.emplace(table_key(summary.database, summary.name), &summary);
  }

  // Storage policies may reference cold disks which currently hold no parts for
  // the selected database. Load system.disks directly so those SSD/HDD/S3
  // destinations still have host/path/type/capacity metadata in topology.
  std::unordered_map<std::string, ExplorerDatabaseDisk> disk_info_by_name;
  std::string disks_error;
  const bool disks_loaded = try_select(system,
    "SELECT toString(hostName()), toString(name), toString(path), toString(type), "
    "toString(free_space), toString(total_space) FROM system.disks ORDER BY name",
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        ExplorerDatabaseDisk disk;
        disk.host_name = block_string_at(block, 0, row);
        disk.name = block_string_at(block, 1, row);
        disk.path = block_string_at(block, 2, row);
        disk.type = block_string_at(block, 3, row);
        disk.free_space = parse_u64(block_string_at(block, 4, row));
        disk.total_space = parse_u64(block_string_at(block, 5, row));
        disk_info_by_name[disk.name] = std::move(disk);
      }
    }, &disks_error);
  if (!disks_loaded) {
    if (error) *error = "Disk metadata query failed: " + disks_error;
    return false;
  }

  struct StorageVolumeRow {
    std::string policy;
    std::string volume;
    uint64_t priority = 0;
    std::vector<std::string> disks;
    std::string type;
    uint64_t max_part_size = 0;
    double move_factor = 0.0;
  };
  std::unordered_map<std::string, std::vector<StorageVolumeRow>> storage_policy_rows;
  bool needs_storage_policies = false;
  for (const auto& summary : catalog.tables) {
    if (!summary.storage_policy.empty()) { needs_storage_policies = true; break; }
  }
  if (needs_storage_policies) {
    std::string policy_error;
    const bool policies_loaded = try_select(system,
      "SELECT toString(policy_name), toString(volume_name), toString(volume_priority), "
      "arrayStringConcat(disks, char(31)), toString(volume_type), toString(max_data_part_size), toString(move_factor) "
      "FROM system.storage_policies ORDER BY policy_name, volume_priority, volume_name",
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          StorageVolumeRow value;
          value.policy = block_string_at(block, 0, row);
          value.volume = block_string_at(block, 1, row);
          value.priority = parse_u64(block_string_at(block, 2, row)).value_or(0);
          value.disks = split_unit_separator(block_string_at(block, 3, row));
          value.type = block_string_at(block, 4, row);
          value.max_part_size = parse_u64(block_string_at(block, 5, row)).value_or(0);
          value.move_factor = parse_double(block_string_at(block, 6, row)).value_or(0.0);
          storage_policy_rows[value.policy].push_back(std::move(value));
        }
      }, &policy_error);
    if (!policies_loaded) {
      if (error) *error = "Storage policy metadata query failed: " + policy_error;
      return false;
    }
  }

  std::vector<RawTable> raw;
  std::unordered_map<std::string, size_t> raw_index;
  std::string last_error;
  const bool tables_loaded = try_select(system,
      "SELECT toString(database), toString(name), toString(engine), toString(engine_full), toString(create_table_query), toString(as_select), arrayStringConcat(data_paths, char(31)) FROM system.tables",
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          RawTable item;
          item.database = block_string_at(block, 0, row);
          item.name = block_string_at(block, 1, row);
          if (!allowed.allows_table(item.database, item.name)) continue;
          item.engine = block_string_at(block, 2, row);
          item.engine_full = block_string_at(block, 3, row);
          item.ddl = block_string_at(block, 4, row);
          item.as_select = block_string_at(block, 5, row);
          item.data_paths = split_unit_separator(block_string_at(block, 6, row));
          raw_index.emplace(table_key(item.database, item.name), raw.size());
          raw.push_back(std::move(item));
        }
      }, &last_error);
  if (!tables_loaded) {
    if (error) *error = last_error.empty() ? "Unable to load system.tables for graph." : last_error;
    return false;
  }

  // Buffer runtime rows/bytes are already available through the catalog's
  // system.tables baseline (`total_rows` / `total_bytes`). ClickHouse 26.7 does
  // not expose a `system.buffers` table, so do not make graph rendering depend
  // on that version-specific system table.


  std::unordered_map<std::string, size_t> logical_node_index;
  std::unordered_map<std::string, std::string> kind_by_key;
  for (const auto& table : raw) {
    ExplorerGraphNode node;
    node.id = table_node_id(table.database, table.name);
    node.kind = classify_node(table.engine, table.ddl);
    node.database = table.database;
    node.name = table.name;
    node.label = table.name;
    node.engine = table.engine;
    node.ttl_rules = parse_table_ttl_rules(table.ddl);
    const auto summary_it = summary_by_key.find(table_key(table.database, table.name));
    if (summary_it != summary_by_key.end()) {
      const auto& summary = *summary_it->second;
      const bool view_like = node.kind == "view" || node.kind == "materialized_view" || node.kind == "refreshable_materialized_view";
      if (!view_like) {
        node.rows = summary.rows;
        node.logical_bytes = summary.logical_bytes;
        node.physical_bytes = summary.physical_bytes;
        node.resident_bytes = summary.resident_bytes;
        node.active_parts = summary.active_parts;
      }
      if (node.kind == "buffer") {
        const auto args = parse_engine_arguments(table.engine_full, "Buffer");
        if (args.size() >= 9) {
          node.buffer_layers = parse_u64(args[2]).value_or(0);
          node.buffer_min_time = parse_u64(args[3]);
          node.buffer_max_time = parse_u64(args[4]);
          node.buffer_min_rows = parse_u64(args[5]);
          node.buffer_max_rows = parse_u64(args[6]);
          node.buffer_min_bytes = parse_u64(args[7]);
          node.buffer_max_bytes = parse_u64(args[8]);
        }
      }
      node.health = summary.health;
      if (summary.replication.available && summary.replication.total_replicas > 0) {
        node.topology_badge = std::to_string(summary.replication.total_replicas) + "R";
      }
    }
    logical_node_index.emplace(node.id, out.nodes.size());
    kind_by_key.emplace(table_key(table.database, table.name), node.kind);
    out.nodes.push_back(std::move(node));
  }

  std::unordered_set<std::string> seen_edges;

  // system.tables exposes the materialized views which depend on each current
  // table. Filter both ends before serializing so a hidden MV cannot leak.
  std::string section_error;
  const bool dependencies_loaded = try_select(system,
      "SELECT toString(database), toString(name), toString(tupleElement(dep, 1)), toString(tupleElement(dep, 2)) "
      "FROM (SELECT toString(database) AS database, toString(name) AS name, arrayJoin(arrayZip(dependencies_database, dependencies_table)) AS dep FROM system.tables)",
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          const std::string source_db = block_string_at(block, 0, row);
          const std::string source_table = block_string_at(block, 1, row);
          const std::string dep_db = block_string_at(block, 2, row);
          const std::string dep_table = block_string_at(block, 3, row);
          if (is_row_pseudo_object(source_table) || is_row_pseudo_object(dep_table)) continue;
          if (!allowed.allows_table(source_db, source_table) || !allowed.allows_table(dep_db, dep_table)) continue;
          const auto kind_it = kind_by_key.find(table_key(dep_db, dep_table));
          std::string kind = "dependency";
          bool animate = false;
          if (kind_it != kind_by_key.end()) {
            if (kind_it->second == "materialized_view") { kind = "materialized_view"; animate = true; }
            else if (kind_it->second == "refreshable_materialized_view") { kind = "refreshable_mv"; animate = true; }
            else if (kind_it->second == "view") kind = "view";
          }
          add_edge_unique(out, seen_edges, {
            {}, table_node_id(source_db, source_table), table_node_id(dep_db, dep_table), kind,
            kind == "materialized_view" ? "Materialized View trigger" : "dependency", animate
          });
        }
      }, &section_error);
  if (!dependencies_loaded) {
    if (error) *error = "Graph dependency metadata query failed: " + section_error;
    return false;
  }

  // Add engine-specific destinations and targeted SELECT dependencies. SQL
  // parsing is deliberately limited to identifiers after FROM/JOIN/TO; unknown
  // constructs are omitted rather than guessed.
  std::set<std::string> referenced_clusters;
  for (const auto& table : raw) {
    const std::string from_id = table_node_id(table.database, table.name);
    const std::string kind = classify_node(table.engine, table.ddl);

    if (kind == "materialized_view" || kind == "refreshable_materialized_view") {
      const auto target = qualified_after_keyword(table.ddl, "TO", table.database);
      if (target && allowed.allows_table(target->database, target->table)) {
        add_edge_unique(out, seen_edges, {
          {}, from_id, table_node_id(target->database, target->table),
          kind == "refreshable_materialized_view" ? "refreshable_mv_output" : "materialized_view_output",
          kind == "refreshable_materialized_view" ? "refresh output" : "Materialized View output",
          true
        });
      }
    }

    if (kind == "view" || kind == "refreshable_materialized_view") {
      const std::string& select_sql = !table.as_select.empty() ? table.as_select : table.ddl;
      for (const auto& source : parse_select_sources(select_sql, table.database)) {
        if (!allowed.allows_table(source.database, source.table)) continue;
        add_edge_unique(out, seen_edges, {
          {}, table_node_id(source.database, source.table), from_id,
          kind == "refreshable_materialized_view" ? "refreshable_mv" : "view",
          kind == "refreshable_materialized_view" ? "refresh input" : "logical view",
          kind == "refreshable_materialized_view"
        });
      }
    }

    if (kind == "buffer") {
      const auto args = parse_engine_arguments(table.engine_full, "Buffer");
      if (args.size() >= 2) {
        const std::string dest_db = args[0].empty() ? table.database : args[0];
        const std::string dest_table = args[1];
        if (allowed.allows_table(dest_db, dest_table)) {
          add_edge_unique(out, seen_edges, {
            {}, from_id, table_node_id(dest_db, dest_table), "buffer", "buffer forwarding", true
          });
        }
      }
    }

    if (kind == "distributed") {
      const auto args = parse_engine_arguments(table.engine_full, "Distributed");
      if (!args.empty()) referenced_clusters.insert(args[0]);
      if (args.size() >= 3) {
        const std::string dest_db = args[1].empty() ? table.database : args[1];
        const std::string dest_table = args[2];
        if (allowed.allows_table(dest_db, dest_table)) {
          add_edge_unique(out, seen_edges, {
            {}, from_id, table_node_id(dest_db, dest_table), "distributed_route", "routes to", false
          });
        }
      }
    }
  }

  // Physical children are part of the same normalized model but are ignored in
  // Logical mode. Storage topology models ClickHouse placement explicitly as
  // table -> local replica -> storage policy -> ordered volumes -> disks. This
  // keeps logical table dependencies completely out of the physical view and
  // makes hot/warm/cold (including S3) policy order visible without guessing.
  std::unordered_set<std::string> disk_nodes_created;
  std::unordered_set<std::string> policy_nodes_created;
  std::unordered_set<std::string> volume_nodes_created;

  auto ensure_disk_node = [&](const std::string& database, const std::string& disk) {
    const std::string disk_id = "physical:database:" + database + ":disk:" + disk;
    if (disk_nodes_created.insert(disk_id).second) {
      ExplorerGraphNode disk_node;
      disk_node.id = disk_id;
      disk_node.layer = "physical";
      disk_node.kind = "disk";
      disk_node.database = database;
      disk_node.name = disk;
      disk_node.label = disk;
      disk_node.disk_name = disk;
      if (const auto info_it = disk_info_by_name.find(disk); info_it != disk_info_by_name.end()) {
        const auto& info = info_it->second;
        disk_node.host_name = info.host_name;
        disk_node.disk_path = info.path;
        disk_node.disk_type = info.type;
        disk_node.disk_free_space = info.free_space;
        disk_node.disk_total_space = info.total_space;
      }
      out.nodes.push_back(std::move(disk_node));
    }
    return disk_id;
  };

  for (const auto& table : raw) {
    const auto summary_it = summary_by_key.find(table_key(table.database, table.name));
    if (summary_it == summary_by_key.end()) continue;
    const auto& summary = *summary_it->second;
    const std::string parent = table_node_id(table.database, table.name);

    // View-like and non-persistent engines do not own a physical placement.
    const std::string table_kind = classify_node(table.engine, table.ddl);
    if (table_kind == "view" || table_kind == "materialized_view" ||
        table_kind == "refreshable_materialized_view" || table_kind == "dictionary" ||
        table.engine == "Memory" || table.engine == "Buffer") {
      continue;
    }

    std::string physical_parent = parent;
    if (summary.replication.available) {
      ExplorerGraphNode replica;
      replica.id = "physical:" + parent + ":replica:local";
      replica.layer = "physical";
      replica.parent_id = parent;
      replica.kind = "replica";
      replica.database = table.database;
      replica.name = summary.replication.replica_name.empty() ? "local replica" : summary.replication.replica_name;
      replica.label = replica.name;
      replica.replica_num = 1;
      physical_parent = replica.id;
      out.nodes.push_back(replica);
      add_edge_unique(out, seen_edges, {{}, parent, replica.id, "contains", "local replica", false});
    }

    // Log-family tables have real on-disk storage but no system.parts rows.
    // Resolve their system.tables.data_paths against system.disks instead of
    // incorrectly treating them as non-storing objects.
    if ((table.engine == "TinyLog" || table.engine == "Log" || table.engine == "StripeLog") && !table.data_paths.empty()) {
      std::unordered_set<std::string> attached;
      for (const auto& path : table.data_paths) {
        std::string best_disk;
        size_t best_prefix = 0;
        for (const auto& [disk_name, info] : disk_info_by_name) {
          if (info.path.empty() || path.rfind(info.path, 0) != 0 || info.path.size() <= best_prefix) continue;
          best_disk = disk_name;
          best_prefix = info.path.size();
        }
        if (best_disk.empty() || !attached.insert(best_disk).second) continue;
        const std::string disk_id = ensure_disk_node(table.database, best_disk);
        add_edge_unique(out, seen_edges, {{}, physical_parent, disk_id, "contains", "data path", false});
      }
      if (!attached.empty()) continue;
    }

    const auto policy_it = storage_policy_rows.find(summary.storage_policy);
    if (!summary.storage_policy.empty() && policy_it != storage_policy_rows.end() && !policy_it->second.empty()) {
      const std::string policy_id = "physical:database:" + table.database + ":policy:" + summary.storage_policy;
      if (policy_nodes_created.insert(policy_id).second) {
        ExplorerGraphNode policy_node;
        policy_node.id = policy_id;
        policy_node.layer = "physical";
        policy_node.kind = "storage_policy";
        policy_node.database = table.database;
        policy_node.name = summary.storage_policy;
        policy_node.label = summary.storage_policy;
        policy_node.storage_policy = summary.storage_policy;
        out.nodes.push_back(std::move(policy_node));
      }
      add_edge_unique(out, seen_edges, {{}, physical_parent, policy_id, "storage_policy", "storage policy", false});

      std::string previous_volume_id;
      for (const auto& volume : policy_it->second) {
        const std::string volume_id = policy_id + ":volume:" + std::to_string(volume.priority) + ":" + volume.volume;
        if (volume_nodes_created.insert(volume_id).second) {
          ExplorerGraphNode volume_node;
          volume_node.id = volume_id;
          volume_node.layer = "physical";
          volume_node.kind = "volume";
          volume_node.database = table.database;
          volume_node.name = volume.volume;
          volume_node.label = volume.volume;
          volume_node.storage_policy = summary.storage_policy;
          volume_node.volume_name = volume.volume;
          volume_node.volume_priority = volume.priority;
          volume_node.move_factor = volume.move_factor;
          volume_node.topology_badge = volume.type;
          out.nodes.push_back(std::move(volume_node));
        }

        // A policy is ordered. Draw the first volume from the policy and then
        // chain each colder tier from the previous volume instead of creating a
        // star. This makes SSD -> HDD -> S3 placement readable and keeps the
        // routing projection faithful to ClickHouse volume_priority.
        std::string volume_label = "priority " + std::to_string(volume.priority);
        if (volume.move_factor > 0.0) {
          std::ostringstream factor;
          factor << " · move " << volume.move_factor;
          volume_label += factor.str();
        }
        if (previous_volume_id.empty()) {
          add_edge_unique(out, seen_edges, {{}, policy_id, volume_id, "policy_volume", volume_label, false});
        } else {
          add_edge_unique(out, seen_edges, {{}, previous_volume_id, volume_id, "volume_tier", volume_label, false});
        }
        previous_volume_id = volume_id;

        for (const auto& disk : volume.disks) {
          if (disk.empty()) continue;
          const std::string disk_id = ensure_disk_node(table.database, disk);
          add_edge_unique(out, seen_edges, {{}, volume_id, disk_id, "volume_disk", "disk", false});
        }
      }

      // TTL is temporal metadata attached to the table, not another placement
      // path. It is serialized on the logical root as an ordered timeline so it
      // cannot distort the storage-policy DAG or create long crossing arrows.
    } else {
      // Engines/policies which do not expose system.storage_policies still get
      // a truthful fallback based on the disks that currently hold active parts.
      for (const auto& disk : summary.disks) {
        const std::string disk_id = ensure_disk_node(table.database, disk);
        add_edge_unique(out, seen_edges, {{}, physical_parent, disk_id, "contains", "disk", false});
      }
    }
  }

  // Expand Distributed cluster topology once in bulk. The cluster rows do not
  // reveal table names and are only attached to already-authorized Distributed
  // nodes which reference that cluster.
  if (!referenced_clusters.empty()) {
    std::unordered_map<std::string, std::vector<const RawTable*>> distributed_by_cluster;
    for (const auto& table : raw) {
      if (classify_node(table.engine, table.ddl) != "distributed") continue;
      const auto args = parse_engine_arguments(table.engine_full, "Distributed");
      if (!args.empty()) distributed_by_cluster[args[0]].push_back(&table);
    }

    struct ClusterRow { uint64_t shard = 0; uint64_t replica = 0; std::string host; };
    std::unordered_map<std::string, std::vector<ClusterRow>> cluster_rows;
    section_error.clear();
    const bool clusters_loaded = try_select(system,
      "SELECT toString(cluster), toString(shard_num), toString(replica_num), toString(host_name) FROM system.clusters ORDER BY cluster, shard_num, replica_num",
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          const std::string cluster = block_string_at(block, 0, row);
          if (!referenced_clusters.count(cluster)) continue;
          cluster_rows[cluster].push_back({
            parse_u64(block_string_at(block, 1, row)).value_or(0),
            parse_u64(block_string_at(block, 2, row)).value_or(0),
            block_string_at(block, 3, row)
          });
        }
      }, &section_error);
    if (!clusters_loaded) {
      if (error) *error = "Distributed cluster topology query failed: " + section_error;
      return false;
    }

    for (const auto& [cluster, tables] : distributed_by_cluster) {
      const auto rows_it = cluster_rows.find(cluster);
      if (rows_it == cluster_rows.end()) continue;
      uint64_t max_shard = 0;
      std::unordered_map<uint64_t, uint64_t> replicas_per_shard;
      for (const auto& row : rows_it->second) {
        max_shard = std::max(max_shard, row.shard);
        replicas_per_shard[row.shard] = std::max(replicas_per_shard[row.shard], row.replica);
      }
      uint64_t max_replica = 0;
      for (const auto& pair : replicas_per_shard) max_replica = std::max(max_replica, pair.second);

      for (const RawTable* table : tables) {
        const std::string parent = table_node_id(table->database, table->name);
        const auto logical_it = logical_node_index.find(parent);
        if (logical_it != logical_node_index.end() && max_shard > 0) {
          out.nodes[logical_it->second].topology_badge = std::to_string(max_shard) + "S × " + std::to_string(max_replica) + "R";
        }
        std::unordered_set<uint64_t> shard_created;
        for (const auto& row : rows_it->second) {
          const std::string shard_id = "physical:" + parent + ":shard:" + std::to_string(row.shard);
          if (shard_created.insert(row.shard).second) {
            ExplorerGraphNode shard;
            shard.id = shard_id;
            shard.layer = "physical";
            shard.parent_id = parent;
            shard.kind = "shard";
            shard.database = table->database;
            shard.name = "shard-" + std::to_string(row.shard);
            shard.label = shard.name;
            shard.shard_num = row.shard;
            out.nodes.push_back(shard);
            add_edge_unique(out, seen_edges, {{}, parent, shard_id, "contains", "shard", false});
          }
          ExplorerGraphNode replica;
          replica.id = shard_id + ":replica:" + std::to_string(row.replica);
          replica.layer = "physical";
          replica.parent_id = shard_id;
          replica.kind = "replica";
          replica.database = table->database;
          replica.name = row.host.empty() ? "replica-" + std::to_string(row.replica) : row.host;
          replica.label = replica.name;
          replica.shard_num = row.shard;
          replica.replica_num = row.replica;
          replica.host_name = row.host;
          out.nodes.push_back(replica);
          add_edge_unique(out, seen_edges, {{}, shard_id, replica.id, "contains", "replica", false});
        }
      }
    }
  }

  // A missing optional source is structural and valid; failure to determine
  // whether it exists is not. Never turn a ClickHouse exception into a fake
  // "unavailable" state.
  section_error.clear();
  bool refresh_table_exists = false;
  const bool refresh_probe_loaded = try_select(system,
      "SELECT toString(count() > 0) FROM system.tables WHERE database = 'system' AND name = 'view_refreshes'",
      [&](const clickhouse::Block& block) {
        if (block.GetRowCount()) refresh_table_exists = truthy(block_string_at(block, 0, 0));
      }, &section_error);
  if (!refresh_probe_loaded) {
    if (error) *error = "Refreshable-view capability query failed: " + section_error;
    return false;
  }
  out.refreshable_views_available = refresh_table_exists;
  return true;
}

bool load_explorer_graph_activity(
    clickhouse::Client& system,
    const AllowedObjectSet& allowed,
    const ExplorerGraph& graph,
    ExplorerGraphActivity& out,
    std::string* error) {
  out = ExplorerGraphActivity{};
  out.generated_at_ms = now_ms();
  out.metric_scope = graph.metric_scope;
  std::unordered_map<std::string, size_t> activity_index;
  std::unordered_set<std::string> graph_logical_ids;
  for (const auto& node : graph.nodes) {
    if (node.layer == "logical") graph_logical_ids.insert(node.id);
  }

  std::string first_error;
  const bool query_ok = try_select(system,
      "SELECT toString(arrayJoin(tables)) AS object, "
      "toString(sum(read_rows) / 60.0), toString(sum(read_bytes) / 60.0), "
      "toString(sum(written_rows) / 60.0), toString(sum(written_bytes) / 60.0) "
      "FROM system.query_log WHERE event_time >= now() - INTERVAL 1 MINUTE AND type = 'QueryFinish' GROUP BY object",
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          const std::string object = block_string_at(block, 0, row);
          const size_t dot = object.find('.');
          if (dot == std::string::npos) continue;
          const std::string database = object.substr(0, dot);
          const std::string table = object.substr(dot + 1);
          if (!allowed.allows_table(database, table)) continue;
          if (!graph_logical_ids.count(table_node_id(database, table))) continue;
          auto& a = activity_for(activity_index, out, database, table);
          a.read_rows_per_second = parse_double(block_string_at(block, 1, row));
          a.read_bytes_per_second = parse_double(block_string_at(block, 2, row));
          a.client_write_rows_per_second = parse_double(block_string_at(block, 3, row));
          a.client_write_bytes_per_second = parse_double(block_string_at(block, 4, row));
        }
      }, &first_error);

  std::string parts_error;
  const bool parts_ok = try_select(system,
      "SELECT toString(database), toString(`table`), toString(sum(rows) / 60.0), toString(sum(size_in_bytes) / 60.0) "
      "FROM system.part_log WHERE event_time >= now() - INTERVAL 1 MINUTE AND event_type = 'NewPart' GROUP BY database, `table`",
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          const std::string database = block_string_at(block, 0, row);
          const std::string table = block_string_at(block, 1, row);
          if (!allowed.allows_table(database, table)) continue;
          if (!graph_logical_ids.count(table_node_id(database, table))) continue;
          auto& a = activity_for(activity_index, out, database, table);
          a.physical_write_rows_per_second = parse_double(block_string_at(block, 2, row));
          a.physical_write_bytes_per_second = parse_double(block_string_at(block, 3, row));
        }
      }, &parts_error);

  std::string replicas_error;
  const bool replicas_ok = try_select(system,
      "SELECT toString(database), toString(`table`), toString(queue_size), toString(absolute_delay) FROM system.replicas",
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          const std::string database = block_string_at(block, 0, row);
          const std::string table = block_string_at(block, 1, row);
          if (!allowed.allows_table(database, table)) continue;
          if (!graph_logical_ids.count(table_node_id(database, table))) continue;
          auto& a = activity_for(activity_index, out, database, table);
          a.replication_queue = parse_u64(block_string_at(block, 2, row)).value_or(0);
          a.replication_delay_seconds = parse_u64(block_string_at(block, 3, row)).value_or(0);
        }
      }, &replicas_error);

  std::string refresh_error;
  bool refresh_ok = true;
  if (graph.refreshable_views_available) refresh_ok = try_select(system,
      "SELECT toString(database), toString(view), toString(status), "
      "toString(ifNull(last_refresh_time, toDateTime(0))), toString(ifNull(next_refresh_time, toDateTime(0))), "
      "toString(ifNull(read_rows, 0)), toString(ifNull(written_rows, 0)) FROM system.view_refreshes",
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          const std::string database = block_string_at(block, 0, row);
          const std::string table = block_string_at(block, 1, row);
          if (!allowed.allows_table(database, table)) continue;
          if (!graph_logical_ids.count(table_node_id(database, table))) continue;
          auto& a = activity_for(activity_index, out, database, table);
          a.refresh_status = block_string_at(block, 2, row);
          a.last_refresh_time = block_string_at(block, 3, row);
          a.next_refresh_time = block_string_at(block, 4, row);
          a.refresh_read_rows = parse_u64(block_string_at(block, 5, row));
          a.refresh_written_rows = parse_u64(block_string_at(block, 6, row));
        }
      }, &refresh_error);

  // Derive edge activity only after node activity has been ACL-filtered.
  std::unordered_map<std::string, const ExplorerGraphNodeActivity*> by_id;
  for (const auto& node : out.nodes) by_id[node.node_id] = &node;
  for (const auto& edge : graph.edges) {
    if (!edge.can_animate) continue;
    ExplorerGraphEdgeActivity activity;
    activity.edge_id = edge.id;
    const ExplorerGraphNodeActivity* source = nullptr;
    const ExplorerGraphNodeActivity* target = nullptr;
    if (const auto it = by_id.find(edge.from); it != by_id.end()) source = it->second;
    if (const auto it = by_id.find(edge.to); it != by_id.end()) target = it->second;

    if (edge.kind == "refreshable_mv_output" || edge.kind == "refreshable_mv") {
      const auto* refresh = source && !source->refresh_status.empty() ? source : target;
      if (refresh) {
        activity.state = refresh->refresh_status;
        activity.active = refresh->refresh_status == "Running" || refresh->refresh_status == "Scheduling";
        activity.rows_per_second = activity.active && refresh->refresh_written_rows ? static_cast<double>(*refresh->refresh_written_rows) : 0.0;
      }
    } else {
      const auto value = target && target->physical_write_rows_per_second
          ? target->physical_write_rows_per_second
          : (source ? source->client_write_rows_per_second : std::nullopt);
      const auto bytes = target && target->physical_write_bytes_per_second
          ? target->physical_write_bytes_per_second
          : (source ? source->client_write_bytes_per_second : std::nullopt);
      activity.rows_per_second = value.value_or(0.0);
      activity.bytes_per_second = bytes.value_or(0.0);
      activity.active = activity.rows_per_second > 0.0 || activity.bytes_per_second > 0.0;
    }
    out.edges.push_back(std::move(activity));
  }

  if (!query_ok) {
    if (error) *error = "Graph query activity query failed: " + first_error;
    return false;
  }
  if (!parts_ok) {
    if (error) *error = "Graph part activity query failed: " + parts_error;
    return false;
  }
  if (!replicas_ok) {
    if (error) *error = "Graph replication activity query failed: " + replicas_error;
    return false;
  }
  if (!refresh_ok) {
    if (error) *error = "Graph refresh activity query failed: " + refresh_error;
    return false;
  }
  return true;
}

} // namespace chdash
