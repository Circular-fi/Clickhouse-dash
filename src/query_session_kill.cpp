#include "query_session.hpp"

#include "ch_query.hpp"
#include "ch_uri.hpp"
#include "log.hpp"

#include <chrono>
#include <exception>
#include <utility>

namespace chdash {

KillOutcome kill_queries(const std::string& uri, const std::string& where, bool synchronous) {
  KillOutcome out;
  // The statement is not stopped by the cancel of the run it stops (the scope of
  // that run says "canceled" by then).
  ChQueryLimits limits;
  limits.log_comment = "chdash:cancel";
  ChQueryScope scope(std::move(limits));
  std::string error;
  auto client = make_client_from_uri(
      uri,
      std::chrono::seconds(5),
      std::chrono::seconds(5),
      std::chrono::seconds(5),
      &error);
  if (!client) {
    out.error = error.empty() ? "Cannot connect to ClickHouse." : error;
    return out;
  }
  try {
    ch_select(*client, "KILL QUERY WHERE " + where + (synchronous ? " SYNC" : " ASYNC"),
              [&out](const clickhouse::Block& block) { out.matched += block.GetRowCount(); });
    out.sent = true;
  } catch (const std::exception& e) {
    // A missing grant or a lost connection: the cancel stays best effort, and says so (the answer of the cancel route
    // carries `kill_error`, and the log the same text).
    out.error = e.what();
    log_event(LogLevel::Warn, "query.kill_failed", {{"error", out.error.substr(0, 300)}});
  }
  return out;
}

} // namespace chdash
