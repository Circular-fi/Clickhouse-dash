#pragma once

// MCP access keys (docs/mcp.md, "Key model"). Two sources add up:
// - config keys: `mcp { key { ... } }` blocks, read at start, kept in memory, never written;
// - UI keys: created from the MCP page, kept in one JSON file (version 1).
// A request is authenticated by the SHA-256 of the secret. The store keeps the hash and the first
// characters of the secret (the hint), never the secret: the page shows a secret once, when it makes
// the key, and no route gives it again. A config key's secret is hashed when the config is read.
// A key file that holds a secret in clear (a file of an older ChDash) is refused at start: delete it.
// The file is written atomically (temporary file, fsync, rename, mode 0600) through atomic_write_file(),
// outside the lock that authenticate() takes. One process owns the file: two instances that share it
// overwrite each other's keys.

#include <array>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

namespace chdash {

inline constexpr size_t kMcpSecretBytes = 36;  // a UUID version 4: 8-4-4-4-12 hexadecimal digits
inline constexpr size_t kMcpSecretHintChars = 8;
inline constexpr size_t kMcpNameMaxBytes = 32;
inline constexpr const char* kMcpNamePattern = "^[a-z0-9][a-z0-9_-]{0,31}$";
inline constexpr int kMcpKeyFileVersion = 1;
inline constexpr size_t kMcpMaxUiKeys = 1000;

using McpHash = std::array<uint8_t, 32>;

struct McpKey {
  std::string id;      // config: the name; UI: ui_<12 hex>
  std::string name;
  std::string source;  // "config" or "ui"
  McpHash secret_hash{};
  std::string secret_hint;  // the first characters of the secret; empty for a key of a file that did not keep them
  std::vector<std::string> hosts;
  std::vector<std::string> tools;
  std::vector<std::string> databases;
  std::optional<int64_t> max_rows;
  std::optional<int64_t> timeout_seconds;
  std::optional<int64_t> created_at;  // Unix seconds; config keys have none
  std::optional<int64_t> updated_at;
};

// ---- time ---------------------------------------------------------------

std::string mcp_iso_utc(int64_t seconds);
// `YYYY-MM-DD` (00:00:00Z of that day) or `YYYY-MM-DDTHH:MM:SS[.fff]Z`.
bool mcp_parse_iso_utc(std::string_view text, int64_t* seconds);

// ---- secrets ------------------------------------------------------------

// A version 4 UUID (RFC 9562: 122 random bits from the system CSPRNG), lower case, with hyphens.
std::string mcp_generate_secret();
// True for a UUID version 4 (8-4-4-4-12 hexadecimal digits, version 4, variant 8, 9, a or b): the only format of a secret.
bool mcp_valid_secret(std::string_view secret);
McpHash mcp_hash_secret(std::string_view secret);
std::string mcp_hash_hex(const McpHash& hash);
bool mcp_parse_hash_hex(std::string_view text, McpHash* hash);
std::string mcp_secret_hint(std::string_view secret);
// What the page shows of a secret, from its hint: the shape of a UUID (every secret is one), the hint in clear and a
// bullet (U+2022) for every other character, the hyphens kept. All bullets when the hint is not known.
std::string mcp_secret_mask(std::string_view hint);

// ---- validation ---------------------------------------------------------

struct McpValidationError {
  std::string field;
  std::string reason;  // required type invalid too_long unknown_host too_many unknown_tool needs_all_data not_grantable mcp_user_unavailable duplicate range invalid_json unknown_field
  std::string message;
};

struct McpKeyContext {
  // The hosts that have an mcp_uri.
  std::vector<std::string> hosts;
  // The global caps a key may only lower.
  int64_t max_rows_cap = 1000;
  int64_t timeout_cap = 30;
  // Checked when a key is created from the page, after the checks above, and never at start or when a key
  // file is read: it asks the running server (the MCP user of the host connects, it holds the grants of the
  // tools of the key). Empty: no such check.
  std::function<std::optional<McpValidationError>(const McpKey&)> live_check;
};

bool mcp_valid_key_name(std::string_view name);

// Everything but uniqueness (names and secrets are the store's business).
std::optional<McpValidationError> mcp_validate_key(const McpKey& key, const McpKeyContext& context);

// ---- request bodies -----------------------------------------------------

// The body of POST /api/mcp/keys (a key is made, never changed). An absent or null limit is the global one.
struct McpKeyInput {
  std::optional<std::string> name;
  std::optional<std::vector<std::string>> hosts;
  std::optional<std::vector<std::string>> tools;
  std::optional<std::vector<std::string>> databases;
  std::optional<int64_t> max_rows;
  std::optional<int64_t> timeout_seconds;
};

// A member that is not one of the fields above is refused (validation, unknown_field): a client that sends
// `expires_at` or `max_memory_bytes` must not believe that its key has them.
std::optional<McpValidationError> mcp_parse_key_input(std::string_view body, McpKeyInput* out);

// ---- JSON ---------------------------------------------------------------

using McpJsonWriter = rapidjson::Writer<rapidjson::StringBuffer>;

// The Key object of the API contract (docs/mcp.md).
void mcp_write_key(McpJsonWriter& writer, const McpKey& key, std::optional<int64_t> last_used);

// ---- the UI key file ----------------------------------------------------

std::string mcp_serialize_key_file(const std::vector<McpKey>& ui_keys);

// Throws std::runtime_error (a message without file content) when the text is not a valid version-1 file, or when a
// key holds its secret in clear.
std::vector<McpKey> mcp_parse_key_file(std::string_view text);

// Reads `path`: an absent file is an empty list, an unreadable or invalid one throws.
// Also throws when the directory of an absent file does not exist.
std::vector<McpKey> mcp_load_key_file(const std::string& path);

// ---- the store ----------------------------------------------------------

struct McpStoreOptions {
  std::string storage_file;  // empty: UI keys cannot be created
  bool manage_from_ui = true;
  std::vector<McpKey> config_keys;
  McpKeyContext context;
};

class McpKeyStore {
public:
  struct Result {
    int status = 200;
    std::string error;  // API error code, empty on success
    std::string field;
    std::string reason;
    std::string message;
    std::optional<McpKey> key;
    std::string secret;  // set on create, the one time the secret is given
  };

  enum class AuthStatus { Ok, Missing, Unknown };
  struct AuthResult {
    AuthStatus status = AuthStatus::Missing;
    McpKey key;  // set unless Missing or Unknown
  };

  // Throws std::runtime_error when the file is invalid or a name or secret is used twice.
  explicit McpKeyStore(McpStoreOptions options);

  McpKeyStore(const McpKeyStore&) = delete;
  McpKeyStore& operator=(const McpKeyStore&) = delete;

  bool storage_configured() const { return !options_.storage_file.empty(); }
  bool manage_from_ui() const { return options_.manage_from_ui; }
  bool can_manage() const { return storage_configured() && options_.manage_from_ui; }
  const McpKeyContext& context() const { return options_.context; }

  // Config keys first, then UI keys by creation time.
  std::vector<McpKey> list();

  // The secret comes once, in the Result of create: the store keeps its hash only.
  Result create(const McpKeyInput& input, int64_t now);
  Result remove(const std::string& id);

  // Constant-time comparison of the hash of `token` with every key. When a key was last used is its usage's (mcp_usage.hpp).
  AuthResult authenticate(std::string_view token);

private:
  Result fail(int status, const char* error, const std::string& message) const;
  Result invalid(const McpValidationError& error) const;
  bool name_taken_locked(const std::string& name, const std::string& except_id) const;
  bool write_file(const std::vector<McpKey>& keys, std::string* error) const;
  std::string new_id_locked() const;
  void apply_input(const McpKeyInput& input, McpKey* key) const;
  std::vector<McpKey> ui_keys_locked() const;

  McpStoreOptions options_;
  // write_mu_ makes the changes one at a time and is held while the file is written (fsync); mu_ guards keys_ and is
  // never held during the write, so authenticate() does not wait for a disk.
  std::mutex write_mu_;
  mutable std::mutex mu_;
  std::vector<McpKey> keys_;  // config keys, then UI keys
};

// ---- the rate limit -----------------------------------------------------------

// One token bucket per key: a burst of `per_minute` calls, refilled evenly over a minute.
class McpRateLimiter {
public:
  // `per_minute` 0 = no limit. On refusal, `retry_after_seconds` says when one call fits.
  bool allow(const std::string& key_id, int64_t now_ms, int64_t per_minute, int* retry_after_seconds);

private:
  struct Bucket {
    double tokens = 0;
    int64_t at_ms = 0;
  };
  std::mutex mu_;
  std::unordered_map<std::string, Bucket> buckets_;
};

} // namespace chdash
