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

} // namespace chdash
