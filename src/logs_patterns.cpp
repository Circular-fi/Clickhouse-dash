#include "logs_patterns.hpp"

#include "logs_filters.hpp"

#include <algorithm>
#include <cmath>
#include <map>

namespace chdash {
namespace logs {

MinedPatterns mine_patterns(const std::vector<SampleRow>& sample, int64_t start_ms, int64_t span_ms, int sparkline_buckets, size_t max_patterns,
                            uint64_t total, const std::function<bool()>& out_of_time) {
  MinedPatterns out;
  Drain drain;
  size_t mined = 0;
  for (const auto& row : sample) {
    if ((mined & 255) == 0 && mined > 0 && out_of_time()) {
      out.partial = true;
      break;
    }
    ++mined;
    const size_t id = drain.add(whitespace_tokens(mask_body(row.body)));
    Cluster& c = drain.clusters()[id];
    if (c.sample.empty()) c.sample = row.body;
    if (c.buckets.empty()) c.buckets.assign(static_cast<size_t>(sparkline_buckets), 0);
    const int64_t offset = std::min<int64_t>(span_ms - 1, std::max<int64_t>(0, row.ts_ms - start_ms));
    ++c.buckets[static_cast<size_t>(offset * sparkline_buckets / span_ms)];
    ++c.services[row.service];
    ++c.severity[severity_index(row.severity)];
  }
  // Templates that converged to the same text are one pattern.
  struct Merged {
    std::string text;
    Cluster* cluster;
    size_t size;
    std::vector<uint32_t> buckets;
  };
  std::map<std::string, size_t> by_text;
  std::vector<Merged> merged;
  for (auto& c : drain.clusters()) {
    std::string text;
    for (size_t i = 0; i < c.tokens.size(); ++i) text += (i ? " " : "") + c.tokens[i];
    const auto it = by_text.find(text);
    if (it == by_text.end()) {
      by_text[text] = merged.size();
      merged.push_back(Merged{text, &c, c.size, c.buckets});
    } else {
      Merged& p = merged[it->second];
      p.size += c.size;
      for (size_t i = 0; i < p.buckets.size() && i < c.buckets.size(); ++i) p.buckets[i] += c.buckets[i];
      for (const auto& [service, n] : c.services) p.cluster->services[service] += n;
      for (int k = 0; k < 4; ++k) p.cluster->severity[k] += c.severity[k];
    }
  }
  std::sort(merged.begin(), merged.end(), [](const Merged& a, const Merged& b) { return a.size != b.size ? a.size > b.size : a.text < b.text; });
  out.pattern_count = merged.size();
  if (merged.size() > max_patterns) merged.resize(max_patterns);
  out.mined = mined;
  out.scale = mined == 0 ? 0.0 : static_cast<double>(total) / static_cast<double>(mined);

  for (const auto& p : merged) {
    Pattern pattern;
    pattern.text = p.text;
    pattern.sample_count = p.size;
    pattern.count = static_cast<uint64_t>(std::llround(static_cast<double>(p.size) * out.scale));
    pattern.share = mined == 0 ? 0.0 : static_cast<double>(p.size) / static_cast<double>(mined);
    pattern.noisy = pattern.share > 0.10;
    pattern.sample = p.cluster->sample;
    pattern.search = pattern_search_text(p.cluster->tokens);
    size_t top_n = 0;
    for (const auto& [service, n] : p.cluster->services) {
      if (n > top_n) {
        top_n = n;
        pattern.service = service;
      }
    }
    pattern.service_count = p.cluster->services.size();
    int top_severity = 3;
    for (int k = 0; k < 4; ++k) {
      if (p.cluster->severity[k] > p.cluster->severity[top_severity]) top_severity = k;
    }
    pattern.severity = kSeverityClasses[top_severity].name;
    for (uint32_t n : p.buckets) pattern.sparkline.push_back(static_cast<uint64_t>(std::llround(n * out.scale)));
    out.patterns.push_back(std::move(pattern));
  }
  return out;
}

}  // namespace logs
}  // namespace chdash
