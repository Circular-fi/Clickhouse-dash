#pragma once

#include "server.hpp"

#include <string>

namespace chdash {

// HCL-only startup path. The file is the only source. The function reads an environment variable only when the file names
// it with an attribute that ends in _env (config_secret.hpp), and it reads each secret file one time.
AppConfig load_config_from_file(const std::string& path);

} // namespace chdash
