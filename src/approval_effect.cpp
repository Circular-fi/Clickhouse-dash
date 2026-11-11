#include "approval_effect.hpp"

#include "jwt.hpp"
#include "json_text.hpp"

#include <algorithm>
#include <cstdint>
#include <memory>
#include <utility>
#include <vector>

namespace chdash {
namespace {

constexpr int kMaxDepth = 64;
constexpr uint64_t kMaxInteger = 9007199254740991ULL;  // 2^53 - 1

// One value of the text, kept as what the canonical form needs.
struct Node {
  enum class Kind { Object, Array, String, Number, Literal } kind = Kind::Literal;
  std::string text;  // String: the decoded text. Number and Literal: the text of the token.
  std::vector<std::pair<std::string, Node>> members;  // Object, sorted by the UTF-16 code units of the names
  std::vector<Node> items;                            // Array
};

struct Failure {
  std::string message;
};

void append_utf8(std::string* out, uint32_t cp) {
  if (cp < 0x80) {
    out->push_back(static_cast<char>(cp));
  } else if (cp < 0x800) {
    out->push_back(static_cast<char>(0xC0 | (cp >> 6)));
    out->push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else if (cp < 0x10000) {
    out->push_back(static_cast<char>(0xE0 | (cp >> 12)));
    out->push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out->push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else {
    out->push_back(static_cast<char>(0xF0 | (cp >> 18)));
    out->push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
    out->push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out->push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  }
}

// The UTF-16 code units of a valid UTF-8 text (RFC 8785, 3.2.3: the members sort by these units).
std::vector<uint16_t> utf16_of(std::string_view text) {
  std::vector<uint16_t> out;
  out.reserve(text.size());
  for (size_t i = 0; i < text.size();) {
    const size_t n = utf8_sequence_length(text, i);
    uint32_t cp = 0;
    const auto at = [&](size_t k) { return static_cast<uint32_t>(static_cast<unsigned char>(text[i + k])); };
    if (n == 1) cp = at(0);
    else if (n == 2) cp = ((at(0) & 0x1F) << 6) | (at(1) & 0x3F);
    else if (n == 3) cp = ((at(0) & 0x0F) << 12) | ((at(1) & 0x3F) << 6) | (at(2) & 0x3F);
    else cp = ((at(0) & 0x07) << 18) | ((at(1) & 0x3F) << 12) | ((at(2) & 0x3F) << 6) | (at(3) & 0x3F);
    if (cp >= 0x10000) {
      cp -= 0x10000;
      out.push_back(static_cast<uint16_t>(0xD800 + (cp >> 10)));
      out.push_back(static_cast<uint16_t>(0xDC00 + (cp & 0x3FF)));
    } else {
      out.push_back(static_cast<uint16_t>(cp));
    }
    i += n == 0 ? 1 : n;
  }
  return out;
}

class Parser {
 public:
  explicit Parser(std::string_view text) : text_(text) {}

  bool parse(Node* out, Failure* failure) {
    failure_ = failure;
    skip_space();
    if (!value(out, 0)) return false;
    skip_space();
    if (pos_ != text_.size()) return fail("the text has more than one value");
    return true;
  }

 private:
  bool fail(const std::string& message) {
    if (failure_->message.empty()) failure_->message = message + " (byte " + std::to_string(pos_) + ")";
    return false;
  }

  void skip_space() {
    while (pos_ < text_.size() && (text_[pos_] == ' ' || text_[pos_] == '\t' || text_[pos_] == '\n' || text_[pos_] == '\r')) ++pos_;
  }

  bool literal(const char* word, Node* out) {
    const std::string_view w(word);
    if (text_.substr(pos_, w.size()) != w) return fail("the text has a word that is not true, false or null");
    out->kind = Node::Kind::Literal;
    out->text = std::string(w);
    pos_ += w.size();
    return true;
  }

  // ProcurAuth 17.3: an integer from -(2^53-1) to 2^53-1, written as 0 or as digits with no zero at the start. No fraction, no exponent, no -0.
  bool number(Node* out) {
    const size_t start = pos_;
    bool negative = false;
    if (text_[pos_] == '-') {
      negative = true;
      ++pos_;
    }
    if (pos_ >= text_.size() || text_[pos_] < '0' || text_[pos_] > '9') return fail("a number has no digit");
    const size_t digits = pos_;
    if (text_[pos_] == '0') {
      ++pos_;
      if (pos_ < text_.size() && text_[pos_] >= '0' && text_[pos_] <= '9') return fail("a number has a zero at the start");
    } else {
      while (pos_ < text_.size() && text_[pos_] >= '0' && text_[pos_] <= '9') ++pos_;
    }
    if (pos_ < text_.size() && (text_[pos_] == '.' || text_[pos_] == 'e' || text_[pos_] == 'E')) {
      return fail("a number is a float: only integers are valid");
    }
    const std::string_view digit_text = text_.substr(digits, pos_ - digits);
    if (negative && digit_text == "0") return fail("the number -0 is not valid");
    if (digit_text.size() > 16) return fail("an integer is above 2^53-1");
    uint64_t value = 0;
    for (const char c : digit_text) value = value * 10 + static_cast<uint64_t>(c - '0');
    if (value > kMaxInteger) return fail("an integer is above 2^53-1");
    out->kind = Node::Kind::Number;
    out->text = std::string(text_.substr(start, pos_ - start));
    return true;
  }

  bool hex4(uint32_t* out) {
    if (pos_ + 4 > text_.size()) return fail("a \\u escape is cut");
    uint32_t value = 0;
    for (int k = 0; k < 4; ++k) {
      const char c = text_[pos_ + static_cast<size_t>(k)];
      uint32_t digit = 0;
      if (c >= '0' && c <= '9') digit = static_cast<uint32_t>(c - '0');
      else if (c >= 'a' && c <= 'f') digit = static_cast<uint32_t>(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F') digit = static_cast<uint32_t>(c - 'A' + 10);
      else return fail("a \\u escape has a character that is not a hexadecimal digit");
      value = value * 16 + digit;
    }
    pos_ += 4;
    *out = value;
    return true;
  }

  bool string_text(std::string* out) {
    ++pos_;  // the opening quote
    std::string text;
    while (true) {
      if (pos_ >= text_.size()) return fail("a string has no end");
      const unsigned char c = static_cast<unsigned char>(text_[pos_]);
      if (c == '"') {
        ++pos_;
        break;
      }
      if (c < 0x20) return fail("a string has a control character that is not escaped");
      if (c == '\\') {
        ++pos_;
        if (pos_ >= text_.size()) return fail("a string has no end");
        const char e = text_[pos_++];
        switch (e) {
          case '"': text.push_back('"'); break;
          case '\\': text.push_back('\\'); break;
          case '/': text.push_back('/'); break;
          case 'b': text.push_back('\b'); break;
          case 'f': text.push_back('\f'); break;
          case 'n': text.push_back('\n'); break;
          case 'r': text.push_back('\r'); break;
          case 't': text.push_back('\t'); break;
          case 'u': {
            uint32_t cp = 0;
            if (!hex4(&cp)) return false;
            if (cp >= 0xD800 && cp <= 0xDBFF) {
              // A high surrogate needs the low surrogate that follows it.
              if (text_.substr(pos_, 2) != "\\u") return fail("a string has an unpaired surrogate");
              pos_ += 2;
              uint32_t low = 0;
              if (!hex4(&low)) return false;
              if (low < 0xDC00 || low > 0xDFFF) return fail("a string has an unpaired surrogate");
              cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
            } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
              return fail("a string has an unpaired surrogate");
            }
            append_utf8(&text, cp);
            break;
          }
          default: return fail("a string has an escape that JSON does not have");
        }
        continue;
      }
      const size_t n = utf8_sequence_length(text_, pos_);
      if (n == 0) return fail("a string has bytes that are not UTF-8");
      text.append(text_.data() + pos_, n);
      pos_ += n;
    }
    *out = std::move(text);
    return true;
  }

  bool value(Node* out, int depth) {
    if (depth > kMaxDepth) return fail("the text has more than 64 levels");
    if (pos_ >= text_.size()) return fail("the text ends where a value must be");
    const char c = text_[pos_];
    if (c == '{') return object(out, depth);
    if (c == '[') return array(out, depth);
    if (c == '"') {
      out->kind = Node::Kind::String;
      return string_text(&out->text);
    }
    if (c == 't') return literal("true", out);
    if (c == 'f') return literal("false", out);
    if (c == 'n') return literal("null", out);
    if (c == '-' || (c >= '0' && c <= '9')) return number(out);
    return fail("the text has a character that starts no value");
  }

  bool array(Node* out, int depth) {
    out->kind = Node::Kind::Array;
    ++pos_;
    skip_space();
    if (pos_ < text_.size() && text_[pos_] == ']') {
      ++pos_;
      return true;
    }
    while (true) {
      skip_space();
      Node item;
      if (!value(&item, depth + 1)) return false;
      out->items.push_back(std::move(item));
      skip_space();
      if (pos_ >= text_.size()) return fail("an array has no end");
      if (text_[pos_] == ',') {
        ++pos_;
        continue;
      }
      if (text_[pos_] == ']') {
        ++pos_;
        return true;
      }
      return fail("an array has a character that is not , or ]");
    }
  }

  bool object(Node* out, int depth) {
    out->kind = Node::Kind::Object;
    ++pos_;
    skip_space();
    if (pos_ < text_.size() && text_[pos_] == '}') {
      ++pos_;
      return true;
    }
    while (true) {
      skip_space();
      if (pos_ >= text_.size() || text_[pos_] != '"') return fail("an object has a name that is not a string");
      std::string name;
      if (!string_text(&name)) return false;
      skip_space();
      if (pos_ >= text_.size() || text_[pos_] != ':') return fail("an object has a name with no :");
      ++pos_;
      skip_space();
      Node member;
      if (!value(&member, depth + 1)) return false;
      out->members.emplace_back(std::move(name), std::move(member));
      skip_space();
      if (pos_ >= text_.size()) return fail("an object has no end");
      if (text_[pos_] == ',') {
        ++pos_;
        continue;
      }
      if (text_[pos_] == '}') {
        ++pos_;
        break;
      }
      return fail("an object has a character that is not , or }");
    }
    // RFC 8785, 3.2.3: sort by the UTF-16 code units of the names. A name that occurs two times makes the text not valid (ProcurAuth 17.3).
    std::vector<std::pair<std::vector<uint16_t>, size_t>> order;
    order.reserve(out->members.size());
    for (size_t i = 0; i < out->members.size(); ++i) order.emplace_back(utf16_of(out->members[i].first), i);
    std::sort(order.begin(), order.end());
    for (size_t i = 1; i < order.size(); ++i) {
      if (order[i].first == order[i - 1].first) return fail("an object has a name two times");
    }
    std::vector<std::pair<std::string, Node>> sorted;
    sorted.reserve(out->members.size());
    for (const auto& entry : order) sorted.push_back(std::move(out->members[entry.second]));
    out->members = std::move(sorted);
    return true;
  }

  std::string_view text_;
  size_t pos_ = 0;
  Failure* failure_ = nullptr;
};

// A string as JCS writes it (RFC 8785, 3.2.2.2): the short escapes, \u00xx in lower case for the other characters below U+0020, and
// every other character as it is.
void write_string(std::string* out, std::string_view text) {
  static constexpr char kHex[] = "0123456789abcdef";
  out->push_back('"');
  for (const char raw : text) {
    const unsigned char c = static_cast<unsigned char>(raw);
    switch (c) {
      case '"': out->append("\\\""); break;
      case '\\': out->append("\\\\"); break;
      case '\b': out->append("\\b"); break;
      case '\f': out->append("\\f"); break;
      case '\n': out->append("\\n"); break;
      case '\r': out->append("\\r"); break;
      case '\t': out->append("\\t"); break;
      default:
        if (c < 0x20) {
          out->append("\\u00");
          out->push_back(kHex[c >> 4]);
          out->push_back(kHex[c & 0x0F]);
        } else {
          out->push_back(raw);
        }
    }
  }
  out->push_back('"');
}

void write_node(std::string* out, const Node& node) {
  switch (node.kind) {
    case Node::Kind::String: write_string(out, node.text); break;
    case Node::Kind::Number:
    case Node::Kind::Literal: out->append(node.text); break;
    case Node::Kind::Array: {
      out->push_back('[');
      for (size_t i = 0; i < node.items.size(); ++i) {
        if (i) out->push_back(',');
        write_node(out, node.items[i]);
      }
      out->push_back(']');
      break;
    }
    case Node::Kind::Object: {
      out->push_back('{');
      for (size_t i = 0; i < node.members.size(); ++i) {
        if (i) out->push_back(',');
        write_string(out, node.members[i].first);
        out->push_back(':');
        write_node(out, node.members[i].second);
      }
      out->push_back('}');
      break;
    }
  }
}

bool canonical_of(std::string_view json, bool object_only, std::string* out, std::string* error) {
  Node root;
  Failure failure;
  if (!Parser(json).parse(&root, &failure)) {
    if (error) *error = failure.message;
    return false;
  }
  if (object_only && root.kind != Node::Kind::Object) {
    if (error) *error = "the text is not a JSON object";
    return false;
  }
  std::string text;
  write_node(&text, root);
  *out = std::move(text);
  return true;
}

} // namespace

bool jcs_canonicalize(std::string_view json, std::string* out, std::string* error) { return canonical_of(json, false, out, error); }

bool jcs_canonicalize_object(std::string_view json, std::string* out, std::string* error) { return canonical_of(json, true, out, error); }

std::string approval_resource_text(std::string_view path) {
  // "service:<id>" is the first segment. The id is percent-encoded, so it holds no "/".
  const size_t slash = path.find('/');
  if (slash == std::string_view::npos) return std::string();
  return std::string(path.substr(slash + 1));
}

bool approval_effect_input(std::string_view service, std::string_view action, std::string_view resource, std::string_view op_json,
                           std::string* canonical, std::string* error) {
  for (const std::string_view text : {service, action, resource}) {
    if (!is_valid_utf8(text)) {
      if (error) *error = "a text of the effect is not UTF-8";
      return false;
    }
  }
  std::string op;
  if (!jcs_canonicalize_object(op_json, &op, error)) return false;
  // The members of the input sort by their names: action, op, resource, service, v.
  std::string text = "{\"action\":";
  write_string(&text, action);
  text += ",\"op\":";
  text += op;
  text += ",\"resource\":";
  write_string(&text, resource);
  text += ",\"service\":";
  write_string(&text, service);
  text += ",\"v\":1}";
  *canonical = std::move(text);
  return true;
}

bool approval_effect(std::string_view service, std::string_view action, std::string_view resource, std::string_view op_json,
                     std::string* effect, std::string* canonical_op, std::string* error) {
  std::string input;
  if (!approval_effect_input(service, action, resource, op_json, &input, error)) return false;
  if (canonical_op) {
    // The op is the text between "op": and ,"resource": of the input: canonicalize it again, to keep one source for it.
    std::string op;
    if (!jcs_canonicalize_object(op_json, &op, nullptr)) return false;
    *canonical_op = std::move(op);
  }
  *effect = "sha256:" + sha256_hex(input);
  return true;
}

} // namespace chdash
