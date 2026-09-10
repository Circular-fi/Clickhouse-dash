#pragma once

#include "server.hpp"

#include <string>

namespace chdash {

// HCL-only startup path. This function never reads the process environment.
AppConfig load_config_from_file(const std::string& path);

} // namespace chdash
