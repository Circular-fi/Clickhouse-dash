#pragma once

#include <string_view>

namespace chdash {

// ChDash intentionally allows arbitrary SQL supported by runner_uri, except
// direct KILL QUERY statements. Query cancellation is a capability-controlled
// backend action executed via system_uri; allowing runner-side KILL QUERY would
// bypass that boundary because ClickHouse users may cancel their own queries.
bool user_sql_is_forbidden(std::string_view sql);

} // namespace chdash
