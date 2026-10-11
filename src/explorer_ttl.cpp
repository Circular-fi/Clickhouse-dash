#include "explorer_ttl.hpp"

#include "explorer_values.hpp"
#include "json_text.hpp"
#include "sql_structure.hpp"

#include <algorithm>
#include <cctype>
#include <optional>
#include <utility>

namespace chdash {

using explorer::contains_ci;

namespace {

using sql::find_keyword;
using sql::parse_identifier;

std::optional<std::string> parse_ttl_destination(std::string_view text, size_t& pos) {
  while (pos < text.size() && std::isspace(static_cast<unsigned char>(text[pos]))) ++pos;
  if (pos >= text.size()) return std::nullopt;
  if (text[pos] != '\'') return parse_identifier(text, pos);
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

// The text with each run of blanks written as one space, without the blanks and the commas at its start.
std::string compact_spaces(std::string_view value) { return trim_copy(sql::compact_spaces(value)); }

std::vector<std::string> split_top_level_commas(std::string_view text) { return sql::split_top_level(text, ','); }

std::optional<size_t> find_last_top_level_plus(std::string_view text, size_t before) {
  return sql::find_last_top_level(text, '+', before);
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
    const auto at = find_keyword(expression, function_name);
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

  const auto interval_at = find_keyword(expression, "INTERVAL");
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

}  // namespace

std::vector<ExplorerGraphTtlRule> parse_table_ttl_rules(std::string_view ddl) {
  std::vector<ExplorerGraphTtlRule> out;
  const auto ttl_at = find_keyword(ddl, "TTL");
  if (!ttl_at) return out;

  const size_t start = *ttl_at + 3;
  size_t end = ddl.size();
  for (std::string_view terminal : {std::string_view("SETTINGS"), std::string_view("COMMENT")}) {
    if (const auto at = find_keyword(ddl, terminal, start)) end = std::min(end, *at);
  }
  if (end <= start) return out;

  for (const auto& raw_rule : split_top_level_commas(ddl.substr(start, end - start))) {
    ExplorerGraphTtlRule rule;
    rule.action = "delete"; // A bare ClickHouse TTL expression means DELETE.

    struct ActionMatch { size_t at; std::string_view keyword; std::string action; std::string target_kind; };
    std::vector<ActionMatch> actions;
    const auto add_action = [&](std::string_view keyword, std::string action, std::string target_kind = {}) {
      if (const auto at = find_keyword(raw_rule, keyword)) actions.push_back({*at, keyword, std::move(action), std::move(target_kind)});
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

    // Cut on a character boundary: a cut inside a UTF-8 sequence is not valid text.
    if (rule.expression.size() > 180) rule.expression = std::string(utf8_prefix(rule.expression, 177)) + "…";
    if (rule.base_expression.size() > 96) rule.base_expression = std::string(utf8_prefix(rule.base_expression, 93)) + "…";
    if (rule.target.size() > 128) rule.target = std::string(utf8_prefix(rule.target, 125)) + "…";
    out.push_back(std::move(rule));
  }
  return out;
}

}  // namespace chdash
