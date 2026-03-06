#pragma once

#include <sstream>
#include <string>
#include <string_view>

namespace chdash {

inline std::string sse_json_event(std::string_view event, std::string_view json) {
  std::ostringstream oss;
  oss << "event: " << event << "\n";
  oss << "data: " << json << "\n\n";
  return oss.str();
}

} // namespace chdash
