#include "mcp_trace.hpp"

#include "secure_random.hpp"

#include <algorithm>

namespace chdash {
namespace {

bool lower_hex(std::string_view text) {
  return std::all_of(text.begin(), text.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); });
}

bool all_zero(std::string_view text) {
  return std::all_of(text.begin(), text.end(), [](char c) { return c == '0'; });
}

std::string_view trim(std::string_view text) {
  while (!text.empty() && (text.front() == ' ' || text.front() == '\t')) text.remove_prefix(1);
  while (!text.empty() && (text.back() == ' ' || text.back() == '\t')) text.remove_suffix(1);
  return text;
}

int hex_digit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

std::string percent_decode(std::string_view text) {
  std::string out;
  out.reserve(text.size());
  for (size_t i = 0; i < text.size(); ++i) {
    if (text[i] == '%' && i + 2 < text.size()) {
      const int hi = hex_digit(text[i + 1]);
      const int lo = hex_digit(text[i + 2]);
      if (hi >= 0 && lo >= 0) {
        out.push_back(static_cast<char>(hi * 16 + lo));
        i += 2;
        continue;
      }
    }
    out.push_back(text[i]);
  }
  return out;
}

// The largest baggage that is read: W3C Baggage lets a receiver drop a header above 8192 bytes.
constexpr size_t kMaxBaggageBytes = 8192;
constexpr size_t kMaxValueBytes = 128;

} // namespace

bool mcp_parse_traceparent(std::string_view text, std::string* trace_id, std::string* span_id) {
  text = trim(text);
  // version "-" trace-id "-" parent-id "-" flags: 2 + 1 + 32 + 1 + 16 + 1 + 2 = 55 characters. A later version can add fields.
  if (text.size() < 55 || text[2] != '-' || text[35] != '-' || text[52] != '-') return false;
  const std::string_view version = text.substr(0, 2);
  const std::string_view trace = text.substr(3, 32);
  const std::string_view span = text.substr(36, 16);
  const std::string_view flags = text.substr(53, 2);
  if (!lower_hex(version) || version == "ff" || !lower_hex(trace) || !lower_hex(span) || !lower_hex(flags)) return false;
  if (version == "00" && text.size() != 55) return false;
  if (version != "00" && text.size() > 55 && text[55] != '-') return false;
  if (all_zero(trace) || all_zero(span)) return false;
  *trace_id = std::string(trace);
  *span_id = std::string(span);
  return true;
}

void mcp_parse_baggage(std::string_view text, McpTraceContext* out) {
  if (text.size() > kMaxBaggageBytes) text = text.substr(0, kMaxBaggageBytes);
  size_t start = 0;
  while (start <= text.size()) {
    size_t end = text.find(',', start);
    if (end == std::string_view::npos) end = text.size();
    std::string_view member = text.substr(start, end - start);
    // key=value;property;property: the properties are ignored.
    if (const size_t semi = member.find(';'); semi != std::string_view::npos) member = member.substr(0, semi);
    if (const size_t eq = member.find('='); eq != std::string_view::npos) {
      const std::string_view key = trim(member.substr(0, eq));
      const std::string value = mcp_log_text(percent_decode(trim(member.substr(eq + 1))), kMaxValueBytes);
      if (key == "agent.run_id") out->run_id = value;
      else if (key == "agent.caller") out->caller = value;
      else if (key == "agent.on_behalf_of") out->on_behalf_of = value;
    }
    start = end + 1;
  }
}

McpTraceContext mcp_trace_context(std::string_view meta_traceparent, std::string_view meta_baggage, bool meta_has_context,
                                  std::string_view header_traceparent, std::string_view header_baggage) {
  McpTraceContext out;
  const bool meta = meta_has_context;
  const std::string_view traceparent = meta ? meta_traceparent : header_traceparent;
  const std::string_view baggage = meta ? meta_baggage : header_baggage;
  if (traceparent.empty() && baggage.empty()) return out;
  out.source = meta ? "meta" : "headers";
  if (!traceparent.empty() && !mcp_parse_traceparent(traceparent, &out.trace_id, &out.parent_span_id)) {
    out.trace_id.clear();
    out.parent_span_id.clear();
  } else if (!traceparent.empty()) {
    // The flags are the two hexadecimal characters after the parent id (mcp_parse_traceparent checked them).
    const std::string_view flags = trim(traceparent).substr(53, 2);
    out.sampled = (hex_digit(flags[1]) & 1) != 0;
  }
  if (!baggage.empty()) mcp_parse_baggage(baggage, &out);
  return out;
}

std::string mcp_random_hex(size_t bytes) { return random_hex(bytes); }

std::string mcp_log_text(std::string_view text, size_t max_bytes) {
  std::string out;
  out.reserve(std::min(text.size(), max_bytes));
  size_t i = 0;
  while (i < text.size()) {
    const unsigned char c = static_cast<unsigned char>(text[i]);
    size_t length = 1;
    if (c >= 0xc0 && c < 0xe0) length = 2;
    else if (c >= 0xe0 && c < 0xf0) length = 3;
    else if (c >= 0xf0 && c < 0xf8) length = 4;
    if (i + length > text.size()) break;
    if (length == 1 && (c < 0x20 || c == 0x7f || c >= 0x80)) {
      ++i;  // a control byte, or a byte that does not start a sequence
      continue;
    }
    bool sequence = true;
    for (size_t k = 1; k < length; ++k) {
      const unsigned char next = static_cast<unsigned char>(text[i + k]);
      if (next < 0x80 || next >= 0xc0) sequence = false;
    }
    if (!sequence) {
      ++i;
      continue;
    }
    // U+0080 to U+009F are control characters too.
    if (length == 2 && c == 0xc2 && static_cast<unsigned char>(text[i + 1]) < 0xa0) {
      i += 2;
      continue;
    }
    if (out.size() + length > max_bytes) break;
    out.append(text.substr(i, length));
    i += length;
  }
  return out;
}

std::string mcp_comment_caller(std::string_view caller) {
  std::string out;
  for (const char c : caller.substr(0, 64)) {
    const bool kept = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-' ||
                      c == '@' || c == ':' || c == '/' || c == '+';
    out.push_back(kept ? c : '_');
  }
  return out;
}

} // namespace chdash
