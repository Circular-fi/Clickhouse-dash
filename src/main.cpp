#include "server.hpp"

#include "ch_uri.hpp"
#include "config.hpp"
#include "config_schema.hpp"
#include "log.hpp"

#include <httplib.h>

#include <atomic>
#include <chrono>
#include <cerrno>
#include <initializer_list>
#include <csignal>
#include <cstdlib>
#include <ctime>
#include <iostream>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include <pthread.h>
#include <sys/types.h>
#include <unistd.h>

namespace {

struct CliOptions {
  std::optional<std::string> config_path;
  bool health = false;
  bool print_config = false;
  bool version = false;
  bool help = false;
};

CliOptions parse_cli(int argc, char** argv) {
  CliOptions options;
  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--config") {
      if (options.config_path) throw std::runtime_error("--config may only be specified once");
      if (i + 1 >= argc) throw std::runtime_error("--config requires a file path");
      const std::string path = argv[++i];
      if (path.empty() || path.rfind("--", 0) == 0) throw std::runtime_error("--config requires a file path");
      options.config_path = path;
    } else if (arg == "--health") {
      options.health = true;
    } else if (arg == "--print-config") {
      options.print_config = true;
    } else if (arg == "--version" || arg == "-v") {
      options.version = true;
    } else if (arg == "--help" || arg == "-h") {
      options.help = true;
    } else {
      throw std::runtime_error("unknown option: " + arg);
    }
  }
  return options;
}

void print_help() {
  std::cout
      << "Usage: chdash --config <path> [--health | --print-config]\n"
      << "       chdash --version\n\n"
      << "Application configuration is HCL-only; --config is required for server and health modes.\n"
      << "--health asks the running server (GET /livez on the listen port of the configuration) and exits 0 when it answers.\n"
      << "--print-config checks the configuration, writes every setting as it applies (block.key = value), and exits 0.\n";
}

// The liveness probe of the image (docs/operations.md, "Health probes"): GET /livez of the server that runs with this
// configuration, on the loopback when it listens on every address. ClickHouse is not asked: a host that is down
// never makes the container unhealthy (GET /readyz says whether a host answers).
int probe_liveness(const chdash::AppConfig& cfg) {
  std::string host = "127.0.0.1";
  int port = 8080;
  if (const auto pos = cfg.listen.rfind(':'); pos != std::string::npos) {
    host = cfg.listen.substr(0, pos);
    port = std::stoi(cfg.listen.substr(pos + 1));
  }
  if (host.empty() || host == "0.0.0.0") host = "127.0.0.1";
  else if (host == "::" || host == "[::]") host = "::1";
  httplib::Client client(host, port);
  client.set_connection_timeout(2, 0);
  client.set_read_timeout(2, 0);
  client.set_write_timeout(2, 0);
  const auto result = client.Get("/livez");
  if (!result) {
    std::cerr << "Health check failed: no answer from " << host << ":" << port << " (" << httplib::to_string(result.error()) << ")\n";
    return 1;
  }
  if (result->status != 200) {
    std::cerr << "Health check failed: GET /livez answered " << result->status << "\n";
    return 1;
  }
  return 0;
}

void print_version() {
#ifdef CHDASH_SEMVER
  const char* version = CHDASH_SEMVER;
#else
  const char* version = "dev";
#endif
  std::cout << "clickhouse-dash " << version << std::endl;
}

void log_configuration(const chdash::AppConfig& cfg) {
  using chdash::LogField;
  using chdash::LogLevel;
  using chdash::log_event;
  // Every setting as it applies (the table of keys, src/config_keys.def): what the file says, or the default, and the values that
  // the start derived. A value outside its bounds never gets here: the start stops with an error.
  const auto values = chdash::config::effective_values(cfg);
  std::vector<LogField> fields;
  fields.reserve(values.size() + 1);
  fields.emplace_back("hosts", cfg.hosts.size());
  for (const auto& [name, value] : values) fields.emplace_back(name, value);
  log_event(LogLevel::Info, "server.config", fields);
  for (const auto& host : cfg.hosts) {
    log_event(LogLevel::Info, "server.host",
              {{"host", host.id},
               {"runner_uri", chdash::redact_clickhouse_uri(host.runner_uri)},
               {"system_uri", chdash::redact_clickhouse_uri(host.system_uri)}});
  }
  if (cfg.mcp.enabled) {
    size_t mcp_hosts = 0;
    for (const auto& host : cfg.hosts) mcp_hosts += host.mcp_uri.empty() ? 0 : 1;
    log_event(LogLevel::Info, "server.mcp",
              {{"endpoint", "/mcp"},
               {"config_keys", cfg.mcp.keys.size()},
               {"storage_file", cfg.mcp.storage_file.empty() ? std::string("-") : cfg.mcp.storage_file},
               {"manage_from_ui", cfg.mcp.manage_from_ui},
               {"hosts", mcp_hosts}});
  }
  for (const auto& library : cfg.query_libraries) {
    log_event(LogLevel::Info, "server.query_library",
              {{"name", library.name}, {"file", library.file}, {"writable", library.writable}});
  }
}

// Waits up to timeout_ms for one of the (blocked) signals: its number, or -1 with errno EAGAIN at the end of the time
// (or when `finished` is set, on the platforms that poll). macOS has no sigtimedwait: there the pending signals are polled.
int wait_signal_for(const sigset_t& signals, int timeout_ms, const std::atomic<bool>& finished) {
#if defined(__linux__)
  (void)finished;
  const timespec wait{timeout_ms / 1000, static_cast<long>(timeout_ms % 1000) * 1000000L};
  return sigtimedwait(&signals, nullptr, &wait);
#else
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  for (;;) {
    sigset_t pending;
    sigemptyset(&pending);
    sigpending(&pending);
    for (const int signal : {SIGTERM, SIGINT}) {
      if (sigismember(&signals, signal) == 1 && sigismember(&pending, signal) == 1) {
        int received = 0;
        sigwait(&signals, &received);
        return received;
      }
    }
    if (finished.load() || std::chrono::steady_clock::now() >= deadline) {
      errno = EAGAIN;
      return -1;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  }
#endif
}

// Runs the server until a stop. SIGTERM and SIGINT stop it cleanly (docs/operations.md, "Shutdown"): the process
// is PID 1 in a container, where a signal without a handler is ignored. The signals are blocked before any other
// thread starts (each thread inherits the mask), and one thread waits for them. It stops the server, then watches
// the drain: a second signal, or the end of server.shutdown_timeout_ms, ends the process at once with status 1.
int serve(const chdash::AppConfig& cfg) {
  sigset_t shutdown_signals;
  sigemptyset(&shutdown_signals);
  sigaddset(&shutdown_signals, SIGTERM);
  sigaddset(&shutdown_signals, SIGINT);
  pthread_sigmask(SIG_BLOCK, &shutdown_signals, nullptr);

  std::mutex server_mu;
  chdash::Server* running = nullptr;  // under server_mu
  bool stop_requested = false;        // under server_mu: a signal came before the server was ready
  std::atomic<bool> finished{false};
  const int timeout_ms = cfg.server.shutdown_timeout_ms;
  std::thread shutdown_thread([&, shutdown_signals, timeout_ms] {
    int received = 0;
    sigwait(&shutdown_signals, &received);
    if (finished.load()) return;
    chdash::log_event(chdash::LogLevel::Info, "server.signal", {{"signal", received}});
    {
      std::lock_guard<std::mutex> lock(server_mu);
      if (running) running->stop();
      else stop_requested = true;
    }
    for (;;) {
      const int again = wait_signal_for(shutdown_signals, timeout_ms, finished);
      if (finished.load()) return;
      if (again < 0 && errno == EINTR) continue;
      chdash::log_event(chdash::LogLevel::Error, again < 0 ? "server.shutdown_timeout" : "server.signal_again",
                        {{"timeout_ms", timeout_ms}});
      std::_Exit(1);
    }
  });
  struct JoinShutdownThread {
    std::thread& thread;
    std::atomic<bool>& finished;
    ~JoinShutdownThread() {
      // The server is gone (stopped, or its listener failed): wake the thread so that it ends.
      finished.store(true);
      if (thread.joinable()) {
        // A signal for the process, not for the thread: the thread that waits for it takes it.
        kill(getpid(), SIGTERM);
        thread.join();
      }
    }
  } join_shutdown_thread{shutdown_thread, finished};

  try {
    int status = 0;
    {
      // Destroyed before join_shutdown_thread: the watch of the drain covers the destructor too.
      chdash::Server server(cfg);
      {
        std::lock_guard<std::mutex> lock(server_mu);
        running = &server;
        if (stop_requested) server.stop();
      }
      log_configuration(cfg);
      status = server.run();
      std::lock_guard<std::mutex> lock(server_mu);
      running = nullptr;
    }
    return status;
  } catch (const std::exception& error) {
    chdash::log_event(chdash::LogLevel::Error, "server.fatal", {{"error", error.what()}});
    return 1;
  }
}

} // namespace

int main(int argc, char** argv) {
  CliOptions cli;
  try {
    cli = parse_cli(argc, argv);
  } catch (const std::exception& error) {
    std::cerr << "argument error: " << error.what() << "\n";
    std::cerr << "Try --help for usage.\n";
    return 2;
  }

  if (cli.help) {
    print_help();
    return 0;
  }
  if (cli.version) {
    print_version();
    return 0;
  }

  if (!cli.config_path) {
    std::cerr << "config error: --config is required (configuration is HCL-only)." << std::endl;
    return 2;
  }

  chdash::AppConfig cfg;
  try {
    cfg = chdash::load_config_from_file(*cli.config_path);
  } catch (const std::exception& error) {
    std::cerr << "config error: " << error.what() << std::endl;
    return 1;
  }

  if (cli.print_config) {
    for (const auto& [name, value] : chdash::config::effective_values(cfg)) std::cout << name << " = " << value << "\n";
    return 0;
  }
  if (cli.health) return probe_liveness(cfg);
  return serve(cfg);
}
