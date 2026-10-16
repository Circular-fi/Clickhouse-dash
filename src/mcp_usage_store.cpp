#include "mcp_usage_store.hpp"

#include "json_parse.hpp"
#include "json_text.hpp"
#include "log.hpp"
#include "mcp_usage_state.hpp"
#include "secure_random.hpp"

#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <zstd/zstd.h>

#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <ctime>
#include <functional>
#include <optional>
#include <stdexcept>
#include <system_error>

namespace chdash {
namespace {

using namespace mcp_usage;

// The bounds of a file that is read, apart from the bounds of McpUsageFileLimits. They set the keys and the cells that a file may hold, and the instances that are read.
constexpr size_t kMaxFileKeys = 10000;
constexpr size_t kMaxFileCells = 2000000;
constexpr size_t kMaxInstances = 256;
// The window of a zstd frame that is read has a maximum of 16 MiB. A frame that asks for more memory is refused.
constexpr unsigned kWindowLogMax = 24;
constexpr int kZstdLevel = 3;
// A file of this name that another process wrote less than this long ago shows a live process.
constexpr int64_t kConflictSeconds = 120;
// A temporary file of a save that a crash left. The start removes it when the file is this old.
constexpr int64_t kTemporaryAgeSeconds = 3600;
constexpr const char* kFormat = "chdash-mcp-usage";
constexpr const char kSuffix[] = ".jsonl.zst";

int64_t unix_now() {
  return static_cast<int64_t>(::time(nullptr));
}

std::string errno_text() { return std::generic_category().message(errno); }

// A bound as a person writes it: 128 MiB, 64 KiB, 100 bytes.
std::string size_text(size_t bytes) {
  constexpr size_t kib = 1024;
  constexpr size_t mib = 1024 * 1024;
  if (bytes != 0 && bytes % mib == 0) return std::to_string(bytes / mib) + " MiB";
  if (bytes != 0 && bytes % kib == 0) return std::to_string(bytes / kib) + " KiB";
  return std::to_string(bytes) + " bytes";
}

[[noreturn]] void bad(const std::string& what) { throw std::runtime_error(what); }

// The stop of the server. ChDash checks it while a file is read.
struct Cancelled {};

class Fd {
public:
  explicit Fd(int fd = -1) : fd_(fd) {}
  Fd(const Fd&) = delete;
  Fd& operator=(const Fd&) = delete;
  ~Fd() {
    if (fd_ >= 0) ::close(fd_);
  }
  int get() const { return fd_; }
  explicit operator bool() const { return fd_ >= 0; }

private:
  int fd_;
};

int64_t mtime_ns_of(const struct stat& info) {
#if defined(__APPLE__)
  return static_cast<int64_t>(info.st_mtimespec.tv_sec) * 1000000000 + info.st_mtimespec.tv_nsec;
#else
  return static_cast<int64_t>(info.st_mtim.tv_sec) * 1000000000 + info.st_mtim.tv_nsec;
#endif
}

bool write_all(int fd, const char* data, size_t size, std::string* error) {
  while (size > 0) {
    const ssize_t n = ::write(fd, data, size);
    if (n < 0) {
      if (errno == EINTR) continue;
      *error = "write: " + errno_text();
      return false;
    }
    data += n;
    size -= static_cast<size_t>(n);
  }
  return true;
}

// ---- read ------------------------------------------------------------------------------------------

// The lines of a zstd file are decompressed as they are read, within the bounds.
// Nothing is allocated for a line that is past 64 KiB. A stream that holds more than 512 MiB is stopped. A file that is read past 128 MiB is stopped too.
// Each message says what is wrong. No message holds any content.
class LineReader {
public:
  LineReader(int fd, const McpUsageFileLimits& limits) : fd_(fd), limits_(limits), in_(ZSTD_DStreamInSize()), out_(ZSTD_DStreamOutSize()) {
    dctx_ = ZSTD_createDCtx();
    if (!dctx_) bad("cannot start the decompression");
    ZSTD_DCtx_setParameter(dctx_, ZSTD_d_windowLogMax, static_cast<int>(kWindowLogMax));
  }
  LineReader(const LineReader&) = delete;
  LineReader& operator=(const LineReader&) = delete;
  ~LineReader() { ZSTD_freeDCtx(dctx_); }

  // The next line without its "\n"; false at the end of the file. The text lives until the next call.
  bool next(std::string_view* line) {
    while (true) {
      const size_t newline = pending_.find('\n', position_);
      if (newline != std::string::npos) {
        if (newline - position_ > limits_.max_line_bytes) too_long();
        if (newline == position_) bad("line " + std::to_string(lines_ + 1) + ": a line is empty");
        *line = std::string_view(pending_).substr(position_, newline - position_);
        position_ = newline + 1;
        ++lines_;
        return true;
      }
      if (pending_.size() - position_ > limits_.max_line_bytes) too_long();
      if (position_ > 0) {
        pending_.erase(0, position_);
        position_ = 0;
      }
      if (finished_) {
        if (pending_.empty()) return false;
        *line = std::string_view(pending_);  // the last line has no "\n"
        position_ = pending_.size();
        ++lines_;
        return true;
      }
      pump();
    }
  }

private:
  [[noreturn]] void too_long() const {
    bad("line " + std::to_string(lines_ + 1) + ": a line is longer than " + size_text(limits_.max_line_bytes));
  }

  // Decompresses until some output comes, or the file ends.
  void pump() {
    while (true) {
      if (input_.pos == input_.size) {
        const ssize_t n = ::read(fd_, in_.data(), in_.size());
        if (n < 0) {
          if (errno == EINTR) continue;
          bad("cannot read the file: " + errno_text());
        }
        if (n == 0) {
          // A frame that did not end is a file that was cut.
          if (started_ && last_ != 0) bad("the zstd stream is cut");
          finished_ = true;
          return;
        }
        read_ += static_cast<size_t>(n);
        if (read_ > limits_.max_compressed_bytes) bad("the file is larger than " + size_text(limits_.max_compressed_bytes));
        input_ = ZSTD_inBuffer{in_.data(), static_cast<size_t>(n), 0};
      }
      ZSTD_outBuffer output{out_.data(), out_.size(), 0};
      const size_t hint = ZSTD_decompressStream(dctx_, &output, &input_);
      if (ZSTD_isError(hint)) bad(std::string("not a zstd file: ") + ZSTD_getErrorName(hint));
      started_ = true;
      last_ = hint;
      if (output.pos > 0) {
        written_ += output.pos;
        if (written_ > limits_.max_decompressed_bytes) bad("the file holds more than " + size_text(limits_.max_decompressed_bytes) + " once decompressed");
        pending_.append(out_.data(), output.pos);
        return;
      }
    }
  }

  int fd_;
  McpUsageFileLimits limits_;
  ZSTD_DCtx* dctx_ = nullptr;
  std::vector<char> in_;
  std::vector<char> out_;
  ZSTD_inBuffer input_{nullptr, 0, 0};
  std::string pending_;
  size_t position_ = 0;
  size_t lines_ = 0;
  size_t read_ = 0;
  size_t written_ = 0;
  size_t last_ = 0;
  bool started_ = false;
  bool finished_ = false;
};

// One line as a JSON object. The document is reused: a file has up to millions of lines.
class LineParser {
public:
  LineParser() : alloc_(8192), doc_(&alloc_) {}
  const rapidjson::Value& parse(std::string_view line) {
    doc_.SetNull();
    alloc_.Clear();
    if (!parse_json_bounded<rapidjson::kParseValidateEncodingFlag>(doc_, line)) bad("not valid JSON");
    if (!doc_.IsObject()) bad("not a JSON object");
    return doc_;
  }

private:
  rapidjson::MemoryPoolAllocator<> alloc_;
  rapidjson::Document doc_;
};

const rapidjson::Value& field(const rapidjson::Value& object, const char* name) {
  const auto it = object.FindMember(name);
  if (it == object.MemberEnd()) bad(std::string(name) + " is missing");
  return it->value;
}

std::string_view text_of(const rapidjson::Value& object, const char* name, size_t max_bytes) {
  const rapidjson::Value& value = field(object, name);
  if (!value.IsString()) bad(std::string(name) + " must be text");
  if (value.GetStringLength() > max_bytes) bad(std::string(name) + " is too long");
  return std::string_view(value.GetString(), value.GetStringLength());
}

int64_t number_of(const rapidjson::Value& object, const char* name) {
  const rapidjson::Value& value = field(object, name);
  if (!value.IsInt64()) bad(std::string(name) + " must be a whole number");
  return value.GetInt64();
}

uint64_t count_of(const rapidjson::Value& object, const char* name) {
  const rapidjson::Value& value = field(object, name);
  if (!value.IsUint64()) bad(std::string(name) + " must be a count");
  return value.GetUint64();
}

// What the first line of a file says.
struct FileHeader {
  std::string instance;
  std::string boot;
  int64_t since = 0;
  int64_t written_at = 0;
  int64_t retention_days = 0;
};

FileHeader header_of(const rapidjson::Value& line) {
  if (text_of(line, "format", 32) != kFormat) bad(std::string("the format must be ") + kFormat);
  const rapidjson::Value& version = field(line, "version");
  if (!version.IsInt() || version.GetInt() != kMcpUsageFileVersion) bad("version must be 1");
  FileHeader header;
  header.instance = std::string(text_of(line, "instance", kInstanceBytes));
  header.boot = std::string(text_of(line, "boot", 64));
  if (!mcp_valid_usage_instance(header.instance)) bad("the instance of the header is not valid");
  if (!mcp_valid_usage_instance(header.boot)) bad("the boot of the header is not valid");
  header.since = number_of(line, "since");
  header.written_at = number_of(line, "written_at");
  header.retention_days = number_of(line, "retention_days");
  if (header.since <= 0) bad("since must be a Unix time");
  if (header.written_at <= 0) bad("written_at must be a Unix time");
  if (header.retention_days < 1 || header.retention_days > kMcpUsageMaxRetentionDays) bad("retention_days is not valid");
  return header;
}

// Reads the file of `instance` into `state`. It reads the header first, then the rows of the keys, their clients and their cells.
// Throws std::runtime_error with the line and the reason, never the content. Or it throws Cancelled.
FileHeader read_state(int fd, const std::string& instance, McpUsage::State* state, size_t max_clients, const std::atomic<bool>* cancel,
                      const McpUsageFileLimits& limits) {
  LineReader reader(fd, limits);
  LineParser parser;
  FileHeader header;
  bool have_header = false;
  size_t cells = 0;
  size_t number = 0;
  std::string_view line;
  while (reader.next(&line)) {
    ++number;
    if (cancel && (number & 4095) == 0 && cancel->load(std::memory_order_relaxed)) throw Cancelled();
    try {
      const rapidjson::Value& row = parser.parse(line);
      const std::string_view type = text_of(row, "type", 16);
      if (!have_header) {
        if (type != "header") bad("the first line must be the header");
        header = header_of(row);
        if (header.instance != instance) bad("the header names another instance");
        have_header = true;
        continue;
      }
      if (text_of(row, "instance", kInstanceBytes) != header.instance) bad("a line names another instance");
      if (type == "key") {
        McpUsageKeyRow out;
        out.key = text_of(row, "key", 32);
        out.name = text_of(row, "name", kMcpNameMaxBytes);
        out.host = text_of(row, "host", kHostBytes);
        out.source = text_of(row, "source", 16);
        out.first_used = number_of(row, "first_used");
        out.last_used = number_of(row, "last_used");
        out.deleted_at = number_of(row, "deleted_at");
        apply_key(*state, out, kMaxFileKeys);
      } else if (type == "client") {
        McpUsageClientRow out;
        out.key = text_of(row, "key", 32);
        out.name = text_of(row, "name", kClientNameBytes);
        out.version = text_of(row, "version", kClientVersionBytes);
        out.user_agent = text_of(row, "user_agent", kUserAgentBytes);
        out.first_seen = number_of(row, "first_seen");
        out.last_seen = number_of(row, "last_seen");
        out.requests = count_of(row, "requests");
        apply_client(*state, out, max_clients);
      } else if (type == "cell") {
        if (++cells > kMaxFileCells) bad("more than " + std::to_string(kMaxFileCells) + " cells");
        McpUsageCellRow out;
        out.key = text_of(row, "key", 32);
        out.tier = text_of(row, "tier", 8);
        out.start = number_of(row, "start");
        out.kind = text_of(row, "kind", 16);
        out.client = text_of(row, "client", kCellClientBytes);
        out.method = text_of(row, "method", kNameBytes);
        out.result = text_of(row, "result", kNameBytes);
        out.count = count_of(row, "count");
        out.duration_ms_sum = count_of(row, "duration_ms_sum");
        out.duration_ms_max = count_of(row, "duration_ms_max");
        out.rows = count_of(row, "rows");
        out.bytes = count_of(row, "bytes");
        apply_cell(*state, out);
      } else if (type == "header") {
        bad("a second header");
      } else {
        bad("a line of a type that is not known");
      }
    } catch (const Cancelled&) {
      throw;
    } catch (const std::exception& e) {
      throw std::runtime_error("line " + std::to_string(number) + ": " + e.what());
    }
  }
  if (!have_header) bad("the file has no header");
  finish_state(*state);
  state->since = header.since;
  state->written_at = header.written_at;
  return header;
}

// The header of a file, whatever else is in it: nullopt when there is none or it is not valid.
std::optional<FileHeader> read_header(const std::string& path, const McpUsageFileLimits& limits) {
  const Fd fd(::open(path.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW));
  if (!fd) return std::nullopt;
  struct stat info{};
  if (::fstat(fd.get(), &info) != 0 || !S_ISREG(info.st_mode)) return std::nullopt;
  try {
    LineReader reader(fd.get(), limits);
    LineParser parser;
    std::string_view line;
    if (!reader.next(&line)) return std::nullopt;
    const rapidjson::Value& row = parser.parse(line);
    if (text_of(row, "type", 16) != "header") return std::nullopt;
    return header_of(row);
  } catch (const std::exception&) {
    return std::nullopt;
  }
}

// The file of this instance, from the start: false when there is none; throws when it is not valid.
bool read_own_file(const std::string& path, const std::string& instance, McpUsage::State* state, size_t max_clients, FileHeader* header,
                   const McpUsageFileLimits& limits) {
  const Fd fd(::open(path.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW));
  if (!fd) {
    if (errno == ENOENT) return false;
    if (errno == ELOOP) bad("the file is a symbolic link");
    bad("cannot open the file: " + errno_text());
  }
  struct stat info{};
  if (::fstat(fd.get(), &info) != 0) bad("cannot read the file: " + errno_text());
  if (!S_ISREG(info.st_mode)) bad("not a regular file");
  if (static_cast<uint64_t>(info.st_size) > limits.max_compressed_bytes) bad("the file is larger than " + size_text(limits.max_compressed_bytes));
  *header = read_state(fd.get(), instance, state, max_clients, nullptr, limits);
  return true;
}

// The instance that a file name represents, when the name is a name of a usage file (<instance>.jsonl.zst).
std::optional<std::string> instance_of_file(const std::string& name) {
  const size_t suffix = sizeof(kSuffix) - 1;
  if (name.size() <= suffix || name.compare(name.size() - suffix, suffix, kSuffix) != 0) return std::nullopt;
  std::string instance = name.substr(0, name.size() - suffix);
  if (!mcp_valid_usage_instance(instance)) return std::nullopt;
  return instance;
}

// The names of a directory, or nullopt (with the reason) when it cannot be listed.
std::optional<std::vector<std::string>> list_directory(int dir_fd, std::string* error) {
  const int copy = ::dup(dir_fd);
  if (copy < 0) {
    *error = "cannot list the directory: " + errno_text();
    return std::nullopt;
  }
  DIR* dir = ::fdopendir(copy);
  if (!dir) {
    *error = "cannot list the directory: " + errno_text();
    ::close(copy);
    return std::nullopt;
  }
  ::rewinddir(dir);
  std::vector<std::string> names;
  errno = 0;
  while (const dirent* item = ::readdir(dir)) {
    names.emplace_back(item->d_name);
    errno = 0;
  }
  const int failure = errno;
  ::closedir(dir);
  if (failure != 0) {
    *error = std::string("cannot list the directory: ") + std::generic_category().message(failure);
    return std::nullopt;
  }
  return names;
}

// ---- write ------------------------------------------------------------------------------------------

// The rows of one save are written as lines of JSON. The lines are compressed with zstd into a temporary file of the directory.
// commit() ends the stream. It makes the file durable, and renames it over the file of the instance.
// So, the file is either the old one or the new one. It is never a part of either.
class FileWriter final : public McpUsageWriter {
public:
  FileWriter(int fd, std::string temporary, std::string target, std::string dir, std::string instance, std::string boot,
             const McpUsageHeader& header, const McpUsageFileLimits& limits, std::function<void(int64_t)> committed)
      : fd_(fd),
        temporary_(std::move(temporary)),
        target_(std::move(target)),
        dir_(std::move(dir)),
        instance_(std::move(instance)),
        header_(header),
        limits_(limits),
        committed_(std::move(committed)),
        output_(ZSTD_CStreamOutSize()) {
    cctx_ = ZSTD_createCCtx();
    if (!cctx_) {
      fail("cannot start the compression");
    } else {
      ZSTD_CCtx_setParameter(cctx_, ZSTD_c_compressionLevel, kZstdLevel);
      ZSTD_CCtx_setParameter(cctx_, ZSTD_c_checksumFlag, 1);
    }
    begin_line("header");
    w_.Key("format"); w_.String(kFormat);
    w_.Key("version"); w_.Int(kMcpUsageFileVersion);
    w_.Key("boot"); put(boot);
    w_.Key("since"); w_.Int64(header.since);
    w_.Key("written_at"); w_.Int64(header.written_at);
    w_.Key("retention_days"); w_.Int64(header.retention_days);
    end_line();
  }
  ~FileWriter() override {
    if (fd_ >= 0) ::close(fd_);
    if (!done_) ::unlink(temporary_.c_str());
    if (cctx_) ZSTD_freeCCtx(cctx_);
  }

  void key(const McpUsageKeyRow& row) override {
    begin_line("key");
    w_.Key("key"); put(row.key);
    w_.Key("name"); put(row.name);
    w_.Key("host"); put(row.host);
    w_.Key("source"); put(row.source);
    w_.Key("first_used"); w_.Int64(row.first_used);
    w_.Key("last_used"); w_.Int64(row.last_used);
    w_.Key("deleted_at"); w_.Int64(row.deleted_at);
    end_line();
  }
  void client(const McpUsageClientRow& row) override {
    begin_line("client");
    w_.Key("key"); put(row.key);
    w_.Key("name"); put(row.name);
    w_.Key("version"); put(row.version);
    w_.Key("user_agent"); put(row.user_agent);
    w_.Key("first_seen"); w_.Int64(row.first_seen);
    w_.Key("last_seen"); w_.Int64(row.last_seen);
    w_.Key("requests"); w_.Uint64(row.requests);
    end_line();
  }
  void cell(const McpUsageCellRow& row) override {
    begin_line("cell");
    w_.Key("key"); put(row.key);
    w_.Key("tier"); put(row.tier);
    w_.Key("start"); w_.Int64(row.start);
    w_.Key("kind"); put(row.kind);
    w_.Key("client"); put(row.client);
    w_.Key("method"); put(row.method);
    w_.Key("result"); put(row.result);
    w_.Key("count"); w_.Uint64(row.count);
    w_.Key("duration_ms_sum"); w_.Uint64(row.duration_ms_sum);
    w_.Key("duration_ms_max"); w_.Uint64(row.duration_ms_max);
    w_.Key("rows"); w_.Uint64(row.rows);
    w_.Key("bytes"); w_.Uint64(row.bytes);
    end_line();
  }

  void flush() override {
    if (failed_.empty() && !pending_.empty()) compress(pending_, ZSTD_e_continue);
    pending_.clear();
  }

  bool commit(std::string* error) override {
    if (done_) return true;
    flush();
    if (failed_.empty()) compress(std::string_view(), ZSTD_e_end);
    if (failed_.empty() && ::fsync(fd_) != 0) fail("fsync: " + errno_text());
    const int closed = ::close(fd_);
    fd_ = -1;
    if (closed != 0) fail("close: " + errno_text());
    if (failed_.empty() && ::rename(temporary_.c_str(), target_.c_str()) != 0) fail("rename: " + errno_text());
    if (!failed_.empty()) {
      ::unlink(temporary_.c_str());
      done_ = true;
      *error = failed_;
      return false;
    }
    done_ = true;
    // Make the rename itself durable. This is a best effort: the data is already in place.
    int flags = O_RDONLY | O_CLOEXEC;
#ifdef O_DIRECTORY
    flags |= O_DIRECTORY;
#endif
    const Fd dir(::open(dir_.c_str(), flags));
    if (dir) (void)::fsync(dir.get());
    if (committed_) committed_(header_.written_at);
    return true;
  }
  size_t bytes() const override { return bytes_; }

private:
  void put(std::string_view text) { write_json_text(w_, text); }

  void begin_line(const char* type) {
    sb_.Clear();
    w_.Reset(sb_);
    w_.StartObject();
    w_.Key("type"); w_.String(type);
    w_.Key("instance"); put(instance_);
  }
  void end_line() {
    w_.EndObject();
    if (!failed_.empty()) return;
    pending_.append(sb_.GetString(), sb_.GetSize());
    pending_.push_back('\n');
    bytes_ += sb_.GetSize() + 1;
    if (bytes_ > limits_.max_decompressed_bytes) fail("the usage is larger than " + size_text(limits_.max_decompressed_bytes));
  }
  void fail(const std::string& what) {
    if (failed_.empty()) failed_ = what;
  }
  // The compression of `data`. The output is written to the file as it comes out. ZSTD_e_end ends the frame.
  void compress(std::string_view data, ZSTD_EndDirective mode) {
    ZSTD_inBuffer input{data.data(), data.size(), 0};
    bool finished = false;
    while (!finished) {
      ZSTD_outBuffer output{output_.data(), output_.size(), 0};
      const size_t remaining = ZSTD_compressStream2(cctx_, &output, &input, mode);
      if (ZSTD_isError(remaining)) {
        fail(std::string("compression: ") + ZSTD_getErrorName(remaining));
        return;
      }
      if (output.pos > 0) {
        compressed_ += output.pos;
        if (compressed_ > limits_.max_compressed_bytes) {
          fail("the usage is larger than " + size_text(limits_.max_compressed_bytes) + " once compressed");
          return;
        }
        std::string error;
        if (!write_all(fd_, output_.data(), output.pos, &error)) {
          fail(error);
          return;
        }
      }
      finished = mode == ZSTD_e_end ? remaining == 0 : input.pos == input.size;
    }
  }

  int fd_;
  std::string temporary_;
  std::string target_;
  std::string dir_;
  std::string instance_;
  McpUsageHeader header_;
  McpUsageFileLimits limits_;
  std::function<void(int64_t)> committed_;
  ZSTD_CCtx* cctx_ = nullptr;
  std::vector<char> output_;
  rapidjson::StringBuffer sb_;
  rapidjson::Writer<rapidjson::StringBuffer> w_{sb_};
  std::string pending_;
  std::string failed_;
  size_t bytes_ = 0;
  size_t compressed_ = 0;
  bool done_ = false;
};

} // namespace

// ---- the files mode -------------------------------------------------------------------------------------

McpUsageFileStore::McpUsageFileStore(std::string dir, std::string instance, McpUsageFileLimits limits)
    : dir_(std::move(dir)), instance_(std::move(instance)), limits_(limits), boot_(random_uuid_v4()) {
  while (dir_.size() > 1 && dir_.back() == '/') dir_.pop_back();
  // Anyone who can write in the directory can plant a file that another instance reads. That person can also remove a file.
  // The sticky bit keeps each user to its own files.
  struct stat info{};
  if (::stat(dir_.c_str(), &info) == 0 && S_ISDIR(info.st_mode) && (info.st_mode & S_IWOTH) && !(info.st_mode & S_ISVTX)) {
    log_event(LogLevel::Warn, "mcp.usage_dir_writable_by_all", {{"dir", dir_}});
  }
}

std::string McpUsageFileStore::file_name(const std::string& instance) { return instance + kSuffix; }

std::string McpUsageFileStore::path_of(const std::string& instance) const { return dir_ + "/" + file_name(instance); }

// The temporary files of a save that a crash left (.<instance>.<16 hexadecimal digits>.tmp). ChDash removes only the files of this instance. It removes only the files that are old.
void McpUsageFileStore::remove_old_temporaries() {
  const Fd dir(::open(dir_.c_str(), O_RDONLY | O_CLOEXEC | O_DIRECTORY));
  if (!dir) return;
  std::string error;
  const auto names = list_directory(dir.get(), &error);
  if (!names) return;
  const std::string prefix = "." + instance_ + ".";
  const std::string tail = ".tmp";
  for (const std::string& name : *names) {
    if (name.size() != prefix.size() + 16 + tail.size() || name.compare(0, prefix.size(), prefix) != 0 ||
        name.compare(name.size() - tail.size(), tail.size(), tail) != 0) {
      continue;
    }
    const std::string digits = name.substr(prefix.size(), 16);
    if (!std::all_of(digits.begin(), digits.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); })) continue;
    struct stat info{};
    if (::fstatat(dir.get(), name.c_str(), &info, AT_SYMLINK_NOFOLLOW) != 0 || !S_ISREG(info.st_mode)) continue;
    if (unix_now() - mtime_ns_of(info) / 1000000000 < kTemporaryAgeSeconds) continue;
    (void)::unlinkat(dir.get(), name.c_str(), 0);
  }
}

bool McpUsageFileStore::load(McpUsage::State* state, size_t max_clients) {
  remove_old_temporaries();
  FileHeader header;
  if (!read_own_file(path_of(instance_), instance_, state, max_clients, &header, limits_)) return false;
  std::lock_guard<std::mutex> lock(mu_);
  seen_boot_ = header.boot;
  seen_written_at_ = header.written_at;
  seen_file_ = true;
  return true;
}

std::unique_ptr<McpUsageWriter> McpUsageFileStore::begin(const McpUsageHeader& header, McpUsageSaveStatus* status, std::string* error) {
  *status = McpUsageSaveStatus::Failed;
  // Another process writes this name when its file has a boot that is not ours, and it was written less than 2 minutes ago.
  // A file that is as this process last saw it (a start that follows a stop) belongs to nobody. The process that wrote it is gone.
  {
    const auto current = read_header(path_of(instance_), limits_);
    std::lock_guard<std::mutex> lock(mu_);
    if (current && current->boot != boot_) {
      const bool as_seen = seen_file_ && current->boot == seen_boot_ && current->written_at == seen_written_at_;
      if (!as_seen && header.written_at - current->written_at < kConflictSeconds) {
        if (conflict_with_ != current->boot) {
          conflict_with_ = current->boot;
          log_event(LogLevel::Error, "mcp.usage_instance_conflict",
                    {{"instance", instance_}, {"dir", dir_}, {"other_written_at", mcp_iso_utc(current->written_at)}});
        }
        *status = McpUsageSaveStatus::Conflict;
        *error = "another process writes the file of this instance";
        return nullptr;
      }
    }
    conflict_with_.clear();
  }
  const std::string temporary = dir_ + "/." + instance_ + "." + random_hex(8) + ".tmp";
  int flags = O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW;
  const int fd = ::open(temporary.c_str(), flags, S_IRUSR | S_IWUSR);
  if (fd < 0) {
    *error = "cannot create the temporary file: " + errno_text();
    return nullptr;
  }
  if (::fchmod(fd, S_IRUSR | S_IWUSR) != 0) {
    *error = "fchmod: " + errno_text();
    ::close(fd);
    ::unlink(temporary.c_str());
    return nullptr;
  }
  auto committed = [this](int64_t written_at) {
    std::lock_guard<std::mutex> lock(mu_);
    seen_boot_ = boot_;
    seen_written_at_ = written_at;
    seen_file_ = true;
  };
  *status = McpUsageSaveStatus::Ok;
  return std::make_unique<FileWriter>(fd, temporary, path_of(instance_), dir_, instance_, boot_, header, limits_, std::move(committed));
}

bool McpUsageFileStore::refresh(std::vector<McpUsage::Other>* others, size_t max_clients, const std::atomic<bool>& cancel) {
  const Fd dir(::open(dir_.c_str(), O_RDONLY | O_CLOEXEC | O_DIRECTORY));
  std::string error;
  std::optional<std::vector<std::string>> listed;
  if (dir) listed = list_directory(dir.get(), &error);
  else error = "cannot open the directory: " + errno_text();
  std::lock_guard<std::mutex> lock(files_mu_);
  if (!listed) {
    if (refresh_error_ != error) {
      refresh_error_ = error;
      log_event(LogLevel::Error, "mcp.usage_refresh_failed", {{"dir", dir_}, {"error", error}});
    }
    return false;
  }
  std::vector<std::string> instances;
  for (const std::string& name : *listed) {
    const auto instance = instance_of_file(name);
    if (instance && *instance != instance_) instances.push_back(*instance);
  }
  std::sort(instances.begin(), instances.end());
  instances.erase(std::unique(instances.begin(), instances.end()), instances.end());
  // A directory that holds more files than the bound is not read past it. The first instances by name are read.
  // The first instance that is not read is logged once.
  std::string crowded;
  if (instances.size() > kMaxInstances) {
    crowded = instances[kMaxInstances];
    instances.resize(kMaxInstances);
  }
  if (crowded != crowded_) {
    crowded_ = crowded;
    if (!crowded.empty()) {
      log_event(LogLevel::Error, "mcp.usage_file_skipped",
                {{"instance", crowded}, {"file", file_name(crowded)},
                 {"reason", "more than " + std::to_string(kMaxInstances) + " instances: this one and the next ones are not read"}});
    }
  }
  refresh_error_.clear();

  std::map<std::string, Seen> next;
  for (const std::string& instance : instances) {
    if (cancel.load(std::memory_order_relaxed)) return false;
    const std::string name = file_name(instance);
    struct stat listing{};
    if (::fstatat(dir.get(), name.c_str(), &listing, AT_SYMLINK_NOFOLLOW) != 0 || !S_ISREG(listing.st_mode)) continue;
    const auto previous = files_.find(instance);
    if (previous != files_.end() && previous->second.known && previous->second.mtime_ns == mtime_ns_of(listing) &&
        previous->second.size == static_cast<int64_t>(listing.st_size)) {
      next.emplace(instance, previous->second);
      continue;
    }
    Seen seen;
    seen.other.instance = instance;
    seen.other.status = "skipped";
    const std::string logged = previous == files_.end() ? std::string() : previous->second.logged;
    const Fd fd(::openat(dir.get(), name.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW));
    if (!fd) {
      if (errno == ENOENT || errno == ELOOP) continue;  // gone since the listing, or a link: not a file of an instance
      seen.other.reason = "cannot open the file: " + errno_text();
    } else {
      struct stat info{};
      if (::fstat(fd.get(), &info) != 0 || !S_ISREG(info.st_mode)) continue;
      seen.mtime_ns = mtime_ns_of(info);
      seen.size = static_cast<int64_t>(info.st_size);
      seen.known = true;
      if (static_cast<uint64_t>(info.st_size) > limits_.max_compressed_bytes) {
        seen.other.reason = "the file is larger than " + size_text(limits_.max_compressed_bytes);
      } else {
        try {
          auto state = std::make_shared<McpUsage::State>();
          const FileHeader header = read_state(fd.get(), instance, state.get(), max_clients, &cancel, limits_);
          seen.other.status = "ok";
          seen.other.written_at = header.written_at;
          seen.other.since = header.since;
          seen.other.state = std::move(state);
        } catch (const Cancelled&) {
          return false;
        } catch (const std::exception& e) {
          seen.other.reason = e.what();
        }
      }
    }
    // A reason is logged when the file changed. The answer is kept while the file does not change.
    // A reason from the system is logged too, when it is not the one that was logged. The file cannot be opened, so it is asked again every time.
    if (seen.other.status != "ok" && (seen.known || seen.other.reason != logged)) {
      log_event(LogLevel::Error, "mcp.usage_file_skipped", {{"instance", instance}, {"file", name}, {"reason", seen.other.reason}});
    }
    seen.logged = seen.other.status == "ok" ? std::string() : seen.other.reason;
    next.emplace(instance, std::move(seen));
  }
  files_ = std::move(next);
  others->clear();
  for (const auto& item : files_) others->push_back(item.second.other);
  return true;
}

void McpUsageFileStore::prune(int64_t now, int64_t retention_days) {
  const int64_t limit = (retention_days + 1) * kDay;
  const Fd dir(::open(dir_.c_str(), O_RDONLY | O_CLOEXEC | O_DIRECTORY));
  if (!dir) return;
  std::lock_guard<std::mutex> lock(files_mu_);
  for (auto it = files_.begin(); it != files_.end();) {
    const Seen& seen = it->second;
    // Only a file that was read as a usage file is removed. Another file is never removed.
    // The header and the file are both older than the retention and a day. A live instance writes every minute when something changes. A file that was written again is read again first.
    const bool old = seen.other.status == "ok" && seen.known && now - seen.other.written_at > limit && now - seen.mtime_ns / 1000000000 > limit;
    if (!old) {
      ++it;
      continue;
    }
    const std::string name = file_name(it->first);
    struct stat info{};
    const bool as_read = ::fstatat(dir.get(), name.c_str(), &info, AT_SYMLINK_NOFOLLOW) == 0 && S_ISREG(info.st_mode) &&
                         mtime_ns_of(info) == seen.mtime_ns && static_cast<int64_t>(info.st_size) == seen.size;
    if (as_read && ::unlinkat(dir.get(), name.c_str(), 0) == 0) {
      log_event(LogLevel::Info, "mcp.usage_file_removed",
                {{"instance", it->first}, {"file", name}, {"written_at", mcp_iso_utc(seen.other.written_at)}});
      it = files_.erase(it);
      continue;
    }
    ++it;
  }
}

// ---- the checks of the start ------------------------------------------------------------------------------

void mcp_check_usage_dir(const std::string& dir, const std::string& instance) {
  if (dir.empty()) bad("the directory is not set");
  struct stat info{};
  if (::stat(dir.c_str(), &info) != 0) {
    if (errno == ENOENT || errno == ENOTDIR) bad("the directory does not exist");
    bad("the directory cannot be read: " + errno_text());
  }
  if (!S_ISDIR(info.st_mode)) bad("it is not a directory");
  // First, check the file of this instance. It is never replaced when it is not valid, whatever the rights on the directory. Then, check the rights.
  McpUsage::State state;
  FileHeader header;
  const std::string name = McpUsageFileStore::file_name(instance);
  try {
    read_own_file(dir + "/" + name, instance, &state, McpUsageOptions().max_clients, &header, McpUsageFileLimits{});
  } catch (const std::exception& e) {
    throw std::runtime_error(name + ": " + e.what() + " (the file is not changed)");
  }
  if (::access(dir.c_str(), W_OK | X_OK) != 0) bad("ChDash cannot create files in it: " + errno_text());
}

std::string mcp_usage_host_name() {
  char name[256] = {};
  if (::gethostname(name, sizeof(name) - 1) != 0) return {};
  return name;
}

} // namespace chdash
