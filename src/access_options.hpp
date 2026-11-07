#pragma once

// The route of the options: GET /.well-known/procurauth/resources (ProcurAuth 5.6 to 5.9). It lists the children of a node, one page at a
// time, for the form of the grants. This file holds the pure part: the parser of the query, the cursor, the page and the JSON of the
// answer. It has no HTTP server and no PDP. The handler (api_resources.cpp) gives it the candidates and a function that decides.

#include "access_resource.hpp"

#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace chdash {

// The bounds of one answer. The caller of the route accepts 50 items and 64 KiB (ProcurAuth 5.8).
constexpr size_t kOptionsMaxItems = 50;
constexpr size_t kOptionsMaxBytes = 60 * 1024;
// The most questions that one request asks the PDP (ProcurAuth 5.6). Then the answer holds the items found and a cursor.
constexpr size_t kOptionsMaxQuestions = 200;
// The longest value of q and of after, in bytes.
constexpr size_t kOptionsMaxSearchBytes = 256;
constexpr size_t kOptionsMaxCursorBytes = 512;

struct OptionsQuery {
  // The chain of the node of `parent`, from the first level below the service. It is empty without `parent`.
  std::vector<AccessNode> parent;
  std::string type;
  // The search text. It is empty without q.
  std::string q;
  size_t limit = kOptionsMaxItems;
  // The id after which the list continues (the decoded cursor). Absent on the first page.
  std::optional<std::string> after;
};

struct OptionsParse {
  bool ok = false;
  // The name of the bad parameter and the rule that it breaks. It never holds the value.
  std::string error;
  OptionsQuery query;
};

// Reads the raw query string (the text after "?", with the percent-encoding still in it). Each value is decoded one time. The sign + is a
// plus. A parameter that occurs twice, a value with a bad escape, a missing type, a limit that is not a whole number from 1, a type that
// is not a child of the type of the parent, and a bad path or cursor give ok = false. Unknown parameters are ignored.
OptionsParse access_options_parse(std::string_view raw_query);

// One %XX decoding. False for a "%" that is not followed by two hexadecimal digits.
bool access_percent_decode(std::string_view text, std::string* out);

// The cursor is the id of the last candidate that the page examined, in base64url without padding.
std::string access_options_cursor_encode(std::string_view id);
bool access_options_cursor_decode(std::string_view cursor, std::string* id);

struct OptionsCandidate {
  std::string id;
  std::string label;
};

struct OptionsItem {
  std::string id;
  std::string label;
};

// The order of the list: the id without the case of the ASCII letters, then the bytes.
bool access_options_less(const std::string& a, const std::string& b);

// The decisions for a group of ids, in the order of the ids: true when the subject can see the child. Nothing when the PDP gave no valid answer.
using OptionsDecide = std::function<std::optional<std::vector<bool>>(const std::vector<std::string>& ids)>;

struct OptionsPage {
  std::vector<OptionsItem> items;
  // The cursor of the next page. Empty on the last page (the answer then has "next": null).
  std::string next;
  // The PDP gave no valid answer: the route answers 503.
  bool failed = false;
  // The questions that the page asked.
  size_t questions = 0;
};

// The page after `query.after`. The candidates are sorted with access_options_less here; an id that is not a valid id of a node is dropped.
// The search q keeps the candidates whose id or label holds the text, without the case of the ASCII letters. Each group goes to `decide`
// with at most kOptionsMaxQuestions questions in all (`questions_per_id` for each id). The page stops at `query.limit` items (at most 50),
// at kOptionsMaxBytes of JSON and at the bound of the questions.
OptionsPage access_options_page(std::vector<OptionsCandidate> candidates, const OptionsQuery& query, size_t questions_per_id, const OptionsDecide& decide);

// {"items": [{id, label, has_children}], "next": <cursor>|null}
std::string access_options_json(const OptionsPage& page, bool has_children);

} // namespace chdash
