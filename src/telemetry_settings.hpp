#pragma once

// The telemetry { } block of the configuration (docs/server-telemetry.md): the OTLP export of the SERVER span of each MCP request,
// of its child spans (the ClickHouse statements of the call) and of the call log (contract 7.4 and 7.5). ChDash has no OpenTelemetry
// SDK and reads no OTEL_* variable: each value comes from the file, or from the variable or the file that the file names.

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace chdash {

struct TelemetrySettings {
  bool enabled = false;
  // The base URL of the OTLP/HTTP receiver: http://host[:port][/path]. The spans go to <base>/v1/traces, the call log to
  // <base>/v1/logs. Required when enabled is true.
  std::string otlp_endpoint;
  std::string service_name = "chdash";
  // The longest time that a span waits in the queue before it is sent.
  int64_t export_interval_ms = 5000;
  // The time of one export request (connect, send and answer), and of the connect alone.
  int64_t export_timeout_ms = 10000;
  int64_t connect_timeout_ms = 2000;
  // The spans (and the log records) that wait, at most, for each signal. Past it a new item is dropped and counted.
  int64_t max_queue_size = 2048;
  // The items of one export request, at most. It is at most max_queue_size.
  int64_t max_export_batch_size = 512;
  // Send the call log (mcp.call) as OTLP log records too. The JSON line of the log is always written.
  bool call_log = true;
};

// A duration of the file: an integer and one unit, "500ms", "15s", "2m" or "1h". nullopt for any other text (a space, a
// fraction, a sign, no unit, more than 12 digits).
std::optional<int64_t> parse_duration_ms(std::string_view text);

// The text of a duration in the largest unit that gives an integer ("15s", not "15000ms").
std::string duration_text(int64_t ms);

// The parts of an endpoint of the file: http://host[:port][/path]. Only http: ChDash has no TLS client. On an error, nullopt, and
// `error` says what is wrong.
struct OtlpEndpoint {
  std::string host;
  int port = 80;
  std::string base_path;  // "" or "/path", without a slash at the end
};
std::optional<OtlpEndpoint> otlp_parse_endpoint(std::string_view text, std::string* error);

} // namespace chdash
