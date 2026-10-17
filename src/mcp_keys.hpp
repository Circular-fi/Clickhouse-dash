#pragma once

// MCP access keys (docs/mcp.md, "Key model"). Two sources add up. The keys.mode setting says which sources apply:
// - config keys: `mcp { mcp_key "name" { ... } }` blocks (and the older `key { ... }` blocks). The server reads them at start, and keeps them in memory. It never writes them.
// - UI keys: created from the MCP page, kept in one JSON file (version 1).
//
// A token is `mcp_` and 43 base64url characters (32 random bytes). A key of an older version has a UUID version 4. The store accepts such a key until the operator replaces it.
//
// A request is authenticated by the SHA-256 of the token. The store keeps the hash and the first characters of the token (the hint). It never keeps the token itself.
// The page shows a token once, when it makes the key. No route gives the token again. The token of a config key is hashed when the config is read.
//
// A key file that holds a secret in clear (a file of an older ChDash) is refused at start. Delete that file.
// The file is written atomically: a temporary file, fsync, rename, and mode 0600. The write happens through atomic_write_file(), outside the lock that authenticate() takes.
// Only one process owns the file. Two instances that share it overwrite each other's keys.

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

inline constexpr size_t kMcpSecretBytes = 36;  // a UUID version 4 of an older key: 8-4-4-4-12 hexadecimal digits
inline constexpr size_t kMcpSecretHintChars = 8;  // the hint of an older key
inline constexpr size_t kMcpTokenBytes = 47;      // mcp_ and the base64url text of 32 bytes, with no padding
inline constexpr size_t kMcpTokenHintChars = 12;  // the hint of a token: mcp_ and 8 characters
inline constexpr size_t kMcpNameMaxBytes = 32;
inline constexpr const char* kMcpNamePattern = "^[a-z0-9][a-z0-9_-]{0,31}$";
inline constexpr int kMcpKeyFileVersion = 1;
inline constexpr size_t kMcpMaxUiKeys = 1000;
inline constexpr size_t kMcpCreatorMaxBytes = 256;  // the longest `sub` of an identity token (access_identity.cpp)

using McpHash = std::array<uint8_t, 32>;

struct McpKey {
  std::string id;      // config: the name; UI: ui_<12 hex>
  std::string name;
  std::string source;  // "config" or "ui"
  McpHash secret_hash{};
  std::string secret_hint;  // the first characters of the token; empty for a key of a file that did not keep them
  // The user for whom the key operates (mcp_key.subject). An empty value means none.
  std::string subject;
  // A UI key: the subject of the access of humans that made the key (the `sub` of its identity token). Empty in the open mode.
  // In the authzen mode, the key works only while the PDP gives this subject every action that the tools of the key use.
  std::string creator;
  std::vector<std::string> hosts;
  std::vector<std::string> tools;
  std::vector<std::string> databases;
  std::optional<int64_t> max_rows;
  std::optional<int64_t> timeout_seconds;
  // mcp_key.limits.rate_limit_per_minute must be lower than the global value of mcp.
  // When it is absent, the global value applies.
  std::optional<int64_t> rate_limit_per_minute;
  // mcp_key.expires is a Unix time in seconds. From this time, the key gets the 401 error of an unknown key.
  std::optional<int64_t> expires_at;
  // A token that is a UUID version 4 comes from an older version. Replace it with an mcp_ token.
  bool legacy_token = false;
  std::optional<int64_t> created_at;  // Unix seconds; config keys have none
  std::optional<int64_t> updated_at;
};

// ---- time ---------------------------------------------------------------

std::string mcp_iso_utc(int64_t seconds);
// `YYYY-MM-DD` (00:00:00Z of that day) or `YYYY-MM-DDTHH:MM:SS[.fff]Z`.
bool mcp_parse_iso_utc(std::string_view text, int64_t* seconds);
// An RFC 3339 time has the form `YYYY-MM-DDTHH:MM:SS[.fff]`, then `Z` or an offset `+HH:MM` or `-HH:MM`.
// The fraction is ignored.
bool mcp_parse_rfc3339(std::string_view text, int64_t* seconds);

// ---- secrets ------------------------------------------------------------

// Make a new token. It is `mcp_` and the base64url text (no padding) of 32 bytes.
// The bytes come from the random source of the system.
std::string mcp_generate_secret();
// Return true for an mcp_ token. The token has `mcp_` and 43 characters of the base64url alphabet.
bool mcp_valid_token(std::string_view token);
// Return true for a UUID version 4 (8-4-4-4-12 hexadecimal digits, version 4, variant 8, 9, a or b).
// Such a value is the token of an older key.
bool mcp_legacy_secret(std::string_view secret);
// Return true for a token that a key can have.
// The token is an mcp_ token, or a UUID version 4 of an older key.
bool mcp_valid_secret(std::string_view secret);
McpHash mcp_hash_secret(std::string_view secret);
std::string mcp_hash_hex(const McpHash& hash);
bool mcp_parse_hash_hex(std::string_view text, McpHash* hash);
std::string mcp_secret_hint(std::string_view secret);
// Return what the page shows of a token, from its hint.
// For an mcp_ token, show the hint in clear, and a bullet (U+2022) for each other character.
// For an older key, show the shape of a UUID and the hint in clear. Keep the hyphens.
// When the hint is not known, show only bullets in the shape of a UUID.
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
  // The global caps that a key can only lower.
  int64_t max_rows_cap = 1000;
  int64_t timeout_cap = 30;
  // mcp.rate_limit_per_minute. The value 0 means no global limit.
  // A key can then set any limit of 1 or more.
  int64_t rate_limit_cap = 0;
  // This check runs when the page creates a key, after the checks above.
  // It never runs at start, and it never runs when a key file is read.
  // The check asks the running server. The MCP user of the host connects, and it holds the grants of the tools of the key.
  // An empty value means no such check.
  std::function<std::optional<McpValidationError>(const McpKey&)> live_check;
};

bool mcp_valid_key_name(std::string_view name);

// Check everything except uniqueness. Names and secrets are the business of the store.
std::optional<McpValidationError> mcp_validate_key(const McpKey& key, const McpKeyContext& context);

// ---- request bodies -----------------------------------------------------

// The body of POST /api/mcp/keys. A key is made, and never changed.
// An absent or null limit means the global limit.
struct McpKeyInput {
  std::optional<std::string> name;
  std::optional<std::vector<std::string>> hosts;
  std::optional<std::vector<std::string>> tools;
  std::optional<std::vector<std::string>> databases;
  std::optional<int64_t> max_rows;
  std::optional<int64_t> timeout_seconds;
};

// The server refuses a member that is not one of the fields above (validation, unknown_field).
// A client that sends `expires_at` or `max_memory_bytes` must not believe that its key has these fields.
std::optional<McpValidationError> mcp_parse_key_input(std::string_view body, McpKeyInput* out);

// ---- JSON ---------------------------------------------------------------

using McpJsonWriter = rapidjson::Writer<rapidjson::StringBuffer>;

// The Key object of the API contract (docs/mcp.md).
void mcp_write_key(McpJsonWriter& writer, const McpKey& key, std::optional<int64_t> last_used);

// ---- the UI key file ----------------------------------------------------

std::string mcp_serialize_key_file(const std::vector<McpKey>& ui_keys);

// Throw std::runtime_error when the text is not a valid version-1 file, or when a key holds its secret in clear.
// The message has no file content.
std::vector<McpKey> mcp_parse_key_file(std::string_view text);

// Read `path`. An absent file gives an empty list. An unreadable or invalid file throws.
// The function also throws when the directory of an absent file does not exist.
std::vector<McpKey> mcp_load_key_file(const std::string& path);

// ---- the store ----------------------------------------------------------

// mcp.keys.mode (docs/mcp.md, "Modes") says which sources of keys apply.
enum class McpKeysMode {
  Static,   // the keys of the configuration only; the page makes no key, and the key file is not read
  Dynamic,  // the keys of the page only; a key block of the configuration stops the start
  Hybrid,   // the two; the keys of the configuration are read-only on the page
};
const char* mcp_keys_mode_name(McpKeysMode mode);

struct McpStoreOptions {
  std::string storage_file;  // empty: UI keys cannot be created
  McpKeysMode mode = McpKeysMode::Hybrid;
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

  enum class AuthStatus { Ok, Missing, Unknown, Expired };
  struct AuthResult {
    AuthStatus status = AuthStatus::Missing;
    McpKey key;  // set unless Missing or Unknown
  };

  // Throw std::runtime_error when the file is invalid, or when a name or a secret is used twice.
  explicit McpKeyStore(McpStoreOptions options);

  McpKeyStore(const McpKeyStore&) = delete;
  McpKeyStore& operator=(const McpKeyStore&) = delete;

  bool storage_configured() const { return !options_.storage_file.empty(); }
  McpKeysMode mode() const { return options_.mode; }
  // The page can make and delete keys. This happens when the mode is dynamic or hybrid.
  bool manage_from_ui() const { return options_.mode != McpKeysMode::Static; }
  bool can_manage() const { return storage_configured() && manage_from_ui(); }
  const McpKeyContext& context() const { return options_.context; }

  // Config keys come first. UI keys follow, sorted by creation time.
  std::vector<McpKey> list();

  // The secret is given once, in the Result of create. The store keeps only its hash.
  // `creator` is the subject of the access of humans that makes the key (empty in the open mode).
  Result create(const McpKeyInput& input, int64_t now, const std::string& creator = std::string());
  Result remove(const std::string& id);

  // The comparison of the hash of `token` with every key takes constant time.
  // A key whose expiry is at or before `now` (Unix seconds) is Expired.
  // The last-use time of a key belongs to its usage (mcp_usage.hpp).
  AuthResult authenticate(std::string_view token, int64_t now);

private:
  Result fail(int status, const char* error, const std::string& message) const;
  Result invalid(const McpValidationError& error) const;
  bool name_taken_locked(const std::string& name, const std::string& except_id) const;
  bool write_file(const std::vector<McpKey>& keys, std::string* error) const;
  std::string new_id_locked() const;
  void apply_input(const McpKeyInput& input, McpKey* key) const;
  std::vector<McpKey> ui_keys_locked() const;

  McpStoreOptions options_;
  // write_mu_ makes the changes one at a time. It is held while the file is written (fsync).
  // mu_ guards keys_. It is never held during the write.
  // So authenticate() does not wait for a disk.
  std::mutex write_mu_;
  mutable std::mutex mu_;
  std::vector<McpKey> keys_;  // config keys, then UI keys
};

// ---- the rate limit -----------------------------------------------------------

// Show how a key stands with the rate limit now (McpRateLimiter::peek).
// It gives what a call can use of its bucket.
struct McpRateStatus {
  int64_t per_minute = 0;             // the limit; 0 = no limit (then the figures below are 0)
  int64_t remaining = 0;              // the whole calls that fit now
  int64_t next_call_in_seconds = 0;   // 0 when a call fits now; else when the next token comes
  int64_t full_in_seconds = 0;        // when the bucket is full again (0 when it is)
};

// Each key has one token bucket. A burst can have `per_minute` calls.
// The bucket refills evenly over a minute.
class McpRateLimiter {
public:
  // The value 0 for `per_minute` means no limit.
  // On refusal, `retry_after_seconds` gives the time when one call fits.
  bool allow(const std::string& key_id, int64_t now_ms, int64_t per_minute, int* retry_after_seconds);
  // Return the bucket of the key at `now_ms`, with no token taken.
  // A key that has no bucket yet has a full bucket.
  McpRateStatus peek(const std::string& key_id, int64_t now_ms, int64_t per_minute);

private:
  struct Bucket {
    double tokens = 0;
    int64_t at_ms = 0;
  };
  std::mutex mu_;
  std::unordered_map<std::string, Bucket> buckets_;
};

} // namespace chdash
