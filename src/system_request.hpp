#pragma once

// What the routes of the System page read from a request (docs/system.md): the host, a window in milliseconds (clamped and checked here
// against the settings), and the allowlisted enums of the Queries. Parsing only: nothing here reads ClickHouse, and a request names no SQL, no
// column and no limit. A route refuses a parameter that it does not know, so a typo is an error. A parser returns false with the 400 answer
// in *error; the host is looked up after the parsing, so a bad parameter is refused before an unknown host is.

#include "error_envelope.hpp"
#include "system_queries.hpp"
#include "system_series.hpp"
#include "system_settings.hpp"

#include <httplib.h>

#include <cstdint>
#include <string>

namespace chdash {
namespace system_page {

// The routes that name the host only: the Overview, the Disks, the Activity and the Keeper status.
struct HostRequest {
  std::string host_id;
  bool refresh = false;
};

// The Performance series and the disk growth (the same route, `panel=`).
struct SeriesRequest {
  std::string host_id;
  bool growth = false;
  uint64_t from_ms = 0, to_ms = 0;  // the window asked for, before the alignment
  MonitorSeriesWindow window;       // aligned to the step
  bool refresh = false;
};

// The list of the top query shapes. `query` holds what the user chose (the account users are set by the service).
struct QueriesRequest {
  std::string host_id;
  uint64_t from_ms = 0, to_ms = 0;
  MonitorQueriesRequest query;
  bool refresh = false;
};

// One shape.
struct QueryRequest {
  std::string host_id;
  uint64_t from_ms = 0, to_ms = 0;
  MonitorQueriesRequest query;
  bool refresh = false;
};

bool parse_host_request(const httplib::Request& req, HostRequest* out, ApiError* error);
bool parse_series_request(const httplib::Request& req, const SystemSettings& settings, uint64_t now_ms, SeriesRequest* out, ApiError* error);
bool parse_queries_request(const httplib::Request& req, const SystemSettings& settings, uint64_t now_ms, QueriesRequest* out, ApiError* error);
// `hash_text` is the hash of the address: /api/system/queries/<hash>.
bool parse_query_request(const httplib::Request& req, const std::string& hash_text, const SystemSettings& settings, uint64_t now_ms,
                         QueryRequest* out, ApiError* error);

// A whole number of milliseconds, decimal digits only (no sign, no space).
bool parse_ms(const std::string& text, uint64_t& out);
// A normalized_query_hash: decimal digits of a UInt64, nothing else.
bool parse_hash(const std::string& text, uint64_t& out);

}  // namespace system_page
}  // namespace chdash
