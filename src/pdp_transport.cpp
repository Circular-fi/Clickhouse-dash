#include "access_pdp.hpp"

#include "telemetry_settings.hpp"

#include <arpa/inet.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

#include <algorithm>
#include <cctype>
#include <cerrno>
#include <csignal>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <mutex>
#include <string_view>

#ifdef CHDASH_HAVE_TLS
#include <openssl/err.h>
#include <openssl/ssl.h>
#include <openssl/x509.h>
#include <openssl/x509v3.h>
#endif

// The transport of the PDP (docs/access.md, "Transport"): HTTP/1.1 over a socket, with TLS for https. It does not use cpp-httplib: the
// client of httplib has no single deadline for the connect, the write and the read, it sends a request again on its own after a lost
// connection (ProcurAuth 10.6 forbids that for a question with usage), and its TLS support needs the OpenSSL headers in every file that
// includes it. This client has one small job: a POST or a GET with a bounded answer.

// Linux has SOCK_CLOEXEC, SOCK_NONBLOCK and MSG_NOSIGNAL. macOS has none of them: it sets the flags with fcntl and the option
// SO_NOSIGPIPE, and a send there has no flag for SIGPIPE.
#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0
#endif

namespace chdash {
namespace {

using Clock = std::chrono::steady_clock;

// A non-blocking socket that a child process does not inherit, and that does not raise SIGPIPE. -1 and errno when it fails.
int open_socket(const addrinfo* a) {
#if defined(SOCK_CLOEXEC) && defined(SOCK_NONBLOCK)
  const int fd = ::socket(a->ai_family, a->ai_socktype | SOCK_CLOEXEC | SOCK_NONBLOCK, a->ai_protocol);
  if (fd < 0) return -1;
#else
  const int fd = ::socket(a->ai_family, a->ai_socktype, a->ai_protocol);
  if (fd < 0) return -1;
  const int fd_flags = ::fcntl(fd, F_GETFD);
  const int status_flags = ::fcntl(fd, F_GETFL);
  if (fd_flags < 0 || status_flags < 0 || ::fcntl(fd, F_SETFD, fd_flags | FD_CLOEXEC) < 0 ||
      ::fcntl(fd, F_SETFL, status_flags | O_NONBLOCK) < 0) {
    const int saved = errno;
    ::close(fd);
    errno = saved;
    return -1;
  }
#endif
#ifdef SO_NOSIGPIPE
  const int one = 1;
  ::setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
#endif
  return fd;
}

// The largest head of a response (the status line and the headers).
constexpr size_t kMaxHeadBytes = 32 * 1024;

std::string lower_ascii(std::string_view text) {
  std::string out(text);
  std::transform(out.begin(), out.end(), out.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return out;
}

std::string_view trim_blank(std::string_view text) {
  while (!text.empty() && (text.front() == ' ' || text.front() == '\t')) text.remove_prefix(1);
  while (!text.empty() && (text.back() == ' ' || text.back() == '\t')) text.remove_suffix(1);
  return text;
}

// ---- the wait for a socket, with one deadline ------------------------------------------------------------------------------

// true: the socket is ready for `events`. false: the deadline passed, or poll failed (`timed_out` tells which).
bool wait_fd(int fd, short events, Clock::time_point deadline, bool* timed_out) {
  for (;;) {
    const auto now = Clock::now();
    if (now >= deadline) {
      *timed_out = true;
      return false;
    }
    const auto left = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now).count() + 1;
    pollfd p{};
    p.fd = fd;
    p.events = events;
    const int r = ::poll(&p, 1, static_cast<int>(std::min<int64_t>(left, 60 * 1000)));
    if (r > 0) return true;
    if (r < 0 && errno != EINTR) {
      *timed_out = false;
      return false;
    }
  }
}

#ifdef CHDASH_HAVE_TLS
// The text of the first error of the OpenSSL queue of this thread; the queue is empty after it.
std::string openssl_error_text() {
  const unsigned long code = ERR_get_error();
  ERR_clear_error();
  if (code == 0) return "no detail";
  char buffer[256];
  ERR_error_string_n(code, buffer, sizeof(buffer));
  return buffer;
}

bool is_ip_literal(const std::string& host) {
  unsigned char buffer[sizeof(in6_addr)];
  return ::inet_pton(AF_INET, host.c_str(), buffer) == 1 || ::inet_pton(AF_INET6, host.c_str(), buffer) == 1;
}

struct SslCtxDeleter {
  void operator()(SSL_CTX* ctx) const { SSL_CTX_free(ctx); }
};
using SslCtxPtr = std::unique_ptr<SSL_CTX, SslCtxDeleter>;

// The context of the client: TLS 1.2 or later, and the check of the chain. A `ca_file` is the only source of CAs; without it the store of the
// system. SSL_CTX_set_default_verify_paths would also read SSL_CERT_FILE and SSL_CERT_DIR (the rule: the file is the only source), so the
// two default paths of the build are loaded by name.
SslCtxPtr make_ssl_ctx(const PdpTransportOptions& options, std::string* error) {
  // The configuration of OpenSSL (OPENSSL_CONF) is not read.
  OPENSSL_init_ssl(OPENSSL_INIT_NO_LOAD_CONFIG, nullptr);
  SslCtxPtr ctx(SSL_CTX_new(TLS_client_method()));
  if (!ctx) {
    *error = "OpenSSL cannot make a TLS context: " + openssl_error_text();
    return nullptr;
  }
  SSL_CTX_set_min_proto_version(ctx.get(), TLS1_2_VERSION);
  // A peer that closes without close_notify is a plain end of the stream: the length of the body tells if the answer is whole.
  SSL_CTX_set_options(ctx.get(), SSL_OP_NO_COMPRESSION | SSL_OP_IGNORE_UNEXPECTED_EOF);
  if (!options.verify) {
    SSL_CTX_set_verify(ctx.get(), SSL_VERIFY_NONE, nullptr);
    return ctx;
  }
  SSL_CTX_set_verify(ctx.get(), SSL_VERIFY_PEER, nullptr);
  if (!options.ca_file.empty()) {
    if (SSL_CTX_load_verify_file(ctx.get(), options.ca_file.c_str()) != 1) {
      *error = "OpenSSL cannot read a certificate in the file " + options.ca_file + ": " + openssl_error_text();
      return nullptr;
    }
    return ctx;
  }
  // The file and the directory of the system. Each can be absent: the store is what exists.
  SSL_CTX_load_verify_file(ctx.get(), X509_get_default_cert_file());
  SSL_CTX_load_verify_dir(ctx.get(), X509_get_default_cert_dir());
  ERR_clear_error();
  return ctx;
}
#endif

// ---- one connection ------------------------------------------------------------------------------------------------------

class Connection {
public:
  Connection() = default;
  Connection(const Connection&) = delete;
  Connection& operator=(const Connection&) = delete;
  ~Connection() { close(); }

  bool connect_to(const PdpUrl& url, void* ssl_ctx, bool verify, Clock::time_point deadline, std::string* error) {
    bool timed_out = false;
    addrinfo hints{};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    addrinfo* list = nullptr;
    // The lookup of a name has no deadline of its own: it ends when the resolver answers.
    const int rc = ::getaddrinfo(url.host.c_str(), std::to_string(url.port).c_str(), &hints, &list);
    if (rc != 0 || !list) {
      *error = std::string("cannot resolve ") + url.host + ": " + ::gai_strerror(rc);
      return false;
    }
    std::string last = "no address";
    for (const addrinfo* a = list; a; a = a->ai_next) {
      if (Clock::now() >= deadline) {
        last = "timeout";
        break;
      }
      const int fd = open_socket(a);
      if (fd < 0) {
        last = std::string("socket: ") + std::strerror(errno);
        continue;
      }
      int rc2 = ::connect(fd, a->ai_addr, a->ai_addrlen);
      if (rc2 < 0 && errno == EINPROGRESS) {
        if (!wait_fd(fd, POLLOUT, deadline, &timed_out)) {
          ::close(fd);
          last = timed_out ? "timeout" : "poll failed";
          if (timed_out) break;
          continue;
        }
        int so_error = 0;
        socklen_t len = sizeof(so_error);
        ::getsockopt(fd, SOL_SOCKET, SO_ERROR, &so_error, &len);
        if (so_error != 0) {
          errno = so_error;
          rc2 = -1;
        } else {
          rc2 = 0;
        }
      }
      if (rc2 < 0) {
        last = std::string("connect: ") + std::strerror(errno);
        ::close(fd);
        continue;
      }
      fd_ = fd;
      break;
    }
    ::freeaddrinfo(list);
    if (fd_ < 0) {
      *error = last == "timeout" ? "timeout in the connect" : last;
      return false;
    }
    int one = 1;
    ::setsockopt(fd_, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
    if (!url.https) return true;
#ifdef CHDASH_HAVE_TLS
    ssl_ = SSL_new(static_cast<SSL_CTX*>(ssl_ctx));
    if (!ssl_) {
      *error = "OpenSSL cannot make a TLS session: " + openssl_error_text();
      close();
      return false;
    }
    SSL_set_fd(ssl_, fd_);
    if (verify) {
      // The name in the certificate must be the name of the address (RFC 6125). An IP address is checked against the IP entries.
      if (is_ip_literal(url.host)) {
        if (X509_VERIFY_PARAM_set1_ip_asc(SSL_get0_param(ssl_), url.host.c_str()) != 1) {
          *error = "OpenSSL cannot set the IP address for the check of the certificate";
          close();
          return false;
        }
      } else {
        SSL_set_hostflags(ssl_, X509_CHECK_FLAG_NO_PARTIAL_WILDCARDS);
        if (SSL_set1_host(ssl_, url.host.c_str()) != 1) {
          *error = "OpenSSL cannot set the host name for the check of the certificate";
          close();
          return false;
        }
      }
    }
    if (!is_ip_literal(url.host)) SSL_set_tlsext_host_name(ssl_, url.host.c_str());
    for (;;) {
      const int r = SSL_connect(ssl_);
      if (r == 1) break;
      const int e = SSL_get_error(ssl_, r);
      if (e == SSL_ERROR_WANT_READ || e == SSL_ERROR_WANT_WRITE) {
        if (!wait_fd(fd_, e == SSL_ERROR_WANT_READ ? POLLIN : POLLOUT, deadline, &timed_out)) {
          *error = timed_out ? "timeout in the TLS handshake" : "poll failed";
          close();
          return false;
        }
        continue;
      }
      std::string text = "TLS handshake failed";
      const long verify_result = SSL_get_verify_result(ssl_);
      if (verify_result != X509_V_OK) text += std::string(": the certificate of the PDP is not valid: ") + X509_verify_cert_error_string(verify_result);
      else text += ": " + openssl_error_text();
      ERR_clear_error();
      *error = text;
      close();
      return false;
    }
    return true;
#else
    (void)ssl_ctx;
    (void)verify;
    *error = "this build has no TLS client";
    close();
    return false;
#endif
  }

  void close() {
#ifdef CHDASH_HAVE_TLS
    if (ssl_) {
      // No close_notify: the peer may be gone, and the shutdown would write on the socket.
      SSL_free(ssl_);
      ssl_ = nullptr;
    }
#endif
    if (fd_ >= 0) {
      ::close(fd_);
      fd_ = -1;
    }
  }

  // false when the peer closed the connection or sent bytes that nobody asked for (an idle connection must have none).
  bool still_usable() const {
    if (fd_ < 0) return false;
    char byte;
    const ssize_t r = ::recv(fd_, &byte, 1, MSG_PEEK | MSG_DONTWAIT);
    if (r == 0) return false;
    if (r > 0) return false;
    return errno == EAGAIN || errno == EWOULDBLOCK;
  }

  // 1: the whole buffer is written. 0: timeout. -1: error.
  int write_all(const char* data, size_t size, Clock::time_point deadline, std::string* error) {
    size_t done = 0;
    bool timed_out = false;
    while (done < size) {
#ifdef CHDASH_HAVE_TLS
      if (ssl_) {
        const int r = SSL_write(ssl_, data + done, static_cast<int>(std::min<size_t>(size - done, 1 << 20)));
        if (r > 0) {
          done += static_cast<size_t>(r);
          continue;
        }
        const int e = SSL_get_error(ssl_, r);
        if (e == SSL_ERROR_WANT_READ || e == SSL_ERROR_WANT_WRITE) {
          if (!wait_fd(fd_, e == SSL_ERROR_WANT_READ ? POLLIN : POLLOUT, deadline, &timed_out)) {
            *error = timed_out ? "timeout in the write" : "poll failed";
            return timed_out ? 0 : -1;
          }
          continue;
        }
        *error = "write failed: " + openssl_error_text();
        return -1;
      }
#endif
      const ssize_t r = ::send(fd_, data + done, size - done, MSG_NOSIGNAL);
      if (r > 0) {
        done += static_cast<size_t>(r);
        continue;
      }
      if (r < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
        if (!wait_fd(fd_, POLLOUT, deadline, &timed_out)) {
          *error = timed_out ? "timeout in the write" : "poll failed";
          return timed_out ? 0 : -1;
        }
        continue;
      }
      if (r < 0 && errno == EINTR) continue;
      *error = std::string("write failed: ") + std::strerror(errno);
      return -1;
    }
    return 1;
  }

  // The bytes that came: > 0. 0: the peer closed the connection. -1: error. -2: timeout.
  ssize_t read_some(char* buffer, size_t size, Clock::time_point deadline, std::string* error) {
    bool timed_out = false;
    for (;;) {
#ifdef CHDASH_HAVE_TLS
      if (ssl_) {
        const int r = SSL_read(ssl_, buffer, static_cast<int>(std::min<size_t>(size, 1 << 20)));
        if (r > 0) return r;
        const int e = SSL_get_error(ssl_, r);
        if (e == SSL_ERROR_WANT_READ || e == SSL_ERROR_WANT_WRITE) {
          if (!wait_fd(fd_, e == SSL_ERROR_WANT_READ ? POLLIN : POLLOUT, deadline, &timed_out)) {
            *error = timed_out ? "timeout in the read" : "poll failed";
            return timed_out ? -2 : -1;
          }
          continue;
        }
        if (e == SSL_ERROR_ZERO_RETURN || (e == SSL_ERROR_SYSCALL && r == 0)) {
          ERR_clear_error();
          return 0;
        }
        *error = "read failed: " + openssl_error_text();
        return -1;
      }
#endif
      const ssize_t r = ::recv(fd_, buffer, size, 0);
      if (r >= 0) return r;
      if (errno == EAGAIN || errno == EWOULDBLOCK) {
        if (!wait_fd(fd_, POLLIN, deadline, &timed_out)) {
          *error = timed_out ? "timeout in the read" : "poll failed";
          return timed_out ? -2 : -1;
        }
        continue;
      }
      if (errno == EINTR) continue;
      *error = std::string("read failed: ") + std::strerror(errno);
      return -1;
    }
  }

  Clock::time_point idle_since{};
  bool reused = false;

private:
  int fd_ = -1;
#ifdef CHDASH_HAVE_TLS
  SSL* ssl_ = nullptr;
#endif
};

// ---- the response --------------------------------------------------------------------------------------------------------

struct ResponseHead {
  int status = 0;
  bool http11 = false;
  bool close = false;  // Connection: close
  bool chunked = false;
  bool has_length = false;
  uint64_t length = 0;
  std::optional<std::string> request_id;
};

// Parses the lines of a head that ends with CRLF CRLF. false, with `error`, when it is not a response that this client accepts.
bool parse_head(std::string_view head, ResponseHead* out, std::string* error) {
  *out = ResponseHead{};
  size_t pos = head.find("\r\n");
  if (pos == std::string_view::npos) {
    *error = "bad response: no status line";
    return false;
  }
  const std::string_view line = head.substr(0, pos);
  // "HTTP/1.1 200 OK"
  if (line.size() < 12 || (line.substr(0, 8) != "HTTP/1.1" && line.substr(0, 8) != "HTTP/1.0") || line[8] != ' ') {
    *error = "bad response: the status line is not HTTP/1.x";
    return false;
  }
  out->http11 = line.substr(0, 8) == "HTTP/1.1";
  const std::string_view code = line.substr(9, 3);
  if (!std::all_of(code.begin(), code.end(), [](char c) { return c >= '0' && c <= '9'; }) || (line.size() > 12 && line[12] != ' ')) {
    *error = "bad response: the status code is not a number";
    return false;
  }
  out->status = std::stoi(std::string(code));
  bool length_seen = false;
  pos += 2;
  while (pos < head.size()) {
    size_t end = head.find("\r\n", pos);
    if (end == std::string_view::npos) end = head.size();
    const std::string_view header = head.substr(pos, end - pos);
    pos = end + 2;
    if (header.empty()) break;
    const size_t colon = header.find(':');
    if (colon == std::string_view::npos || colon == 0) {
      *error = "bad response: a header has no name";
      return false;
    }
    const std::string name = lower_ascii(header.substr(0, colon));
    const std::string_view value = trim_blank(header.substr(colon + 1));
    if (name == "content-length") {
      if (value.empty() || value.size() > 18 || !std::all_of(value.begin(), value.end(), [](char c) { return c >= '0' && c <= '9'; })) {
        *error = "bad response: Content-Length is not a number";
        return false;
      }
      const uint64_t length = std::stoull(std::string(value));
      if (length_seen && length != out->length) {
        *error = "bad response: two different Content-Length headers";
        return false;
      }
      length_seen = true;
      out->has_length = true;
      out->length = length;
    } else if (name == "transfer-encoding") {
      const std::string coding = lower_ascii(value);
      if (coding != "chunked") {
        *error = "bad response: a transfer coding that this client does not read";
        return false;
      }
      out->chunked = true;
    } else if (name == "connection") {
      const std::string tokens = lower_ascii(value);
      if (tokens.find("close") != std::string::npos) out->close = true;
    } else if (name == "x-request-id") {
      out->request_id = std::string(value);
    }
  }
  if (out->chunked && out->has_length) {
    *error = "bad response: Content-Length with a chunked body";
    return false;
  }
  return true;
}

// Reads from the connection into `buffer` until it has `want` more bytes than `have`, or the stream ends. 1: ok, 0: the stream ended, -1:
// error, -2: timeout.
int fill(Connection& conn, std::string* buffer, Clock::time_point deadline, std::string* error) {
  char chunk[16 * 1024];
  const ssize_t r = conn.read_some(chunk, sizeof(chunk), deadline, error);
  if (r > 0) {
    buffer->append(chunk, static_cast<size_t>(r));
    return 1;
  }
  return r == 0 ? 0 : static_cast<int>(r);
}

enum class Outcome { Done, NoByte, Failed };

bool header_value_ok(const std::string& text) {
  return std::none_of(text.begin(), text.end(), [](unsigned char c) { return c == '\r' || c == '\n' || c == 0; });
}

class HttpTransport final : public PdpTransport {
public:
  HttpTransport(PdpTransportOptions options, void* ssl_ctx)
      : options_(std::move(options)), idle_close_(options_.idle_close), ssl_ctx_(ssl_ctx) {}

  ~HttpTransport() override {
    idle_.clear();
#ifdef CHDASH_HAVE_TLS
    if (ssl_ctx_) SSL_CTX_free(static_cast<SSL_CTX*>(ssl_ctx_));
#endif
  }

  PdpHttpResult post(const std::string& path, const std::string& body, const std::vector<std::pair<std::string, std::string>>& headers,
                     std::chrono::milliseconds timeout) override {
    return exchange("POST", path, &body, headers, timeout, true);
  }
  PdpHttpResult post_once(const std::string& path, const std::string& body, const std::vector<std::pair<std::string, std::string>>& headers,
                          std::chrono::milliseconds timeout) override {
    return exchange("POST", path, &body, headers, timeout, false);
  }
  PdpHttpResult get(const std::string& path, const std::vector<std::pair<std::string, std::string>>& headers, std::chrono::milliseconds timeout) override {
    return exchange("GET", path, nullptr, headers, timeout, true);
  }
  void set_idle_close(std::chrono::milliseconds idle) override {
    std::lock_guard<std::mutex> lock(mu_);
    idle_close_ = idle;
  }

private:
  std::string host_header() const {
    const PdpUrl& url = options_.url;
    std::string out = url.host.find(':') != std::string::npos ? "[" + url.host + "]" : url.host;
    if (url.port != (url.https ? 443 : 80)) out += ":" + std::to_string(url.port);
    return out;
  }

  std::string build_request(const char* method, const std::string& path, const std::string* body,
                            const std::vector<std::pair<std::string, std::string>>& headers, std::string* error) const {
    if (path.empty() || path.front() != '/' || !header_value_ok(path) || path.find(' ') != std::string::npos) {
      *error = "the path of the request is not valid";
      return {};
    }
    std::string out = std::string(method) + " " + path + " HTTP/1.1\r\nHost: " + host_header() + "\r\nConnection: keep-alive\r\n";
    for (const auto& [name, value] : headers) {
      if (name.empty() || !header_value_ok(name) || name.find(':') != std::string::npos || !header_value_ok(value)) {
        *error = "a header of the request has a line break or no name";
        return {};
      }
      out += name + ": " + value + "\r\n";
    }
    if (body) out += "Content-Type: application/json\r\nContent-Length: " + std::to_string(body->size()) + "\r\n";
    out += "\r\n";
    if (body) out += *body;
    return out;
  }

  // A kept connection that is fresh and alive, or null.
  std::unique_ptr<Connection> take_idle() {
    for (;;) {
      std::unique_ptr<Connection> conn;
      {
        std::lock_guard<std::mutex> lock(mu_);
        if (idle_.empty()) return nullptr;
        conn = std::move(idle_.back());
        idle_.pop_back();
        if (Clock::now() - conn->idle_since >= idle_close_) continue;  // closed here by the destructor
      }
      if (!conn->still_usable()) continue;
      conn->reused = true;
      return conn;
    }
  }

  void keep(std::unique_ptr<Connection> conn) {
    conn->idle_since = Clock::now();
    std::lock_guard<std::mutex> lock(mu_);
    // The connections that waited too long are closed now.
    idle_.erase(std::remove_if(idle_.begin(), idle_.end(), [&](const std::unique_ptr<Connection>& c) { return conn->idle_since - c->idle_since >= idle_close_; }),
                idle_.end());
    if (idle_.size() < options_.max_idle) idle_.push_back(std::move(conn));
  }

  // One request and one response on `conn`. `keepable` tells that the connection can serve another request.
  Outcome run(Connection& conn, const std::string& request, const char* method, Clock::time_point deadline, PdpHttpResult* out, bool* keepable,
              bool* timed_out) {
    std::string error;
    const int w = conn.write_all(request.data(), request.size(), deadline, &error);
    if (w <= 0) {
      out->error = error;
      *timed_out = w == 0;
      return Outcome::NoByte;
    }
    std::string buffer;
    ResponseHead head;
    for (;;) {
      // The head: up to the empty line.
      size_t end;
      while ((end = buffer.find("\r\n\r\n")) == std::string::npos) {
        if (buffer.size() > kMaxHeadBytes) {
          out->error = "bad response: the head is too large";
          return Outcome::Failed;
        }
        const int r = fill(conn, &buffer, deadline, &error);
        if (r <= 0) {
          out->error = r == 0 ? (buffer.empty() ? "the connection was closed before the answer" : "the connection was closed in the head of the answer") : error;
          *timed_out = r == -2;
          return buffer.empty() ? Outcome::NoByte : Outcome::Failed;
        }
      }
      if (!parse_head(std::string_view(buffer).substr(0, end + 2), &head, &error)) {
        out->error = error;
        return Outcome::Failed;
      }
      buffer.erase(0, end + 4);
      // An interim response (RFC 9110, 15.2) has no body: read the next head.
      if (head.status >= 100 && head.status < 200 && head.status != 101) continue;
      break;
    }
    out->status = head.status;
    out->request_id = head.request_id;
    *keepable = head.http11 && !head.close;
    const bool no_body = head.status == 204 || head.status == 304 || std::string_view(method) == "HEAD";
    std::string body;
    if (no_body) {
      // No body.
    } else if (head.chunked) {
      if (!read_chunked(conn, &buffer, &body, deadline, out, timed_out)) return Outcome::Failed;
    } else if (head.has_length) {
      if (head.length > options_.max_body_bytes) {
        out->error = "the answer is too large";
        return Outcome::Failed;
      }
      while (buffer.size() < head.length) {
        const int r = fill(conn, &buffer, deadline, &error);
        if (r <= 0) {
          out->error = r == 0 ? "the connection was closed in the body of the answer" : error;
          *timed_out = r == -2;
          return Outcome::Failed;
        }
      }
      body = buffer.substr(0, head.length);
      buffer.erase(0, head.length);
    } else {
      // No length: the body ends with the connection.
      *keepable = false;
      for (;;) {
        if (buffer.size() > options_.max_body_bytes) {
          out->error = "the answer is too large";
          return Outcome::Failed;
        }
        const int r = fill(conn, &buffer, deadline, &error);
        if (r == 0) break;
        if (r < 0) {
          out->error = error;
          *timed_out = r == -2;
          return Outcome::Failed;
        }
      }
      body = std::move(buffer);
      buffer.clear();
    }
    // Bytes after the response: the stream is not in step with the requests.
    if (!buffer.empty()) *keepable = false;
    out->body = std::move(body);
    return Outcome::Done;
  }

  bool read_chunked(Connection& conn, std::string* buffer, std::string* body, Clock::time_point deadline, PdpHttpResult* out, bool* timed_out) {
    std::string error;
    const auto need_line = [&](std::string* line) {
      size_t eol;
      while ((eol = buffer->find("\r\n")) == std::string::npos) {
        if (buffer->size() > 4096) {
          out->error = "bad response: a line of the chunked body is too long";
          return false;
        }
        const int r = fill(conn, buffer, deadline, &error);
        if (r <= 0) {
          out->error = r == 0 ? "the connection was closed in the body of the answer" : error;
          *timed_out = r == -2;
          return false;
        }
      }
      *line = buffer->substr(0, eol);
      buffer->erase(0, eol + 2);
      return true;
    };
    for (;;) {
      std::string line;
      if (!need_line(&line)) return false;
      const size_t semi = line.find(';');
      const std::string size_text(trim_blank(std::string_view(line).substr(0, semi)));
      if (size_text.empty() || size_text.size() > 8 || !std::all_of(size_text.begin(), size_text.end(), [](unsigned char c) { return std::isxdigit(c) != 0; })) {
        out->error = "bad response: a chunk size is not valid";
        return false;
      }
      const size_t size = std::stoul(size_text, nullptr, 16);
      if (size == 0) break;
      if (body->size() + size > options_.max_body_bytes) {
        out->error = "the answer is too large";
        return false;
      }
      while (buffer->size() < size + 2) {
        const int r = fill(conn, buffer, deadline, &error);
        if (r <= 0) {
          out->error = r == 0 ? "the connection was closed in the body of the answer" : error;
          *timed_out = r == -2;
          return false;
        }
      }
      if (buffer->compare(size, 2, "\r\n") != 0) {
        out->error = "bad response: a chunk has no end";
        return false;
      }
      body->append(*buffer, 0, size);
      buffer->erase(0, size + 2);
    }
    // The trailer: lines up to the empty line.
    for (;;) {
      std::string line;
      if (!need_line(&line)) return false;
      if (line.empty()) return true;
    }
  }

  PdpHttpResult exchange(const char* method, const std::string& path, const std::string* body,
                         const std::vector<std::pair<std::string, std::string>>& headers, std::chrono::milliseconds timeout, bool repeatable) {
    PdpHttpResult out;
    std::string error;
    const std::string request = build_request(method, path, body, headers, &error);
    if (request.empty()) {
      out.error = error;
      return out;
    }
    // One deadline for the whole call, the second try included.
    const auto deadline = Clock::now() + timeout;
    bool fresh_only = false;
    for (int attempt = 0; attempt < 2; ++attempt) {
      std::unique_ptr<Connection> conn;
      if (!fresh_only) conn = take_idle();
      if (!conn) {
        conn = std::make_unique<Connection>();
        if (!conn->connect_to(options_.url, ssl_ctx_, options_.verify, deadline, &error)) {
          out = PdpHttpResult{};
          out.error = error;
          return out;
        }
      }
      const bool was_reused = conn->reused;
      out = PdpHttpResult{};
      bool keepable = false;
      bool timed_out = false;
      const Outcome outcome = run(*conn, request, method, deadline, &out, &keepable, &timed_out);
      if (outcome == Outcome::Done) {
        if (keepable) keep(std::move(conn));
        return out;
      }
      // A kept connection that the peer closed gives no byte: the request did not reach the application. A question goes again once.
      if (was_reused && outcome == Outcome::NoByte && !timed_out && repeatable && Clock::now() < deadline) {
        fresh_only = true;
        continue;
      }
      return out;
    }
    return out;
  }

  const PdpTransportOptions options_;
  std::mutex mu_;
  std::chrono::milliseconds idle_close_;
  std::vector<std::unique_ptr<Connection>> idle_;
  void* ssl_ctx_ = nullptr;  // SSL_CTX*, owned; null for http
};

bool ipv4_loopback(std::string_view host) {
  unsigned a, b, c, d;
  char tail;
  const std::string text(host);
  if (std::sscanf(text.c_str(), "%u.%u.%u.%u%c", &a, &b, &c, &d, &tail) != 4) return false;
  return a == 127 && b < 256 && c < 256 && d < 256;
}

} // namespace

std::optional<PdpUrl> parse_pdp_url(std::string_view text, std::string* error) {
  const auto fail = [&](const std::string& why) -> std::optional<PdpUrl> {
    if (error) *error = why;
    return std::nullopt;
  };
  PdpUrl out;
  std::string rewritten;
  if (text.rfind("https://", 0) == 0) {
    out.https = true;
    rewritten = "http://" + std::string(text.substr(8));
  } else if (text.rfind("http://", 0) == 0) {
    rewritten = std::string(text);
  } else {
    return fail("must start with http:// or https://");
  }
  std::string reason;
  const auto endpoint = otlp_parse_endpoint(rewritten, &reason);
  if (!endpoint) return fail(reason);
  out.host = endpoint->host;
  out.base_path = endpoint->base_path;
  out.port = endpoint->port;
  if (out.https) {
    // The parser gives 80 when the address has no port: look for the port in the authority.
    std::string_view rest = std::string_view(rewritten).substr(7);
    const std::string_view authority = rest.substr(0, rest.find('/'));
    const bool explicit_port = authority.front() == '[' ? authority.find("]:") != std::string_view::npos : authority.find(':') != std::string_view::npos;
    if (!explicit_port) out.port = 443;
  }
  return out;
}

bool pdp_host_is_loopback(std::string_view host) {
  const std::string lower = lower_ascii(host);
  return lower == "localhost" || lower == "::1" || ipv4_loopback(host);
}

bool pdp_tls_available() {
#ifdef CHDASH_HAVE_TLS
  return true;
#else
  return false;
#endif
}

std::string pdp_check_ca_file(const std::string& path) {
#ifdef CHDASH_HAVE_TLS
  if (!std::ifstream(path).good()) return "the file is not readable";
  OPENSSL_init_ssl(OPENSSL_INIT_NO_LOAD_CONFIG, nullptr);
  SslCtxPtr ctx(SSL_CTX_new(TLS_client_method()));
  if (!ctx) return "OpenSSL cannot make a TLS context";
  if (SSL_CTX_load_verify_file(ctx.get(), path.c_str()) != 1) {
    const std::string detail = openssl_error_text();
    return "the file holds no PEM certificate that OpenSSL can read (" + detail + ")";
  }
  X509_STORE* store = SSL_CTX_get_cert_store(ctx.get());
  if (!store || sk_X509_OBJECT_num(X509_STORE_get0_objects(store)) == 0) return "the file holds no certificate";
  return {};
#else
  (void)path;
  return "this build has no TLS client: build with -DCHDASH_TLS=ON";
#endif
}

std::unique_ptr<PdpTransport> make_pdp_transport(const PdpTransportOptions& options, std::string* error) {
  void* ssl_ctx = nullptr;
  if (options.url.https) {
#ifdef CHDASH_HAVE_TLS
    // The process ignores SIGPIPE (the HTTP server does), but a write to a TLS connection that the peer closed must never end the process.
    static std::once_flag once;
    std::call_once(once, [] { std::signal(SIGPIPE, SIG_IGN); });
    std::string reason;
    SslCtxPtr ctx = make_ssl_ctx(options, &reason);
    if (!ctx) {
      if (error) *error = reason;
      return nullptr;
    }
    ssl_ctx = ctx.release();
#else
    if (error) *error = "https needs a build with TLS: build with -DCHDASH_TLS=ON (tools/build_openssl.sh builds OpenSSL)";
    return nullptr;
#endif
  }
  return std::make_unique<HttpTransport>(options, ssl_ctx);
}

} // namespace chdash
