#pragma once

// The parts of the formatter that its units share (format_postprocess.hpp is the entry). The formatter is one pass pipeline over text: the
// units below hold its passes, and the declarations here are what one unit needs of another. Nothing outside src/format_*.cpp includes this.
//
//   format_text        characters, whitespace, the work budget, comments, indentation
//   format_scan        brackets, the top level of a text, keywords, operators, clauses
//   format_align       passes over the lines of a layout: aliases, columns, indexes, enum types
//   format_arith       redundant parentheses, chains of operators
//   format_calls       calls laid out by the width of the line
//   format_statement   Formatter: statements, SELECT, WITH, FROM, JOIN, item lists
//   format_expression  Formatter: calls, windows, arrays, arithmetic, CASE, IN, EXISTS, conditions
//   format_ddl         Formatter: CREATE, ALTER, TTL, access control
//   format_insert      Formatter: INSERT, DELETE, KILL, OPTIMIZE
//   format_layout      Formatter: the explosion of lines that are too long

#include "format_postprocess.hpp"
#include "sql_lexer.hpp"
#include "sql_scan.hpp"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdint>
#include <initializer_list>
#include <limits>
#include <optional>
#include <string>
#include <string_view>
#include <tuple>
#include <utility>
#include <vector>

namespace chdash {
namespace fmt {

using std::optional;
using std::size_t;
using std::string;
using std::string_view;
using std::vector;

// The formatter gives up on a statement it cannot lay out in time (FormatGivesUp, caught by
// postprocess_format_query, which then returns the statement as written). Every layout pass scans
// the text with step_scan, so that is where the time is checked: some passes are quadratic in the
// nesting (a CASE inside a CASE 2000 times takes seconds), and a worker thread must not spend
// minutes on one request.
struct FormatGivesUp {};

struct FormatBudget {
  std::chrono::steady_clock::time_point deadline;
  uint64_t work = 0;        // characters scanned so far
  uint64_t next_check = 0;  // the clock is read each time `work` passes this
};

// The budget of the statement being formatted on this thread; null outside postprocess_format_query.
extern thread_local FormatBudget* t_format_budget;

constexpr auto kFormatTimeBudget = std::chrono::seconds(2);

// Counts `units` characters of scanning against the budget of this thread, reading the clock once
// every 64 Ki of them.
inline void spend_format_budget(size_t units = 1) {
  FormatBudget* budget = t_format_budget;
  if (!budget) return;
  budget->work += units;
  if (budget->work < budget->next_check) return;
  budget->next_check = budget->work + 65536;
  if (std::chrono::steady_clock::now() > budget->deadline) throw FormatGivesUp{};
}

// The state of a byte by byte pass over a statement (sql_lexer.hpp, sql::Scan): the open quote or comment and the
// depth of the brackets. Every layout pass reads the text with step_scan.
using ScanState = sql::Scan;

inline bool is_top_level(const ScanState& st) { return st.top_level(); }

// ---------------------------------------------------------------------------
// Redundant arithmetic parentheses.
//
// formatQuery parenthesizes every nested binary operator:
// `(a*w1 + b*w2) / (w1 + w2)` comes back as
// `((a * w1) + (b * w2)) / (w1 + w2)`. Parentheses never appear in the parsed
// AST, so a group can be dropped whenever operator precedence already implies
// the same tree. The decision uses only the tokens around the group and the
// operators directly inside it; anything unfamiliar keeps its parentheses.

enum class ArithTokenKind { Word, Number, Literal, Op, Open, Close, Comma, Comment, Other };

constexpr int kArithMultiplicative = 12;

// Top-level binary operators of `s` when it is a plain operator chain
// (`a * w + b / c - f(x)`): byte ranges and precedence of each operator.
// Returns false for anything else (keywords, lambdas, `||`, `?:`, casts...).
struct ArithChainOperator {
  size_t begin;
  size_t end;
  int precedence;
};

// ---------------------------------------------------------------------------
// Function-call layout by line width.
//
// The expression formatter above decides call layout without knowing the
// column its text will land on, so it explodes calls by shape (nested calls,
// lambdas, several arguments). This pass applies the width rule on the final
// text, where columns are known: a call (or array / IN list) whose one-line
// form fits on its line is joined back onto one line, outermost first, and a
// one-line call that overflows the line is exploded one argument per line.
// Both directions only move whitespace between tokens, so the parsed query is
// unchanged.

enum : unsigned char { kCallCode = 0, kCallLiteral = 1, kCallComment = 2 };

struct CallScan {
  vector<unsigned char> kind;  // per byte: code, literal/quoted name, comment
  vector<size_t> match;        // `(` / `[` in code: position of its closer
  vector<size_t> parent;       // `(` / `[` in code: innermost enclosing opener
  vector<size_t> opener;       // `)` / `]` in code: position of its opener
};

// What the bracket at `pos` opens, for the width pass: a call's argument
// list (`name(` or the `(args)` of a parametric `name(params)(`), an array
// literal, a tuple list after `IN`, or a tuple element of an array literal.
// `name_begin` receives where the call's name starts.
enum class CallOpener { None, Call, Array, InList, ArrayTuple };

// The deepest nesting of the formatting calls (a call in an argument, a subquery, a lambda body, a
// condition in parentheses: each level of the query takes one to three). Past it the statement
// comes back as it was written. A real query is rarely that deep, and every level costs stack (a
// worker thread may have only 128 KiB) and time (each level scans its whole text again).
constexpr size_t kMaxFormatDepth = 96;

// One level of the formatting calls in progress; gives up (FormatGivesUp) past kMaxFormatDepth.
class FormatDepthGuard {
 public:
  explicit FormatDepthGuard(size_t& depth) : depth_(depth) {
    if (++depth_ > kMaxFormatDepth) throw FormatGivesUp{};
    spend_format_budget();
  }
  ~FormatDepthGuard() { --depth_; }
  FormatDepthGuard(const FormatDepthGuard&) = delete;
  FormatDepthGuard& operator=(const FormatDepthGuard&) = delete;

 private:
  size_t& depth_;
};

struct Formatter {
  explicit Formatter(size_t threshold_) : threshold(threshold_) {}

  size_t threshold;
  // The nesting of the formatting calls in progress (FormatDepthGuard).
  size_t depth = 0;

  string format(string_view s);
  string format_statement(string_view s);
  string format_select_like(string_view s);
  string format_clause(string_view kw, string_view body);
  string format_from_clause(string_view body);
  string format_table_source(string_view s);
  string format_parenthesized_query(string_view s);
  string format_with_item_block(const vector<string>& items);
  string format_item_block(const vector<string>& items, bool align_alias);
  string format_simple_item_block(const vector<string>& items);
  string format_expression(string_view expr);
  string format_over_clause(string_view expr);
  string format_commented_case(string_view expr);
  vector<string> window_spec_lines(string_view inner, size_t head_size, bool* forced);
  string format_window_clause(string_view body);
  string format_join_segments(const vector<std::pair<string, string>>& joins);
  string format_function_call(string_view expr, bool force = false);
  string format_parametric_call(const string& name, string_view params_src, string_view args_part, bool force = false);
  string layout_calls_by_width(string_view text, bool allow_explode);
  vector<string> explode_overlong_line(const string& line, int depth);
  string format_arith_chain(string_view expr, bool force);
  string format_arith_operand(string_view operand, size_t block_width, bool* block);
  string format_array_literal(string_view expr);
  string format_bool_expr(string_view expr);
  string format_bool_term(string_view expr, bool in_and_chain);
  string format_exists_subquery(string_view expr);
  string format_in_subquery(string_view expr, bool break_after_in);
  string format_in_literal(string_view expr);
  string format_create_table(string_view s);
  string format_create_dictionary(string_view s);
  string format_commented_column_list(const string& head, const string& cols, const string& tail);
  string format_create_view(string_view s, bool materialized);
  string format_alter_table(string_view s);
  string format_insert_select_like(string_view s);
  string layout_insert_head(string_view target);
  string format_insert_format_clause(string_view s);
  string format_delete(string_view s);
  string format_kill(string_view s);
  string commented_operand(string_view s);
  string format_optimize_table(string_view s);
  string format_row_policy(string_view s);
  string format_settings_profile(string_view s);
  string try_format_insert_values(string_view s);
  string cleanup_surface(string_view s) const;
  string take_leading_comments(string_view s, string* leading) const;
  string join_with_keyword(const vector<string>& parts, string_view kw) const;
  string join_bool_parts(const vector<string>& parts, string_view kw) const;
  string strip_atomic_parentheses(string s) const;
  string strip_lambda_parentheses(string s) const;
  vector<std::pair<string, string>> split_joins(string_view s) const;
};

// ---- What one unit needs of another ----

// format_text.cpp
bool iequals_ascii(string_view a, string_view b);
bool starts_with_ci(string_view s, string_view prefix);
bool ends_with_ci(string_view s, string_view suffix);
bool is_ident_char(char ch);
string trim_ascii_spaces(string_view sv);
string rtrim_spaces(string_view sv);
string collapse_whitespace(string_view sv);
string normalize_newlines(string_view s);
bool ci_match_at(string_view s, size_t pos, string_view word);
void step_scan(ScanState& st, string_view s, size_t& i);
string repair_split_clause_keywords(string_view s);
string normalize_code_spacing(string_view s);
string reflow_block_comment(string_view block);
string indent_block(string_view s, int spaces);
string join_lines(const vector<string>& lines);
size_t utf8_width(string_view s);
size_t last_line_length(string_view s);
string prefix_first_line(const string& s, string_view prefix);
string indent_after_first_line(string_view s, size_t spaces);
string dedent_after_first_line(string_view s);
// format_scan.cpp
size_t find_matching_paren(string_view s, size_t open_pos);
int find_top_level_keyword(string_view s, string_view kw, size_t start = 0);
bool is_create_function(string_view text);
vector<std::pair<string, string>> split_intersect_except(string_view s);
bool previous_word_is_as(string_view s, size_t pos);
vector<std::pair<int, string>> find_select_clauses( string_view text, size_t start, const vector<string_view>& clauses );
vector<string> split_top_level(string_view s, char delim);
vector<string> split_top_level_keyword(string_view s, string_view kw);
int find_top_level_arrow(string_view s);
string expand_nested_select_head(string rendered);
string unwrap_outer_parens(string_view s);
bool looks_like_query(string_view s);
bool contains_top_level_comment(string_view s);
bool contains_select_keyword(string_view s);
bool contains_heavy_structure(string_view s);
int find_top_level_comparator(string_view s, string* op);
std::pair<string, string> split_inline_comment(string_view s);
void append_item_comma(string& item);
vector<string> line_comment_texts(string_view s);
int find_top_level_operator(string_view s, char op);
std::pair<string, string> split_leading_line_comment(string_view s);
std::pair<string, string> split_top_level_as(string_view s);
string format_alias_identifier(string_view alias);
bool query_returns_table_like_cte(string_view query);
// format_align.cpp
vector<string> split_lines_keep(string_view s);
size_t leading_space_count(string_view s);
string normalize_final_layout(string_view s, size_t width);
// format_arith.cpp
string strip_redundant_arith_parentheses(string_view s);
bool split_arith_chain(string_view s, vector<ArithChainOperator>* ops);
string hang_operator_continuations(const string& value, bool logical = false);
// format_calls.cpp
CallScan scan_call_brackets(string_view s);
CallOpener classify_call_opener(string_view s, const CallScan& scan, size_t pos, size_t* name_begin);
bool closer_starts_text_cast(string_view s, size_t close);
size_t count_call_arguments(string_view s, const CallScan& scan, size_t open, size_t close);
string collapse_fitting_calls(string_view text, size_t width, vector<size_t>* joined_rows = nullptr);
string join_fitting_arguments(string text, size_t width);
string attach_operators_to_closers(string_view text, size_t width);
string merge_joined_single_select_items(string_view text, const vector<size_t>& joined_rows, size_t width);
// format_statement.cpp
string normalize_boolean_lines(string_view s);

}  // namespace fmt
}  // namespace chdash
