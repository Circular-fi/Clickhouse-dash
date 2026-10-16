#pragma once

// The secrets of the configuration file (docs/configuration.md, "Secrets"). A secret is never written in the file. An
// attribute `<name>` that holds a secret has two forms instead:
//   <name>_env  = "VAR"    the value is in the environment variable VAR;
//   <name>_file = "/path"  the value is the content of the file, without the last line end.
// Exactly one form applies. A variable that is not set or is empty, and a file that cannot be read or is empty, stop the
// start. This is the only code of ChDash that reads the environment, and it reads only a variable that the file names.

#include "hcl.hpp"

#include <optional>
#include <string>

namespace chdash {

// The form that the file uses for the secret `name` of an object.
struct SecretRef {
  std::string attribute;  // "password_env" or "password_file"
  bool from_env = false;
  std::string target;     // the name of the variable, or the path of the file
};

// The form of `<name>_env` or `<name>_file` that `object` holds; nullopt when it holds neither. Throws when the file writes
// the secret in clear text (`<name>`), when it holds both forms, or when a form is not a text. `context` names the
// object in the message ("clickhouse.host prod").
std::optional<SecretRef> find_secret_ref(const HclObject& object, const std::string& name, const std::string& context);

// The value of the secret, and where it came from ("env:VAR" or "file:/path"). Throws, with the attribute and the
// variable or the path, when the variable is not set or is empty, or when the file cannot be read or is empty.
struct SecretValue {
  std::string value;
  std::string source;
};
SecretValue read_secret(const SecretRef& ref, const std::string& context);

// An attribute `<name>` that is not a secret and that has three forms (docs/configuration.md, "Values from the environment or from
// a file"): <name> (the value is in the file), <name>_env (an environment variable) and <name>_file (a file). nullopt when `object`
// holds none of them. Throws when it holds more than one, when a form is not a text or is empty, and when the variable or the file
// gives no value (as read_secret). The source is "file", "env:VAR" or "file:/path".
std::optional<SecretValue> read_value_forms(const HclObject& object, const std::string& name, const std::string& context);

// The content of a file without its last line end ("\n" or "\r\n"). Throws std::runtime_error (without the content) when
// the file cannot be read, holds a NUL byte, or is empty after that.
std::string read_secret_file(const std::string& path, const std::string& label);

} // namespace chdash
