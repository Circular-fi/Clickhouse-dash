#pragma once

// MCP access keys (docs/mcp.md, "Key model"). Two sources add up:
// - config keys: `mcp { key { ... } }` blocks, read at start, kept in memory, never written;
// - UI keys: created from the MCP page, kept in one JSON file (version 1).
// A request is authenticated by the SHA-256 of the secret. The store also keeps the secret
// itself when it is known (UI keys, config keys with `secret` or `secret_file`), so that the
// MCP page can show it again; a key from `secret_sha256`, or from a file written before the
// secret was kept, has none. The file is written atomically (temporary file, fsync, rename,
// mode 0600) through atomic_write_file().

#include <array>
#include <cstddef>
#include <cstdint>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

namespace chdash {

inline constexpr size_t kMcpSecretMinBytes = 24;
inline constexpr size_t kMcpSecretHintChars = 12;
inline constexpr const char* kMcpSecretPrefix = "chm_";
inline constexpr const char* kMcpNamePattern = "^[a-z0-9][a-z0-9_-]{0,63}$";
inline constexpr int kMcpKeyFileVersion = 1;
inline constexpr size_t kMcpMaxUiKeys = 1000;

using McpHash = std::array<uint8_t, 32>;

struct McpKey {
  std::string id;      // config: the name; UI: ui_<12 hex>
  std::string name;
  std::string source;  // "config" or "ui"
  McpHash secret_hash{};
  std::string secret;       // the secret itself; empty when it is not known
  std::string secret_hint;  // its first characters; empty when the secret is not known
  std::vector<std::string> hosts;
  std::vector<std::string> tools;
  std::vector<std::string> databases;
  std::optional<int64_t> max_rows;
  std::optional<int64_t> timeout_seconds;
  bool enabled = true;
  std::optional<int64_t> created_at;  // Unix seconds; config keys have none
  std::optional<int64_t> updated_at;
};

enum class McpKeyState { Active, Disabled };
McpKeyState mcp_key_state(const McpKey& key);
const char* mcp_key_state_name(McpKeyState state);

// ---- time ---------------------------------------------------------------

std::string mcp_iso_utc(int64_t seconds);
// `YYYY-MM-DD` (00:00:00Z of that day) or `YYYY-MM-DDTHH:MM:SS[.fff]Z`.
bool mcp_parse_iso_utc(std::string_view text, int64_t* seconds);

// ---- secrets ------------------------------------------------------------

// `chm_` + URL-safe base64 (no padding) of 32 bytes from the system CSPRNG.
std::string mcp_generate_secret();
McpHash mcp_hash_secret(std::string_view secret);
std::string mcp_hash_hex(const McpHash& hash);
bool mcp_parse_hash_hex(std::string_view text, McpHash* hash);
std::string mcp_secret_hint(std::string_view secret);

// ---- validation ---------------------------------------------------------

struct McpValidationError {
  std::string field;
  std::string reason;  // required type invalid too_long unknown_host unknown_tool needs_all_data duplicate range invalid_json
  std::string message;
};

struct McpKeyContext {
  // The hosts that have an mcp_uri.
  std::vector<std::string> hosts;
  // The global caps a key may only lower.
  int64_t max_rows_cap = 1000;
  int64_t timeout_cap = 30;
};

bool mcp_valid_key_name(std::string_view name);

// Everything but uniqueness (names and secrets are the store's business).
std::optional<McpValidationError> mcp_validate_key(const McpKey& key, const McpKeyContext& context);

// ---- request bodies -----------------------------------------------------

// The body of POST / PATCH /api/mcp/keys. A *_set flag with an empty value is JSON null.
struct McpKeyInput {
  std::optional<std::string> name;
  std::optional<std::vector<std::string>> hosts;
  std::optional<std::vector<std::string>> tools;
  std::optional<std::vector<std::string>> databases;
  bool max_rows_set = false;
  std::optional<int64_t> max_rows;
  bool timeout_set = false;
  std::optional<int64_t> timeout_seconds;
  std::optional<bool> enabled;
};

std::optional<McpValidationError> mcp_parse_key_input(std::string_view body, bool creating, McpKeyInput* out);

// ---- JSON ---------------------------------------------------------------

using McpJsonWriter = rapidjson::Writer<rapidjson::StringBuffer>;

// The Key object of the API contract (docs/mcp.md).
void mcp_write_key(McpJsonWriter& writer, const McpKey& key, std::optional<int64_t> last_used);

// ---- the UI key file ----------------------------------------------------

std::string mcp_serialize_key_file(const std::vector<McpKey>& ui_keys);
// Throws std::runtime_error (a message without file content) when the text is not a valid version-1 file.
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
    std::string secret;  // set on create, rotate and reveal
    std::optional<int64_t> last_used_at;
  };

  enum class AuthStatus { Ok, Missing, Unknown, Disabled };
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

  struct Listed {
    McpKey key;
    std::optional<int64_t> last_used_at;
  };
  // Config keys first, then UI keys by creation time.
  std::vector<Listed> list();

  Result create(const McpKeyInput& input, int64_t now);
  Result update(const std::string& id, const McpKeyInput& input, int64_t now);
  Result rotate(const std::string& id, int64_t now);
  Result remove(const std::string& id);
  // The secret of a key, when the store knows it (Result.secret); 404 secret_unavailable otherwise.
  Result reveal(const std::string& id);

  // Constant-time comparison of the hash of `token` with every key.
  AuthResult authenticate(std::string_view token, int64_t now);
  void touch(const std::string& id, int64_t now);

private:
  Result fail(int status, const char* error, const std::string& message) const;
  Result invalid(const McpValidationError& error) const;
  bool name_taken_locked(const std::string& name, const std::string& except_id) const;
  bool write_locked(const std::vector<McpKey>& keys, std::string* error) const;
  std::string new_id_locked() const;
  void apply_input(const McpKeyInput& input, McpKey* key) const;
  std::vector<McpKey> ui_keys_locked() const;

  McpStoreOptions options_;
  mutable std::mutex mu_;
  std::vector<McpKey> keys_;  // config keys, then UI keys
  std::unordered_map<std::string, int64_t> last_used_;
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
