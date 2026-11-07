#include "access_options.hpp"

#include "access_actions.hpp"
#include "json_text.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <cctype>

namespace chdash {
namespace {

int hex_value(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;
}

char ascii_lower(char c) { return c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c; }

std::string lower(std::string_view text) {
  std::string out(text);
  for (char& c : out) c = ascii_lower(c);
  return out;
}

const AccessResourceType* type_named(std::string_view name) {
  for (const AccessResourceType& type : access_resource_types()) {
    if (name == type.name) return &type;
  }
  return nullptr;
}

OptionsParse refuse(const std::string& error) {
  OptionsParse out;
  out.error = error;
  return out;
}

constexpr char kBase64Url[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

} // namespace

bool access_percent_decode(std::string_view text, std::string* out) {
  out->clear();
  out->reserve(text.size());
  for (size_t at = 0; at < text.size(); ++at) {
    if (text[at] != '%') {
      out->push_back(text[at]);
      continue;
    }
    if (at + 2 >= text.size()) return false;
    const int high = hex_value(text[at + 1]);
    const int low = hex_value(text[at + 2]);
    if (high < 0 || low < 0) return false;
    out->push_back(static_cast<char>(high * 16 + low));
    at += 2;
  }
  return true;
}

std::string access_options_cursor_encode(std::string_view id) {
  std::string out;
  size_t at = 0;
  for (; at + 2 < id.size(); at += 3) {
    const unsigned v = (static_cast<unsigned char>(id[at]) << 16) | (static_cast<unsigned char>(id[at + 1]) << 8) | static_cast<unsigned char>(id[at + 2]);
    out.push_back(kBase64Url[(v >> 18) & 63]);
    out.push_back(kBase64Url[(v >> 12) & 63]);
    out.push_back(kBase64Url[(v >> 6) & 63]);
    out.push_back(kBase64Url[v & 63]);
  }
  if (id.size() - at == 1) {
    const unsigned v = static_cast<unsigned char>(id[at]) << 16;
    out.push_back(kBase64Url[(v >> 18) & 63]);
    out.push_back(kBase64Url[(v >> 12) & 63]);
  } else if (id.size() - at == 2) {
    const unsigned v = (static_cast<unsigned char>(id[at]) << 16) | (static_cast<unsigned char>(id[at + 1]) << 8);
    out.push_back(kBase64Url[(v >> 18) & 63]);
    out.push_back(kBase64Url[(v >> 12) & 63]);
    out.push_back(kBase64Url[(v >> 6) & 63]);
  }
  return out;
}

bool access_options_cursor_decode(std::string_view cursor, std::string* id) {
  id->clear();
  if (cursor.empty() || cursor.size() % 4 == 1) return false;
  unsigned bits = 0;
  int count = 0;
  for (const char c : cursor) {
    const char* at = std::find(std::begin(kBase64Url), std::end(kBase64Url) - 1, c);
    if (at == std::end(kBase64Url) - 1) return false;
    bits = (bits << 6) | static_cast<unsigned>(at - kBase64Url);
    count += 6;
    if (count >= 8) {
      count -= 8;
      id->push_back(static_cast<char>((bits >> count) & 0xFF));
    }
  }
  // The unused bits are zero: only one text gives one id.
  if (count > 0 && (bits & ((1u << count) - 1)) != 0) return false;
  return access_valid_id(*id) && access_options_cursor_encode(*id) == cursor;
}

OptionsParse access_options_parse(std::string_view raw) {
  std::optional<std::string> parent_text, type_text, q_text, limit_text, after_text;
  size_t start = 0;
  while (start <= raw.size()) {
    size_t end = raw.find('&', start);
    if (end == std::string_view::npos) end = raw.size();
    const std::string_view piece = raw.substr(start, end - start);
    start = end + 1;
    if (piece.empty()) continue;
    const size_t equal = piece.find('=');
    std::string name;
    if (!access_percent_decode(piece.substr(0, equal), &name)) continue;
    std::optional<std::string>* slot = name == "parent" ? &parent_text : name == "type" ? &type_text : name == "q" ? &q_text
                                       : name == "limit" ? &limit_text : name == "after" ? &after_text : nullptr;
    if (!slot) continue;
    if (slot->has_value()) return refuse("The parameter " + name + " occurs more than one time.");
    std::string value;
    if (equal != std::string_view::npos && !access_percent_decode(piece.substr(equal + 1), &value)) {
      return refuse("The parameter " + name + " has a bad percent-encoding.");
    }
    *slot = std::move(value);
  }

  OptionsParse out;
  OptionsQuery& query = out.query;
  if (!type_text || type_text->empty()) return refuse("The parameter type is required.");
  query.type = *type_text;

  std::string parent_type = "service";
  if (parent_text) {
    if (parent_text->empty()) return refuse("The parameter parent is empty.");
    size_t from = 0;
    while (from <= parent_text->size()) {
      size_t slash = parent_text->find('/', from);
      if (slash == std::string::npos) slash = parent_text->size();
      const std::string segment = parent_text->substr(from, slash - from);
      from = slash + 1;
      const size_t colon = segment.find(':');
      if (colon == std::string::npos) return refuse("The parameter parent is not a path of segments type:id.");
      const AccessResourceType* type = type_named(std::string_view(segment).substr(0, colon));
      if (!type || parent_type != type->parent) return refuse("The parameter parent holds a type that does not follow the tree.");
      std::string id;
      if (!access_percent_decode(std::string_view(segment).substr(colon + 1), &id) || !access_valid_id(id)) {
        return refuse("The parameter parent holds a bad id.");
      }
      query.parent.push_back(AccessNode{type->name, std::move(id)});
      parent_type = type->name;
    }
  }

  const AccessResourceType* type = type_named(query.type);
  if (!type || parent_type != type->parent) return refuse("The parameter type is not a child of the type of the parent.");

  if (q_text) {
    if (q_text->size() > kOptionsMaxSearchBytes || !is_valid_utf8(*q_text)) {
      return refuse("The parameter q must be valid UTF-8 of at most 256 bytes.");
    }
    query.q = *q_text;
  }
  if (limit_text) {
    const std::string& text = *limit_text;
    if (text.empty() || text.size() > 9 || !std::all_of(text.begin(), text.end(), [](char c) { return c >= '0' && c <= '9'; }) ||
        std::stoul(text) < 1) {
      return refuse("The parameter limit must be a whole number from 1.");
    }
    query.limit = std::min<size_t>(std::stoul(text), kOptionsMaxItems);
  }
  if (after_text) {
    std::string id;
    if (after_text->size() > kOptionsMaxCursorBytes || !access_options_cursor_decode(*after_text, &id)) {
      return refuse("The parameter after is not a cursor of this route.");
    }
    query.after = std::move(id);
  }
  out.ok = true;
  return out;
}

bool access_options_less(const std::string& a, const std::string& b) {
  const size_t n = std::min(a.size(), b.size());
  for (size_t i = 0; i < n; ++i) {
    const char x = ascii_lower(a[i]);
    const char y = ascii_lower(b[i]);
    if (x != y) return static_cast<unsigned char>(x) < static_cast<unsigned char>(y);
  }
  if (a.size() != b.size()) return a.size() < b.size();
  return a < b;
}

namespace {

// The size of the JSON of one item, with a margin for the escapes.
size_t item_bytes(const OptionsItem& item) { return 48 + 6 * (item.id.size() + item.label.size()); }

} // namespace

OptionsPage access_options_page(std::vector<OptionsCandidate> candidates, const OptionsQuery& query, size_t questions_per_id, const OptionsDecide& decide) {
  OptionsPage page;
  candidates.erase(std::remove_if(candidates.begin(), candidates.end(), [](const OptionsCandidate& c) { return !access_valid_id(c.id); }),
                   candidates.end());
  std::sort(candidates.begin(), candidates.end(), [](const OptionsCandidate& a, const OptionsCandidate& b) { return access_options_less(a.id, b.id); });
  candidates.erase(std::unique(candidates.begin(), candidates.end(), [](const OptionsCandidate& a, const OptionsCandidate& b) { return a.id == b.id; }),
                   candidates.end());

  const std::string needle = lower(query.q);
  std::vector<OptionsCandidate> list;
  for (auto& candidate : candidates) {
    if (query.after && !access_options_less(*query.after, candidate.id)) continue;
    if (!needle.empty() && lower(candidate.id).find(needle) == std::string::npos && lower(candidate.label).find(needle) == std::string::npos) continue;
    list.push_back(std::move(candidate));
  }

  const size_t limit = std::max<size_t>(1, std::min(query.limit, kOptionsMaxItems));
  const size_t per_id = std::max<size_t>(1, questions_per_id);
  size_t bytes = 32;
  size_t at = 0;
  size_t last_examined = 0;
  bool examined_any = false;
  bool full = false;
  while (at < list.size() && page.items.size() < limit && !full) {
    const size_t room = (kOptionsMaxQuestions - page.questions) / per_id;
    if (room == 0) break;
    const size_t group = std::min({room, limit - page.items.size(), list.size() - at});
    std::vector<std::string> ids;
    ids.reserve(group);
    for (size_t i = 0; i < group; ++i) ids.push_back(list[at + i].id);
    const std::optional<std::vector<bool>> visible = decide(ids);
    page.questions += group * per_id;
    if (!visible || visible->size() != group) {
      page.failed = true;
      page.items.clear();
      page.next.clear();
      return page;
    }
    for (size_t i = 0; i < group; ++i) {
      if ((*visible)[i]) {
        OptionsItem item{list[at + i].id, access_cut_label(list[at + i].label)};
        if (item.label.empty()) item.label = access_cut_label(item.id);
        if (bytes + item_bytes(item) > kOptionsMaxBytes && !page.items.empty()) {
          full = true;
          break;
        }
        bytes += item_bytes(item);
        page.items.push_back(std::move(item));
      }
      last_examined = at + i;
      examined_any = true;
    }
    at += group;
    if (full) break;
  }
  const size_t examined_end = examined_any ? last_examined + 1 : 0;
  if (examined_end < list.size() && examined_any) page.next = access_options_cursor_encode(list[last_examined].id);
  // No item was examined (no room): the page cannot move. The cursor stays at its place.
  if (!examined_any && !list.empty() && query.after) page.next = access_options_cursor_encode(*query.after);
  return page;
}

std::string access_options_json(const OptionsPage& page, bool has_children) {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("items");
  w.StartArray();
  for (const OptionsItem& item : page.items) {
    w.StartObject();
    w.Key("id");
    write_json_text(w, item.id);
    w.Key("label");
    write_json_text(w, item.label);
    w.Key("has_children");
    w.Bool(has_children);
    w.EndObject();
  }
  w.EndArray();
  w.Key("next");
  if (page.next.empty()) w.Null();
  else write_json_text(w, page.next);
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

} // namespace chdash
