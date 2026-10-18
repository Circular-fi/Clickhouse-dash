#pragma once

// A PDP of the tests with the rule of the grants (contract 11.4, docs/access.md "Hosts"). A grant is "<action>@<path>", where the path
// is "service:<id>" and then "/<type>:<encoded id>" for each node below the service (0 to 4 nodes). A grant covers the resource that it
// names and every resource below it: the path of the grant is a prefix of the path of the question, segment by segment. With the match
// "subtree" (addendum 1), a grant below the resource also gives true: the path of the question is a prefix of the path of the grant.
//
// The chain of a question (its ancestors and the resource) must start with the service of the client and follow the declared parents.
// A question on a type other than the service without ancestors is read as [service] + resource (the one-level form of 1.0.8). It is
// valid only when the parent of its type is the service. A chain that is not valid gives false with the reason "invalid_resource".

#include "access_resource.hpp"

#include <map>
#include <string>
#include <vector>

namespace chdash_test {

struct GrantAnswer {
  bool decision = false;
  bool invalid_resource = false;
};

class GrantRules {
public:
  explicit GrantRules(std::string service, std::map<std::string, std::string> parents = {{"host", "service"}, {"database", "host"}})
      : service_(std::move(service)), parents_(std::move(parents)) {}

  // grants: "<action>@<path>" for one subject.
  GrantAnswer decide(const std::vector<std::string>& grants, const std::string& action, const chdash::AccessResource& resource,
                     bool subtree = false) const {
    GrantAnswer out;
    std::vector<chdash::AccessNode> chain = resource.ancestors;
    if (resource.type != "service" && chain.empty()) chain.push_back(chdash::AccessNode{"service", service_});
    chain.push_back(chdash::AccessNode{resource.type, resource.id});
    if (chain.front().type != "service" || chain.front().id != service_) {
      out.invalid_resource = true;
      return out;
    }
    for (size_t i = 1; i < chain.size(); ++i) {
      const auto parent = parents_.find(chain[i].type);
      if (parent == parents_.end() || parent->second != chain[i - 1].type) {
        out.invalid_resource = true;
        return out;
      }
    }
    std::vector<std::string> segments;
    for (const auto& node : chain) segments.push_back(node.type + ":" + chdash::access_encode_id(node.id));
    for (const auto& grant : grants) {
      const size_t at = grant.find('@');
      if (at == std::string::npos || grant.substr(0, at) != action) continue;
      const std::vector<std::string> granted = split(grant.substr(at + 1));
      // The shorter path must be the start of the longer one. A longer grant counts only with the match "subtree".
      if (granted.size() > segments.size() && !subtree) continue;
      const size_t common = granted.size() < segments.size() ? granted.size() : segments.size();
      bool prefix = true;
      for (size_t i = 0; i < common && prefix; ++i) prefix = granted[i] == segments[i];
      if (prefix) out.decision = true;
    }
    return out;
  }

private:
  static std::vector<std::string> split(const std::string& path) {
    std::vector<std::string> out;
    size_t start = 0;
    while (start <= path.size()) {
      const size_t slash = path.find('/', start);
      out.push_back(path.substr(start, slash == std::string::npos ? std::string::npos : slash - start));
      if (slash == std::string::npos) break;
      start = slash + 1;
    }
    return out;
  }

  std::string service_;
  std::map<std::string, std::string> parents_;
};

} // namespace chdash_test
