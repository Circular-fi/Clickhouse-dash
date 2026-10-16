#include "config_secret.hpp"

#include <cstdlib>
#include <fstream>
#include <sstream>
#include <stdexcept>

namespace chdash {
namespace {

bool valid_variable_name(const std::string& name) {
  if (name.empty() || (name[0] >= '0' && name[0] <= '9')) return false;
  for (const unsigned char c : name) {
    if (!(c == '_' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))) return false;
  }
  return true;
}

// The form <name>_env or <name>_file of `object`, checked; nullopt when it holds neither.
std::optional<SecretRef> find_indirect_ref(const HclObject& object, const std::string& name, const std::string& context);

} // namespace

std::optional<SecretRef> find_secret_ref(const HclObject& object, const std::string& name, const std::string& context) {
  if (object.attrs.count(name) != 0) {
    throw std::runtime_error(context + "." + name + ": a secret is never written in the file: use " + name + "_env (an environment variable) or " +
                             name + "_file (a file)");
  }
  return find_indirect_ref(object, name, context);
}

std::optional<SecretValue> read_value_forms(const HclObject& object, const std::string& name, const std::string& context) {
  const auto plain = object.attrs.find(name);
  if (plain != object.attrs.end()) {
    if (object.attrs.count(name + "_env") != 0 || object.attrs.count(name + "_file") != 0) {
      throw std::runtime_error(context + ": give exactly one of " + name + ", " + name + "_env and " + name + "_file, not more than one");
    }
    if (!plain->second.is_string()) {
      throw std::runtime_error(context + "." + name + " must be a string, not " + hcl_value_text(plain->second));
    }
    if (plain->second.as_string().empty()) throw std::runtime_error(context + "." + name + " cannot be empty");
    return SecretValue{plain->second.as_string(), "file"};
  }
  const auto ref = find_indirect_ref(object, name, context);
  if (!ref) return std::nullopt;
  return read_secret(*ref, context);
}

namespace {

std::optional<SecretRef> find_indirect_ref(const HclObject& object, const std::string& name, const std::string& context) {
  const std::string env_name = name + "_env";
  const std::string file_name = name + "_file";
  const auto env = object.attrs.find(env_name);
  const auto file = object.attrs.find(file_name);
  if (env != object.attrs.end() && file != object.attrs.end()) {
    throw std::runtime_error(context + ": give exactly one of " + env_name + " and " + file_name + ", not both");
  }
  if (env == object.attrs.end() && file == object.attrs.end()) return std::nullopt;
  const bool from_env = env != object.attrs.end();
  const std::string& attribute = from_env ? env_name : file_name;
  const HclValue& value = from_env ? env->second : file->second;
  if (!value.is_string()) {
    throw std::runtime_error(context + "." + attribute + " must be a string (" +
                             (from_env ? "the name of an environment variable" : "the path of a file") + "), not " + hcl_value_text(value));
  }
  if (value.as_string().empty()) {
    throw std::runtime_error(context + "." + attribute + " cannot be empty (" +
                             (from_env ? "the name of an environment variable" : "the path of a file") + ")");
  }
  if (from_env && !valid_variable_name(value.as_string())) {
    throw std::runtime_error(context + "." + attribute + " must be the name of an environment variable (letters, digits and _, not starting with a digit), not " +
                             hcl_value_text(value));
  }
  return SecretRef{attribute, from_env, value.as_string()};
}

} // namespace

std::string read_secret_file(const std::string& path, const std::string& label) {
  std::ifstream input(path, std::ios::binary);
  if (!input) throw std::runtime_error(label + ": cannot open " + path);
  std::ostringstream content;
  content << input.rdbuf();
  if (input.bad()) throw std::runtime_error(label + ": cannot read " + path);
  std::string text = content.str();
  if (text.find('\0') != std::string::npos) throw std::runtime_error(label + ": the file " + path + " holds a NUL byte");
  if (!text.empty() && text.back() == '\n') {
    text.pop_back();
    if (!text.empty() && text.back() == '\r') text.pop_back();
  }
  if (text.empty()) throw std::runtime_error(label + ": the file " + path + " is empty");
  return text;
}

SecretValue read_secret(const SecretRef& ref, const std::string& context) {
  const std::string label = context + "." + ref.attribute;
  if (ref.from_env) {
    const char* value = std::getenv(ref.target.c_str());  // the one read of the environment: the file names the variable
    if (!value) throw std::runtime_error(label + ": the environment variable " + ref.target + " is not set");
    if (*value == '\0') throw std::runtime_error(label + ": the environment variable " + ref.target + " is empty");
    return SecretValue{value, "env:" + ref.target};
  }
  return SecretValue{read_secret_file(ref.target, label), "file:" + ref.target};
}

} // namespace chdash
