#pragma once

// The JSON of each answer of the System page (docs/system.md). Each function takes what the service read and writes the body of the route; the
// numbers of a series are written to six significant digits and a bucket without a sample is null.

#include "system_activity.hpp"
#include "system_disks.hpp"
#include "system_monitor.hpp"
#include "system_overview.hpp"
#include "system_queries.hpp"
#include "system_request.hpp"
#include "system_series.hpp"
#include "system_settings.hpp"

#include <string>

namespace chdash {
namespace system_page {

// A value of a series as the text of a JSON number, or "null" when it is not finite.
std::string series_number(double value);

std::string overview_json(const std::string& host_id, const SystemMonitorOverview& overview, bool stale);
std::string series_json(const std::string& host_id, const SeriesRequest& request, const SystemMonitorSeries& series, bool stale,
                        const SystemSettings& settings);
std::string growth_json(const std::string& host_id, const SeriesRequest& request, const SystemMonitorDiskGrowth& data, bool stale,
                        const SystemSettings& settings);
std::string disks_json(const std::string& host_id, const SystemMonitorDisks& data, bool stale, const SystemSettings& settings);
std::string queries_json(const std::string& host_id, uint64_t from_ms, uint64_t to_ms, const SystemMonitorQueries& data, bool stale,
                         const SystemSettings& settings);
std::string query_json(const std::string& host_id, uint64_t from_ms, uint64_t to_ms, const SystemMonitorQuery& data, bool stale,
                       const SystemSettings& settings);
std::string activity_json(const std::string& host_id, const SystemActivity& ops, bool stale);
std::string keeper_json(const std::string& host_id, const SystemKeeperStatus& keeper, bool stale);

}  // namespace system_page
}  // namespace chdash
