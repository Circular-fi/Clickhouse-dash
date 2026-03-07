#pragma once

#include "health_runner.hpp"

#include <string>
#include <vector>

namespace chdash {

inline const HostSpec* find_host(const std::vector<HostSpec>& hosts, const std::string& id) {
  for (const auto& h : hosts) {
    if (h.id == id) return &h;
  }
  return nullptr;
}

inline bool is_host_healthy(const HealthRunner* runner, const std::string& host_id) {
  if (!runner) return true;
  const HostsSnapshot snap = runner->snapshot();
  for (const auto& h : snap.hosts) {
    if (h.id == host_id) return h.healthy;
  }
  return true;
}

} // namespace chdash
