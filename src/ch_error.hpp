#pragma once

// The meaning of a failed ClickHouse statement is derived from the error code that ClickHouse sends.
// The kind of the exception also decides the meaning.
// The meaning is never derived from a word in the message.
// Every place that turns a failure into an answer uses this classification.
// Examples are the HTTP routes, MCP, the System page and the fallbacks of the trace search.
// The same failure gets the same status, the same code and the same advice (retry or not) everywhere.

#include <exception>
#include <string>
#include <string_view>

namespace chdash {

enum class ChErrorKind {
  Timeout,      // the statement ran past its time (159), or a socket waited too long
  ScanLimit,    // it would read or return more rows or bytes than allowed (158, 307, 396)
  MemoryLimit,  // it would use more memory than allowed (241)
  AccessDenied, // the user may not do it (497)
  ReadOnly,     // the user may not change anything (164)
  Canceled,     // the caller went away, or ClickHouse was asked to stop it (ChQueryCanceled, 394, 735)
  Unavailable,  // the connection failed: no answer, a reset, a protocol error, too many connections or queries (202, 203, 209, 210, 279)
  NotFound,     // a database, a table, a column or a function that does not exist (46, 47, 60, 81, 83)
  BadQuery,     // the text of the statement is wrong (62, 36, 43, 53)
  Other,        // any other error of ClickHouse, or an exception of ChDash
};

struct ChError {
  ChErrorKind kind = ChErrorKind::Other;
  int code = 0;  // the code of ClickHouse; 0 when the failure did not come from the server
};

// Describes the meaning of an exception that a statement threw.
ChError classify_clickhouse_error(const std::exception& error);

// Holds "TIMEOUT_EXCEEDED" and similar names for the codes that ChDash tells apart. Holds "" for the other codes.
std::string_view clickhouse_error_name(int code);

} // namespace chdash
