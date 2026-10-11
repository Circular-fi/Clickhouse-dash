#pragma once

// What a read of the Traces page returns: a value, or the error that the route sends (service_result.hpp). A failure of a
// ClickHouse statement is not in here: it is thrown, and the service turns it into the error of its route (error_from_clickhouse).

#include "service_result.hpp"

namespace chdash {
namespace trace {

using chdash::make_error;
using chdash::Result;

}  // namespace trace
}  // namespace chdash
