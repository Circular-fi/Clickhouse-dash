#pragma once

#include "server.hpp"

#include <string>

namespace chdash {

// Legacy startup path. Every process environment lookup is intentionally kept
// behind this function so --config can bypass environment configuration in a
// way that is easy to audit and test.
AppConfig load_config_from_environment();

// File-only startup path. This function never reads the process environment.
AppConfig load_config_from_file(const std::string& path);

} // namespace chdash
