#include "ch_error.hpp"

#include "ch_query.hpp"

#include <clickhouse/exceptions.h>

#include <cerrno>
#include <system_error>

namespace chdash {
namespace {

ChErrorKind kind_of_code(int code) {
  switch (code) {
    case 159:  // TIMEOUT_EXCEEDED
    case 160:  // TOO_SLOW
      return ChErrorKind::Timeout;
    case 158:  // TOO_MANY_ROWS
    case 307:  // TOO_MANY_BYTES
    case 396:  // TOO_MANY_ROWS_OR_BYTES
      return ChErrorKind::ScanLimit;
    case 241:  // MEMORY_LIMIT_EXCEEDED
      return ChErrorKind::MemoryLimit;
    case 497:  // ACCESS_DENIED
      return ChErrorKind::AccessDenied;
    case 164:  // READONLY
      return ChErrorKind::ReadOnly;
    case 394:  // QUERY_WAS_CANCELLED
    case 735:  // QUERY_WAS_CANCELLED_BY_CLIENT
      return ChErrorKind::Canceled;
    case 202:  // TOO_MANY_SIMULTANEOUS_QUERIES
    case 203:  // NO_FREE_CONNECTION
    case 209:  // SOCKET_TIMEOUT
    case 210:  // NETWORK_ERROR
    case 279:  // ALL_CONNECTION_TRIES_FAILED
      return ChErrorKind::Unavailable;
    case 46:   // UNKNOWN_FUNCTION
    case 47:   // UNKNOWN_IDENTIFIER
    case 60:   // UNKNOWN_TABLE
    case 81:   // UNKNOWN_DATABASE
      return ChErrorKind::NotFound;
    case 36:   // BAD_ARGUMENTS
    case 43:   // ILLEGAL_TYPE_OF_ARGUMENT
    case 53:   // TYPE_MISMATCH
    case 62:   // SYNTAX_ERROR
      return ChErrorKind::BadQuery;
    default:
      return ChErrorKind::Other;
  }
}

} // namespace

ChError classify_clickhouse_error(const std::exception& error) {
  if (const auto* server = dynamic_cast<const clickhouse::ServerException*>(&error)) {
    return {kind_of_code(server->GetCode()), server->GetCode()};
  }
  if (dynamic_cast<const ChQueryCanceled*>(&error)) return {ChErrorKind::Canceled, 0};
  if (const auto* system = dynamic_cast<const std::system_error*>(&error)) {
    const int value = system->code().value();
    if (value == ETIMEDOUT || value == EAGAIN || value == EWOULDBLOCK) return {ChErrorKind::Timeout, 0};
    return {ChErrorKind::Unavailable, 0};
  }
  // A failure of the protocol or of the connection of the client (a reset, a half read packet, a refused connection).
  if (dynamic_cast<const clickhouse::ProtocolError*>(&error) || dynamic_cast<const clickhouse::OpenSSLError*>(&error)) {
    return {ChErrorKind::Unavailable, 0};
  }
  return {ChErrorKind::Other, 0};
}

std::string_view clickhouse_error_name(int code) {
  switch (code) {
    case 159: return "TIMEOUT_EXCEEDED";
    case 158: return "TOO_MANY_ROWS";
    case 307: return "TOO_MANY_BYTES";
    case 396: return "TOO_MANY_ROWS_OR_BYTES";
    case 241: return "MEMORY_LIMIT_EXCEEDED";
    case 497: return "ACCESS_DENIED";
    case 394: return "QUERY_WAS_CANCELLED";
    case 60: return "UNKNOWN_TABLE";
    case 81: return "UNKNOWN_DATABASE";
    case 47: return "UNKNOWN_IDENTIFIER";
    case 62: return "SYNTAX_ERROR";
    default: return "";
  }
}

} // namespace chdash
