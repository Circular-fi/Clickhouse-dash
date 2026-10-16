#include "logs_drain.hpp"

#include "logs_text.hpp"

#include <algorithm>
#include <cctype>
#include <utility>

namespace chdash::logs {

// Patterns use masking and a Drain port (He et al. 2017, as in HyperDX's
// common-utils/drain: depth 4, similarity 0.4, 100 children per node).

const std::string kParam = "<*>";

namespace {

bool is_hex(char c) { return std::isxdigit(static_cast<unsigned char>(c)) != 0; }
bool is_digit(char c) { return c >= '0' && c <= '9'; }
bool is_word(char c) { return std::isalnum(static_cast<unsigned char>(c)) != 0 || c == '_'; }

}  // namespace

// Replace the variable parts with <*>: quoted strings, UUIDs, long hex ids,
// IPv4 addresses and numbers that are not attached to a word. A version such as v1 stays.
std::string mask_body(std::string_view body) {
  std::string out;
  out.reserve(std::min<size_t>(body.size(), 2048));
  const size_t n = std::min<size_t>(body.size(), 2048);
  size_t i = 0;
  const auto emit_param = [&]() {
    if (out.size() < kParam.size() || out.compare(out.size() - kParam.size(), kParam.size(), kParam) != 0) out += kParam;
  };
  while (i < n) {
    const char c = body[i];
    if ((c == '"' || c == '\'') && (i == 0 || !is_word(body[i - 1]))) {
      const size_t close = body.find(c, i + 1);
      if (close != std::string_view::npos && close < n && close - i <= 256) {
        emit_param();
        i = close + 1;
        continue;
      }
    }
    if (is_hex(c) && (i == 0 || !is_word(body[i - 1]))) {
      // A run of hex digits and dashes (UUIDs, trace ids, traceparent parts).
      size_t j = i;
      size_t hex_count = 0;
      bool digit = false, dash = false;
      while (j < n && (is_hex(body[j]) || body[j] == '-')) {
        if (body[j] == '-') dash = true;
        else ++hex_count;
        if (is_digit(body[j])) digit = true;
        ++j;
      }
      if (hex_count >= 8 && digit && (j == n || !is_word(body[j]))) {
        (void)dash;
        emit_param();
        i = j;
        continue;
      }
    }
    if (is_digit(c) && (i == 0 || !std::isalpha(static_cast<unsigned char>(body[i - 1])))) {
      size_t j = i;
      while (j < n && (is_digit(body[j]) || (body[j] == '.' && j + 1 < n && is_digit(body[j + 1])))) ++j;
      if (j == n || !std::isalpha(static_cast<unsigned char>(body[j]))) {
        emit_param();
        i = j;
        continue;
      }
      out.append(body.substr(i, j - i));
      i = j;
      continue;
    }
    out.push_back(c);
    ++i;
  }
  return out;
}

std::vector<std::string> whitespace_tokens(const std::string& text) {
  std::vector<std::string> out;
  std::string current;
  for (char c : text) {
    if (std::isspace(static_cast<unsigned char>(c))) {
      if (!current.empty()) out.push_back(std::move(current));
      current.clear();
    } else {
      current.push_back(c);
    }
  }
  if (!current.empty()) out.push_back(std::move(current));
  if (out.size() > 64) out.resize(64);
  return out;
}

namespace {

bool has_digit(const std::string& token) {
  return std::any_of(token.begin(), token.end(), is_digit);
}

}  // namespace

size_t Drain::add(const std::vector<std::string>& tokens) {
  DrainNode* leaf = descend(tokens, false);
  if (leaf) {
    const size_t match = best_match(*leaf, tokens, leaf->clusters.size() >= kMaxClustersPerLeaf);
    if (match != SIZE_MAX) {
      Cluster& c = clusters_[match];
      for (size_t i = 0; i < c.tokens.size(); ++i) {
        if (c.tokens[i] != tokens[i]) c.tokens[i] = kParam;
      }
      ++c.size;
      return match;
    }
  }
  clusters_.push_back(Cluster{tokens, 1, {}, {}, {}, {0, 0, 0, 0}});
  const size_t id = clusters_.size() - 1;
  descend(tokens, true)->clusters.push_back(id);
  return id;
}

// Root -> token count -> first (depth - 2) tokens -> leaf cluster list.
DrainNode* Drain::descend(const std::vector<std::string>& tokens, bool create) {
  const std::string length_key = std::to_string(tokens.size());
  auto it = root_.children.find(length_key);
  if (it == root_.children.end()) {
    if (!create) return nullptr;
    it = root_.children.emplace(length_key, std::make_unique<DrainNode>()).first;
  }
  DrainNode* node = it->second.get();
  int depth = 1;
  for (const auto& token : tokens) {
    if (depth >= kDepth - 2 || depth >= static_cast<int>(tokens.size())) break;
    auto child = node->children.find(token);
    if (child != node->children.end()) {
      node = child->second.get();
    } else if (!create) {
      auto wildcard = node->children.find(kParam);
      if (wildcard == node->children.end()) return nullptr;
      node = wildcard->second.get();
    } else {
      const bool wildcard_exists = node->children.count(kParam) > 0;
      std::string key = token;
      if (has_digit(token) || token == kParam) key = kParam;
      else if (wildcard_exists ? node->children.size() >= kMaxChildren : node->children.size() + 1 >= kMaxChildren) key = kParam;
      auto& slot = node->children[key];
      if (!slot) slot = std::make_unique<DrainNode>();
      node = slot.get();
    }
    ++depth;
  }
  return node;
}

size_t Drain::best_match(const DrainNode& leaf, const std::vector<std::string>& tokens, bool force) const {
  double best_similarity = -1;
  int best_params = -1;
  size_t best = SIZE_MAX;
  for (size_t id : leaf.clusters) {
    const Cluster& c = clusters_[id];
    if (c.tokens.size() != tokens.size()) continue;
    size_t same = 0;
    int params = 0;
    for (size_t i = 0; i < tokens.size(); ++i) {
      if (c.tokens[i] == kParam) ++params;
      else if (c.tokens[i] == tokens[i]) ++same;
    }
    const double similarity = tokens.empty() ? 1.0 : static_cast<double>(same) / static_cast<double>(tokens.size());
    if (similarity > best_similarity || (similarity == best_similarity && params > best_params)) {
      best_similarity = similarity;
      best_params = params;
      best = id;
    }
  }
  return best_similarity >= kSimilarity || force ? best : SIZE_MAX;
}

// The constant words of a template as a token search: "<*>" parts dropped,
// "key=user:<*>" kept as the term "key=user:".
std::string pattern_search_text(const std::vector<std::string>& tokens) {
  std::string out;
  size_t terms = 0;
  for (const auto& token : tokens) {
    size_t start = 0;
    while (start <= token.size() && terms < kMaxTextTerms) {
      const size_t at = token.find(kParam, start);
      const std::string piece = token.substr(start, at == std::string::npos ? std::string::npos : at - start);
      if (!split_tokens(piece).empty()) {
        const bool needs_quotes = piece.find('"') == std::string::npos && piece.front() == '-';
        if (!out.empty()) out.push_back(' ');
        out += needs_quotes ? "\"" + piece + "\"" : piece;
        ++terms;
      }
      if (at == std::string::npos) break;
      start = at + kParam.size();
    }
  }
  return out;
}

int severity_index(int number) {
  if (number >= 17) return 0;
  if (number >= 13) return 1;
  if (number >= 9) return 2;
  return 3;
}

}  // namespace chdash::logs
