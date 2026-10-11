#pragma once

// The patterns of the logs routes as pure units (api_logs.cpp, docs/logs.md): the masking of the variable parts of a message and a
// Drain port (He et al. 2017) that groups the masked messages into templates. No I/O, no clock: the route owns the budget.
#include <cstddef>
#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace chdash::logs {

extern const std::string kParam;

// Replaces the variable parts of a message with <*>.
std::string mask_body(std::string_view body);
// The tokens of a masked message (at most 64).
std::vector<std::string> whitespace_tokens(const std::string& text);

struct Cluster {
  std::vector<std::string> tokens;
  size_t size = 0;
  std::string sample;
  std::vector<uint32_t> buckets;
  std::map<std::string, size_t> services;
  size_t severity[4] = {0, 0, 0, 0};
};

struct DrainNode {
  std::map<std::string, std::unique_ptr<DrainNode>> children;
  std::vector<size_t> clusters;
};

class Drain {
 public:
  static constexpr int kDepth = 4;
  static constexpr double kSimilarity = 0.4;
  static constexpr size_t kMaxChildren = 100;
  // The clusters of one leaf (the messages of one length that start alike): past this a message joins the nearest cluster
  // whatever its similarity, so the search for the best one stays short (50 comparisons at most for each message).
  static constexpr size_t kMaxClustersPerLeaf = 50;

  // Adds the tokens of one masked message and returns the id of its cluster.
  size_t add(const std::vector<std::string>& tokens);
  std::vector<Cluster>& clusters() { return clusters_; }

 private:
  DrainNode* descend(const std::vector<std::string>& tokens, bool create);
  size_t best_match(const DrainNode& leaf, const std::vector<std::string>& tokens, bool force = false) const;

  DrainNode root_;
  std::vector<Cluster> clusters_;
};

// The constant words of a template as a token search: "<*>" parts dropped, "key=user:<*>" kept as the term "key=user:".
std::string pattern_search_text(const std::vector<std::string>& tokens);

// The severity class of an OpenTelemetry severity number: 0 error, 1 warn, 2 info, 3 debug.
int severity_index(int number);

}  // namespace chdash::logs
