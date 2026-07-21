#pragma once

#include <string>
#include <string_view>

namespace chdash {

inline std::string sse_json_event(std::string_view event, std::string_view json) {
  std::string out;
  out.reserve(event.size() + json.size() + 16);
  out += "event: ";
  out.append(event.data(), event.size());
  out += "\ndata: ";
  out.append(json.data(), json.size());
  out += "\n\n";
  return out;
}

} // namespace chdash
