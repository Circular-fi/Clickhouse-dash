#pragma once

// The patterns of a sample of log messages: each message is masked and added to a Drain tree (logs_drain.hpp), the templates that
// converged to the same text are one pattern, and the patterns are ranked by size. A pure function: the clock is the caller's, given as the
// question "is the time spent" that the mining asks every 256 messages.

#include "logs_drain.hpp"

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace chdash {
namespace logs {

struct SampleRow {
  int64_t ts_ms = 0;
  int severity = 0;  // the OpenTelemetry severity number
  std::string service;
  std::string body;
};

struct Pattern {
  std::string text;      // the template
  uint64_t sample_count = 0;
  uint64_t count = 0;    // sample_count scaled to the whole range
  double share = 0;      // of the mined messages
  bool noisy = false;
  std::string sample;    // one message of the pattern
  std::string search;    // the constant words as a token search
  std::string service;   // the service with most messages
  uint64_t service_count = 0;
  std::string severity;  // the class with most messages: error, warn, info or debug
  std::vector<uint64_t> sparkline;  // scaled counts for each bucket of the range
};

struct MinedPatterns {
  std::vector<Pattern> patterns;  // at most max_patterns, largest first
  size_t pattern_count = 0;       // before the cut
  size_t mined = 0;               // the messages that were mined
  bool partial = false;           // the time ran out before the last message
  double scale = 0;               // total / mined
};

// `total` is the number of messages of the range (the sample stands for them). The range is [start_ms, start_ms + span_ms).
MinedPatterns mine_patterns(const std::vector<SampleRow>& sample, int64_t start_ms, int64_t span_ms, int sparkline_buckets, size_t max_patterns,
                            uint64_t total, const std::function<bool()>& out_of_time);

}  // namespace logs
}  // namespace chdash
