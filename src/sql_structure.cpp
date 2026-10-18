#include "sql_structure.hpp"

#include "sql_lexer.hpp"

#include <algorithm>
#include <cctype>
#include <set>
#include <utility>

namespace chdash {
namespace sql {
namespace {

// The result holds the tokens of a text that carry meaning.
// The tokens have no blank and no comment.
// Each token has the depth of the brackets at that token.
// The depth of an opening bracket is the depth outside it.
// The depth of a closing bracket is also the depth outside it.
struct View {
  std::string_view text;
  std::vector<Token> tokens;  // every token
  std::vector<size_t> sig;    // the indices (in tokens) of the significant ones
  std::vector<int> depth;     // for each significant token

  explicit View(std::string_view source) : text(source), tokens(lex(source)) {
    int level = 0;
    for (size_t i = 0; i < tokens.size(); ++i) {
      const Token& t = tokens[i];
      if (is_trivia(t.kind)) continue;
      const bool punct = t.kind == TokenKind::Punct;
      const char c = punct ? text[t.begin] : '\0';
      if (punct && (c == ')' || c == ']' || c == '}') && level > 0) --level;
      sig.push_back(i);
      depth.push_back(level);
      if (punct && (c == '(' || c == '[' || c == '{')) ++level;
    }
  }

  size_t size() const { return sig.size(); }
  const Token& at(size_t k) const { return tokens[sig[k]]; }
  std::string_view text_of(size_t k) const { return at(k).text(text); }
  bool is_punct(size_t k, char c) const { return k < size() && at(k).kind == TokenKind::Punct && text[at(k).begin] == c; }
  bool is_word(size_t k, std::string_view word) const {
    if (k >= size() || at(k).kind != TokenKind::Word) return false;
    const std::string_view value = text_of(k);
    if (value.size() != word.size()) return false;
    for (size_t i = 0; i < value.size(); ++i) {
      if (std::toupper(static_cast<unsigned char>(value[i])) != std::toupper(static_cast<unsigned char>(word[i]))) return false;
    }
    return true;
  }
  bool is_name(size_t k) const {
    return k < size() && (at(k).kind == TokenKind::Word || (at(k).kind == TokenKind::QuotedIdent && at(k).closed));
  }
  // The index of the first significant token that starts at or after the byte `pos`.
  size_t first_at_or_after(size_t pos) const {
    size_t k = 0;
    while (k < size() && at(k).begin < pos) ++k;
    return k;
  }
};

std::vector<std::string_view> words_of(std::string_view keyword) {
  std::vector<std::string_view> words;
  size_t i = 0;
  while (i < keyword.size()) {
    while (i < keyword.size() && keyword[i] == ' ') ++i;
    const size_t begin = i;
    while (i < keyword.size() && keyword[i] != ' ') ++i;
    if (i > begin) words.push_back(keyword.substr(begin, i - begin));
  }
  return words;
}

// The name that a Word or a quoted name represents.
std::string name_of(const View& v, size_t k) {
  const Token& t = v.at(k);
  if (t.kind != TokenKind::QuotedIdent) return std::string(t.text(v.text));
  const char quote = v.text[t.begin];
  std::string out;
  for (size_t i = t.begin + 1; i + 1 < t.end;) {
    if (v.text[i] == quote && v.text[i + 1] == quote) {
      out.push_back(quote);
      i += 2;
    } else if (v.text[i] == '\\' && i + 2 < t.end) {
      out.push_back(v.text[i + 1]);
      i += 2;
    } else {
      out.push_back(v.text[i++]);
    }
  }
  return out;
}

// These words end the name of a table. They start the next part of a SELECT.
// A bare word after the table is an alias. It is not an alias when it is one of these words.
bool clause_word(std::string_view word) {
  static const char* const kWords[] = {
      "WHERE", "PREWHERE", "GROUP", "ORDER", "LIMIT", "HAVING", "UNION", "JOIN", "INNER", "LEFT", "RIGHT", "FULL",
      "CROSS", "ANY", "ALL", "ASOF", "SEMI", "ANTI", "ARRAY", "GLOBAL", "ON", "USING", "SETTINGS", "FORMAT", "WINDOW",
      "QUALIFY", "SAMPLE", "FINAL", "OFFSET", "FETCH", "INTERSECT", "EXCEPT", "WITH", "PASTE", "AS", "SELECT", "FROM",
      "INTO", "OUTER", "NATURAL", "STRAIGHT_JOIN", "ENGINE", "TO"};
  for (const char* w : kWords) {
    if (word.size() != std::char_traits<char>::length(w)) continue;
    bool same = true;
    for (size_t i = 0; i < word.size() && same; ++i) same = std::toupper(static_cast<unsigned char>(word[i])) == w[i];
    if (same) return true;
  }
  return false;
}

// FROM can be a part of a function call. It is not the clause of a SELECT.
// Examples: EXTRACT(YEAR FROM t), TRIM(BOTH ' ' FROM s), SUBSTRING(s FROM 2), and IS DISTINCT FROM.
bool from_of_a_function(const View& v, size_t k) {
  if (k > 0 && v.is_word(k - 1, "DISTINCT")) return true;
  // The bracket that is open at k, and the word before it.
  int level = 0;
  for (size_t i = k; i-- > 0;) {
    if (v.is_punct(i, ')') || v.is_punct(i, ']') || v.is_punct(i, '}')) {
      ++level;
    } else if (v.is_punct(i, '(') || v.is_punct(i, '[') || v.is_punct(i, '{')) {
      if (level == 0) {
        if (!v.is_punct(i, '(') || i == 0) return false;
        for (const char* name : {"EXTRACT", "SUBSTRING", "SUBSTR", "MID", "TRIM", "POSITION"}) {
          if (v.is_word(i - 1, name)) return true;
        }
        return false;
      }
      --level;
    }
  }
  return false;
}

// One table after FROM, JOIN or a comma of FROM. `first` is the index of its first name; `second` is the index of the table name of
// `db.table` (qualified). `cte` is true for a reference to a CTE of the statement.
struct RelationAt {
  size_t first = 0;
  bool qualified = false;
  size_t second = 0;
  bool cte = false;
};

// The tables that a SELECT reads, with their tokens. Refer to relation_sources.
std::vector<RelationAt> relations_of(const View& v) {
  // The names of the CTEs, for example `WITH a AS (...), b AS (...)`. A reference to a CTE is not a table.
  std::set<std::string> ctes;
  for (size_t k = 1; k + 2 < v.size(); ++k) {
    if (!v.is_name(k) || !v.is_word(k + 1, "AS") || !v.is_punct(k + 2, '(')) continue;
    if (v.is_word(k - 1, "WITH") || v.is_punct(k - 1, ',')) ctes.insert(name_of(v, k));
  }
  std::vector<RelationAt> result;
  const auto relation_at = [&](size_t& k) -> bool {
    // k is the first token of the name. Move k past the name and its alias when the name is a table.
    if (!v.is_name(k)) return false;
    RelationAt relation;
    relation.first = k;
    size_t next = k + 1;
    if (v.is_punct(next, '.') && v.is_name(next + 1)) {
      relation.qualified = true;
      relation.second = next + 1;
      next += 2;
    }
    if (v.is_punct(next, '(')) return false;  // a table function: numbers(10), remote(...)
    k = next;
    relation.cte = !relation.qualified && ctes.count(name_of(v, relation.first)) != 0;
    result.push_back(relation);
    return true;
  };
  for (size_t k = 0; k < v.size(); ++k) {
    const bool from = v.is_word(k, "FROM");
    const bool join = v.is_word(k, "JOIN");
    if (!from && !join) continue;
    if (join && k > 0 && v.is_word(k - 1, "ARRAY")) continue;  // ARRAY JOIN joins an array of the row
    if (from && from_of_a_function(v, k)) continue;
    size_t at = k + 1;
    if (!relation_at(at)) continue;
    // FROM a, b: these are the tables of a comma join. Skip the alias and FINAL of each table.
    while (from) {
      if (v.is_word(at, "AS") && v.is_name(at + 1)) at += 2;
      else if (v.is_name(at) && v.at(at).kind == TokenKind::Word && !clause_word(v.text_of(at))) at += 1;
      if (v.is_word(at, "FINAL")) at += 1;
      if (!v.is_punct(at, ',') || v.depth[at] != v.depth[k]) break;
      ++at;
      if (!relation_at(at)) break;
    }
  }
  return result;
}

// The value of a closed text or quoted name, without its marks. A doubled mark and an escaped byte are one byte.
std::string unquoted(const View& v, size_t k) {
  const Token& t = v.at(k);
  if (t.kind != TokenKind::QuotedIdent && t.kind != TokenKind::String) return std::string(t.text(v.text));
  const char quote = v.text[t.begin];
  std::string out;
  for (size_t i = t.begin + 1; i + 1 < t.end;) {
    if (v.text[i] == quote && v.text[i + 1] == quote) {
      out.push_back(quote);
      i += 2;
    } else if (v.text[i] == '\\' && i + 2 < t.end) {
      out.push_back(v.text[i + 1]);
      i += 2;
    } else {
      out.push_back(v.text[i++]);
    }
  }
  return out;
}

bool is_text(const View& v, size_t k) { return k < v.size() && v.at(k).kind == TokenKind::String && v.at(k).closed; }

// How a function or an engine names a database in its arguments.
struct DatabaseArguments {
  const char* name;      // compared without case
  int database;          // the index of the database argument
  int table;             // the index of the table argument, or -1
  bool dotted_text;      // a text 'db.name' in the database argument names the database and the object; a bare name does not
  size_t min_args;       // with fewer arguments, the function names no database (merge('^t') reads the current database)
};

const DatabaseArguments* database_arguments(std::string_view word) {
  static const DatabaseArguments kFunctions[] = {
      {"Distributed", 1, 2, false, 3}, {"Buffer", 0, 1, false, 2},  {"Merge", 0, -1, false, 2},
      {"Dictionary", 0, -1, true, 1},  {"remote", 1, 2, false, 2},  {"remoteSecure", 1, 2, false, 2},
      {"cluster", 1, 2, false, 2},     {"clusterAllReplicas", 1, 2, false, 2},
  };
  const auto same = [&](const char* name) {
    if (word.size() != std::char_traits<char>::length(name)) return false;
    for (size_t i = 0; i < word.size(); ++i) {
      if (std::tolower(static_cast<unsigned char>(word[i])) != std::tolower(static_cast<unsigned char>(name[i]))) return false;
    }
    return true;
  };
  for (const auto& function : kFunctions) {
    if (same(function.name)) return &function;
  }
  // The functions that read a dictionary or a Join table by its name: the first argument is 'db.name'.
  static const DatabaseArguments kDictionaryFunction{"dictGet", 0, -1, true, 1};
  std::string lower(word);
  for (char& c : lower) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  if (lower.rfind("dictget", 0) == 0 || lower == "dicthas" || lower == "dictisin" || lower == "joinget" || lower == "joingetornull") {
    return &kDictionaryFunction;
  }
  return nullptr;
}

} // namespace

std::optional<size_t> find_keyword(std::string_view text, std::string_view keyword, size_t start) {
  const View v(text);
  const std::vector<std::string_view> words = words_of(keyword);
  if (words.empty()) return std::nullopt;
  for (size_t k = v.first_at_or_after(start); k < v.size(); ++k) {
    if (v.depth[k] != 0 || !v.is_word(k, words[0])) continue;
    bool match = true;
    for (size_t w = 1; w < words.size() && match; ++w) match = k + w < v.size() && v.depth[k + w] == 0 && v.is_word(k + w, words[w]);
    if (match) return v.at(k).begin;
  }
  return std::nullopt;
}

std::vector<std::string> split_top_level(std::string_view text, char delimiter) {
  const View v(text);
  const auto trimmed = [](std::string_view part) {
    const auto first = part.find_first_not_of(" \t\r\n");
    if (first == std::string_view::npos) return std::string();
    const auto last = part.find_last_not_of(" \t\r\n");
    return std::string(part.substr(first, last - first + 1));
  };
  std::vector<std::string> parts;
  size_t begin = 0;
  for (size_t k = 0; k < v.size(); ++k) {
    if (v.depth[k] != 0 || !v.is_punct(k, delimiter)) continue;
    const std::string part = trimmed(text.substr(begin, v.at(k).begin - begin));
    if (!part.empty()) parts.push_back(part);
    begin = v.at(k).end;
  }
  const std::string tail = trimmed(text.substr(begin));
  if (!tail.empty()) parts.push_back(tail);
  return parts;
}

std::optional<size_t> find_last_top_level(std::string_view text, char mark, size_t before) {
  const View v(text);
  std::optional<size_t> found;
  for (size_t k = 0; k < v.size() && v.at(k).begin < before; ++k) {
    if (v.depth[k] == 0 && v.is_punct(k, mark)) found = v.at(k).begin;
  }
  return found;
}

std::string compact_spaces(std::string_view text) {
  std::string out;
  out.reserve(text.size());
  bool pending = false;
  for (const Token& token : lex(text)) {
    if (token.kind == TokenKind::Blank) {
      pending = !out.empty();
      continue;
    }
    if (pending) out.push_back(' ');
    pending = false;
    out.append(token.text(text));
  }
  return out;
}

std::optional<std::string> parse_identifier(std::string_view text, size_t& pos) {
  while (pos < text.size() && std::isspace(static_cast<unsigned char>(text[pos]))) ++pos;
  if (pos >= text.size()) return std::nullopt;
  const char quote = text[pos];
  if (quote == '`' || quote == '"') {
    bool closed = false;
    const size_t end = quoted_end(text, pos, &closed);
    if (!closed) return std::nullopt;
    std::string value;
    for (size_t i = pos + 1; i + 1 < end;) {
      if (text[i] == quote && text[i + 1] == quote) {
        value.push_back(quote);
        i += 2;
      } else if (text[i] == '\\' && i + 2 < end) {
        value.push_back(text[i + 1]);
        i += 2;
      } else {
        value.push_back(text[i++]);
      }
    }
    pos = end;
    return value;
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
  auto first = parse_identifier(text, pos);
  if (!first || first->empty()) return std::nullopt;
  while (pos < text.size() && std::isspace(static_cast<unsigned char>(text[pos]))) ++pos;
  if (pos < text.size() && text[pos] == '.') {
    ++pos;
    auto second = parse_identifier(text, pos);
    if (!second || second->empty()) return std::nullopt;
    return QualifiedName{*first, *second};
  }
  return QualifiedName{default_database, *first};
}

std::vector<std::string> engine_arguments(std::string_view engine_full, std::string_view engine_name) {
  const View v(engine_full);
  if (v.size() < 2 || v.at(0).kind != TokenKind::Word || v.text_of(0) != engine_name || !v.is_punct(1, '(')) return {};
  std::vector<std::string> args;
  std::string current;
  const auto flush = [&] {
    const auto first = current.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) {
      args.emplace_back();
    } else {
      args.push_back(current.substr(first, current.find_last_not_of(" \t\r\n") - first + 1));
    }
    current.clear();
  };
  int level = 0;
  // Read every token, the blanks too: an argument keeps the spaces inside it.
  for (size_t i = v.sig[1] + 1; i < v.tokens.size(); ++i) {
    const Token& t = v.tokens[i];
    if (t.kind == TokenKind::Punct) {
      const char c = engine_full[t.begin];
      if (c == '(' || c == '[' || c == '{') {
        ++level;
      } else if (c == ')' || c == ']' || c == '}') {
        if (level == 0) {
          flush();
          return args;
        }
        --level;
      } else if (c == ',' && level == 0) {
        flush();
        continue;
      }
    }
    if ((t.kind == TokenKind::String || t.kind == TokenKind::QuotedIdent) && t.closed) {
      // 'db' gives db. Remove the marks. A doubled mark and an escaped byte are one byte.
      const char quote = engine_full[t.begin];
      for (size_t k = t.begin + 1; k + 1 < t.end;) {
        if (engine_full[k] == quote && engine_full[k + 1] == quote) {
          current.push_back(quote);
          k += 2;
        } else if (engine_full[k] == '\\' && k + 2 < t.end) {
          current.push_back(engine_full[k + 1]);
          k += 2;
        } else {
          current.push_back(engine_full[k++]);
        }
      }
      continue;
    }
    current.append(t.text(engine_full));
  }
  // The bracket is not closed. The result holds the arguments that are read so far.
  return args;
}

std::vector<QualifiedName> relation_sources(std::string_view select_sql, const std::string& default_database) {
  const View v(select_sql);
  std::vector<QualifiedName> result;
  std::set<std::pair<std::string, std::string>> seen;
  for (const RelationAt& relation : relations_of(v)) {
    if (relation.cte) continue;
    QualifiedName name = relation.qualified ? QualifiedName{name_of(v, relation.first), name_of(v, relation.second)}
                                            : QualifiedName{default_database, name_of(v, relation.first)};
    if (seen.insert({name.database, name.table}).second) result.push_back(std::move(name));
  }
  return result;
}

std::vector<DatabaseReference> database_references(std::string_view text) {
  const View v(text);
  std::vector<DatabaseReference> refs;
  const auto add_qualified = [&](size_t database, size_t object) {
    DatabaseReference ref;
    ref.database = name_of(v, database);
    ref.begin = v.at(database).begin;
    ref.end = v.at(database).end;
    ref.object_begin = v.at(object).begin;
    ref.object_end = v.at(object).end;
    if (!ref.database.empty()) refs.push_back(std::move(ref));
  };
  // `db.table` at k: true when k starts a qualified name of two parts. In an argument, a bracket after it makes a function call. After
  // TO and AS, a bracket after it is the list of the columns: `TO db.t (x Int8)`.
  const auto qualified_at = [&](size_t k, bool columns_may_follow = false) {
    return v.is_name(k) && v.is_punct(k + 1, '.') && v.is_name(k + 2) && !v.is_punct(k + 3, '.') &&
           (columns_may_follow || !v.is_punct(k + 3, '('));
  };

  for (const RelationAt& relation : relations_of(v)) {
    if (relation.qualified) add_qualified(relation.first, relation.second);
  }
  for (size_t k = 0; k + 1 < v.size(); ++k) {
    // x IN db.t, the TO of a materialized view and CREATE TABLE t AS db.t.
    const bool in = v.is_word(k, "IN");
    const bool top = v.depth[k] == 0 && (v.is_word(k, "TO") || v.is_word(k, "AS"));
    if ((in || top) && qualified_at(k + 1, top)) add_qualified(k + 1, k + 3);
  }

  for (size_t k = 0; k + 1 < v.size(); ++k) {
    if (v.at(k).kind != TokenKind::Word || !v.is_punct(k + 1, '(')) continue;
    if (k > 0 && v.is_punct(k - 1, '.')) continue;  // a name of a column or a table, not a function
    // Only these functions are read, so a long text with many calls is not read again for each call.
    const bool source = v.is_word(k, "CLICKHOUSE");
    const DatabaseArguments* spec = source ? nullptr : database_arguments(v.text_of(k));
    if (!source && !spec) continue;
    // The arguments at the depth of the bracket: the significant tokens of each one.
    const int inside = v.depth[k + 1] + 1;
    std::vector<std::pair<size_t, size_t>> args;  // [first, last) of each argument
    size_t first = k + 2;
    size_t close = k + 2;
    for (; close < v.size(); ++close) {
      if (v.depth[close] == inside - 1 && v.is_punct(close, ')')) break;
      if (v.depth[close] == inside && v.is_punct(close, ',')) {
        args.emplace_back(first, close);
        first = close + 1;
      }
    }
    if (close >= v.size()) continue;  // the bracket is not closed
    if (first < close) args.emplace_back(first, close);

    // DB 'x' and TABLE 'y' in SOURCE(CLICKHOUSE(...)) of a dictionary.
    if (source) {
      DatabaseReference ref;
      for (size_t i = k + 2; i + 1 < close; ++i) {
        if (v.depth[i] != inside || !(is_text(v, i + 1) || v.is_name(i + 1))) continue;
        if (v.is_word(i, "DB")) {
          ref.database = unquoted(v, i + 1);
          ref.begin = v.at(i + 1).begin;
          ref.end = v.at(i + 1).end;
        } else if (v.is_word(i, "TABLE")) {
          ref.object_begin = v.at(i + 1).begin;
          ref.object_end = v.at(i + 1).end;
        }
      }
      if (!ref.database.empty()) refs.push_back(std::move(ref));
      continue;
    }

    if (args.size() < spec->min_args || static_cast<size_t>(spec->database) >= args.size()) continue;
    const auto [a, b] = args[static_cast<size_t>(spec->database)];
    if (b - a == 3 && qualified_at(a)) {
      add_qualified(a, a + 2);
      continue;
    }
    if (b - a != 1 || !(is_text(v, a) || v.is_name(a))) continue;
    // Dictionary(d) and dictGet(d, ...) name an object of the current database.
    if (spec->dotted_text && !is_text(v, a)) continue;
    DatabaseReference ref;
    ref.database = unquoted(v, a);
    ref.begin = v.at(a).begin;
    ref.end = v.at(a).end;
    if (spec->dotted_text) {
      // 'db.name': the database is the part before the first dot. A text without a dot names an object of the current database.
      const size_t dot = ref.database.find('.');
      if (dot == std::string::npos) continue;
      ref.database.resize(dot);
    } else if (spec->table >= 0 && static_cast<size_t>(spec->table) < args.size()) {
      const auto [ta, tb] = args[static_cast<size_t>(spec->table)];
      if (tb - ta == 1 && (is_text(v, ta) || v.is_name(ta))) {
        ref.object_begin = v.at(ta).begin;
        ref.object_end = v.at(ta).end;
      }
    }
    if (!ref.database.empty()) refs.push_back(std::move(ref));
  }

  std::sort(refs.begin(), refs.end(), [](const DatabaseReference& x, const DatabaseReference& y) { return x.begin < y.begin; });
  refs.erase(std::unique(refs.begin(), refs.end(), [](const DatabaseReference& x, const DatabaseReference& y) { return x.begin == y.begin; }),
             refs.end());
  return refs;
}

std::vector<std::string> referenced_databases(std::string_view text) {
  std::vector<std::string> out;
  std::set<std::string> seen;
  for (auto& ref : database_references(text)) {
    if (seen.insert(ref.database).second) out.push_back(std::move(ref.database));
  }
  return out;
}

std::string mask_databases(std::string_view text, const std::vector<std::string>& hidden) {
  if (hidden.empty() || text.empty()) return std::string(text);
  const std::set<std::string> masked(hidden.begin(), hidden.end());
  std::vector<std::pair<size_t, size_t>> spans;
  for (const auto& ref : database_references(text)) {
    if (masked.count(ref.database) == 0) continue;
    spans.emplace_back(ref.begin, ref.end);
    if (ref.object_end > ref.object_begin) spans.emplace_back(ref.object_begin, ref.object_end);
  }
  // Every other `db.name` of a hidden database: an expression such as db.table.column.
  const View v(text);
  for (size_t k = 0; k + 2 < v.size(); ++k) {
    if (!v.is_name(k) || !v.is_punct(k + 1, '.') || !v.is_name(k + 2)) continue;
    if (k > 0 && v.is_punct(k - 1, '.')) continue;
    if (masked.count(name_of(v, k)) == 0) continue;
    spans.emplace_back(v.at(k).begin, v.at(k).end);
    spans.emplace_back(v.at(k + 2).begin, v.at(k + 2).end);
  }
  if (spans.empty()) return std::string(text);
  std::sort(spans.begin(), spans.end());
  std::string out;
  out.reserve(text.size());
  size_t at = 0;
  for (const auto& [begin, end] : spans) {
    if (begin < at) continue;  // the same span twice
    out.append(text.substr(at, begin - at));
    out.append(text[begin] == '\'' ? "'[HIDDEN]'" : "`[HIDDEN]`");
    at = end;
  }
  out.append(text.substr(at));
  return out;
}

std::optional<QualifiedName> materialized_view_target(std::string_view create_sql, const std::string& default_database) {
  const auto mv = find_keyword(create_sql, "MATERIALIZED");
  if (!mv) return std::nullopt;
  const auto view = find_keyword(create_sql, "VIEW", *mv + 12);
  if (!view) return std::nullopt;
  const auto to = find_keyword(create_sql, "TO", *view + 4);
  if (!to) return std::nullopt;
  const auto as = find_keyword(create_sql, "AS", *view + 4);
  if (as && *to > *as) return std::nullopt;
  const auto engine = find_keyword(create_sql, "ENGINE", *view + 4);
  if (engine && *engine < *to) return std::nullopt;
  size_t pos = *to + 2;
  auto target = parse_qualified_name(create_sql, pos, default_database);
  while (pos < create_sql.size() && std::isspace(static_cast<unsigned char>(create_sql[pos]))) ++pos;
  if (pos < create_sql.size() && create_sql[pos] == '\'') return std::nullopt;
  return target;
}

std::string table_ttl_clause(std::string_view create_sql) {
  const auto engine = find_keyword(create_sql, "ENGINE");
  if (!engine) return {};
  const auto ttl = find_keyword(create_sql, "TTL", *engine);
  if (!ttl) return {};
  const size_t start = *ttl + 3;
  size_t end = create_sql.size();
  for (const std::string_view terminal : {std::string_view("SETTINGS"), std::string_view("COMMENT")}) {
    if (const auto at = find_keyword(create_sql, terminal, start)) end = std::min(end, *at);
  }
  std::string_view clause = create_sql.substr(start, end - start);
  while (!clause.empty() && std::isspace(static_cast<unsigned char>(clause.front()))) clause.remove_prefix(1);
  while (!clause.empty() && (std::isspace(static_cast<unsigned char>(clause.back())) || clause.back() == ';')) clause.remove_suffix(1);
  return std::string(clause);
}

std::optional<std::string> clause_arguments(std::string_view text, std::string_view keyword) {
  const View v(text);
  const std::vector<std::string_view> words = words_of(keyword);
  if (words.empty()) return std::nullopt;
  for (size_t k = 0; k < v.size(); ++k) {
    if (v.depth[k] != 0 || !v.is_word(k, words[0])) continue;
    if (!v.is_punct(k + 1, '(')) return std::nullopt;
    const size_t open = k + 1;
    for (size_t close = open + 1; close < v.size(); ++close) {
      if (v.is_punct(close, ')') && v.depth[close] == v.depth[open]) {
        return compact_spaces(text.substr(v.at(open).end, v.at(close).begin - v.at(open).end));
      }
    }
    return std::nullopt;
  }
  return std::nullopt;
}

} // namespace sql
} // namespace chdash
