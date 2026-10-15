#pragma once

// Where the usage of the MCP keys is kept (docs/mcp.md, "Usage of a key"). McpUsage counts the state of its instance in memory; a store
// loads it at the start, saves it, reads again the states of the other instances, and removes what an instance that is gone left.
//
// The files mode (McpUsageFileStore) keeps one file for each instance in a directory that several instances can share:
//   <dir>/<instance>.jsonl.zst
// JSON Lines (one flat JSON object for each line) compressed with zstd. Every line has its `type` and its `instance`; the times are Unix
// seconds. The lines are the rows of a table: the files can be read as they are (`clickhouse local`, DuckDB) and the same rows will go to a
// database table in a mode to come. A file is written whole, to a temporary file that is renamed over it; an instance writes its own file
// only and reads the others.

#include "mcp_usage.hpp"

#include <atomic>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <vector>

namespace chdash {

// The rows of a state, as a file or a table holds them. The views live while the row is handled.
struct McpUsageKeyRow {
  std::string_view key;  // the id of the key
  std::string_view name;
  std::string_view host;
  std::string_view source;  // config or ui
  int64_t first_used = 0;   // Unix seconds, 0: never
  int64_t last_used = 0;
  int64_t deleted_at = 0;   // 0: the key exists
};
struct McpUsageClientRow {  // the life of a client of a key
  std::string_view key;
  std::string_view name;
  std::string_view version;
  std::string_view user_agent;
  int64_t first_seen = 0;
  int64_t last_seen = 0;
  uint64_t requests = 0;
};
struct McpUsageCellRow {  // the requests of one type, client, method and result in one bucket of one tier: the row of the future table
  std::string_view key;
  std::string_view tier;  // m1, m5, m15, h3, h12 or d1
  int64_t start = 0;      // the start of the bucket: a multiple of the step of the tier
  std::string_view kind;  // call, request, limited or rejected
  std::string_view client;
  std::string_view method;
  std::string_view result;
  uint64_t count = 0;
  uint64_t duration_ms_sum = 0;
  uint64_t duration_ms_max = 0;
  uint64_t rows = 0;
  uint64_t bytes = 0;
};

struct McpUsageHeader {  // what a save says of the state that it writes
  int64_t since = 0;
  int64_t written_at = 0;
  int64_t retention_days = 0;
};

// A save in progress: the rows of the state of this instance go in one after the other (the key, its clients, its cells), then commit()
// makes them the stored state. A writer that is dropped without commit() leaves the stored state as it was.
class McpUsageWriter {
public:
  virtual ~McpUsageWriter() = default;
  virtual void key(const McpUsageKeyRow& row) = 0;
  virtual void client(const McpUsageClientRow& row) = 0;
  virtual void cell(const McpUsageCellRow& row) = 0;
  // Writes the rows that came so far: they are only held in memory until then, so that a caller that holds a lock while it hands the rows in
  // (McpUsage does, one entry at a time) never waits for the disk.
  virtual void flush() = 0;
  // False, with the reason, when the state could not be stored.
  virtual bool commit(std::string* error) = 0;
  // What the rows came to, before any compression: the size that the next save is due by.
  virtual size_t bytes() const = 0;
};

enum class McpUsageSaveStatus { Ok, Conflict, Failed };

class McpUsageStore {
public:
  virtual ~McpUsageStore() = default;
  // The name of this instance: [A-Za-z0-9._-], 1 to 64 bytes.
  virtual const std::string& instance() const = 0;
  // Where the state of this instance is kept, for the log (the file of the files mode).
  virtual std::string location() const = 0;
  // At the start: the state that this instance stored last. False when it stored none yet. Throws std::runtime_error (a message that never
  // holds the content of the file) when what is stored is not valid: it is never replaced then.
  virtual bool load(McpUsage::State* state, size_t max_clients) = 0;
  // A save. Null when the state cannot be written: `status` says whether another process writes the same instance (`Conflict`: its file is
  // not replaced) or the write failed (`Failed`, with `error`).
  virtual std::unique_ptr<McpUsageWriter> begin(const McpUsageHeader& header, McpUsageSaveStatus* status, std::string* error) = 0;
  // The states of the other instances, by instance. What did not change since the last call is the same object. False when they cannot be
  // listed, or when `cancel` was set (the stop): the caller keeps what it has. Never called from a request.
  virtual bool refresh(std::vector<McpUsage::Other>* others, size_t max_clients, const std::atomic<bool>& cancel) = 0;
  // Removes the state of an instance that is gone: one that was written, and that its file says so, more than `retention_days` and a day ago.
  virtual void prune(int64_t now, int64_t retention_days) = 0;
};

// The bounds of a file that is read, and that is written (a file of another instance is not trusted): its size compressed, its size once
// decompressed (the decompression stops there, so that a zstd bomb never grows), and a line. The unit tests lower them.
struct McpUsageFileLimits {
  size_t max_compressed_bytes = 128u * 1024 * 1024;
  size_t max_decompressed_bytes = 512u * 1024 * 1024;
  size_t max_line_bytes = 64 * 1024;
};

// The files mode. It reads and writes the files of `dir` with the mode 0600 (the instances that share a directory run as the same user).
class McpUsageFileStore final : public McpUsageStore {
public:
  // `instance` must be valid (mcp_valid_usage_instance). A directory that anyone can write in, without the sticky bit, is a warning in the log.
  McpUsageFileStore(std::string dir, std::string instance, McpUsageFileLimits limits = {});

  const std::string& instance() const override { return instance_; }
  std::string location() const override { return path_of(instance_); }
  bool load(McpUsage::State* state, size_t max_clients) override;
  std::unique_ptr<McpUsageWriter> begin(const McpUsageHeader& header, McpUsageSaveStatus* status, std::string* error) override;
  bool refresh(std::vector<McpUsage::Other>* others, size_t max_clients, const std::atomic<bool>& cancel) override;
  void prune(int64_t now, int64_t retention_days) override;

  const std::string& dir() const { return dir_; }
  // The name of the file of an instance: <instance>.jsonl.zst.
  static std::string file_name(const std::string& instance);

private:
  // What the last read of the file of an instance made of it.
  struct Seen {
    int64_t mtime_ns = 0;
    int64_t size = 0;
    bool known = false;  // the answer holds while the file stays as it is (false: the file is asked again every time)
    std::string logged;  // the reason that was logged for this file, so that a reason that does not change is logged once
    McpUsage::Other other;
  };

  std::string path_of(const std::string& instance) const;
  void remove_old_temporaries();

  std::string dir_;
  std::string instance_;
  McpUsageFileLimits limits_;
  std::string boot_;       // this start of the process
  std::mutex mu_;          // guards the header of the file of this instance
  std::string seen_boot_;  // the header of the file of this instance as this process last saw it (read or written)
  int64_t seen_written_at_ = 0;
  bool seen_file_ = false;
  std::string conflict_with_;  // the writer that the last conflict was with, so that a conflict is logged once
  std::mutex files_mu_;        // guards what follows: the other instances
  std::string refresh_error_;  // the last failure to list the directory, logged once
  std::string crowded_;        // the first instance that was left out because the directory holds too many, logged once
  std::map<std::string, Seen> files_;
};

// Throws std::runtime_error (a message without the content of any file) when `dir` cannot hold the usage of `instance`: it is empty, does not
// exist, is not a directory, ChDash cannot create files in it, or the file of this instance is there and is not valid (it is never replaced).
void mcp_check_usage_dir(const std::string& dir, const std::string& instance);

// The host name of this machine (what an instance that the configuration leaves unnamed is called, when it is a valid instance).
std::string mcp_usage_host_name();

} // namespace chdash
