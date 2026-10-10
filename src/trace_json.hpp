#pragma once

// The JSON of the answers of the Traces page. One function for each route: the answer of the service in, the text of the body out.
// The shape of each body is the contract with the page (docs/traces.md); the names of its members are written here and nowhere else.

#include "trace_service.hpp"

#include <string>

namespace chdash {
namespace trace {

std::string search_json(const SearchAnswer& answer);
std::string analytics_json(const AnalyticsAnswer& answer);
std::string service_map_json(const ServiceMapAnswer& answer);
std::string heatmap_json(const HeatmapAnswer& answer);
std::string deltas_json(const DeltasAnswer& answer);

}  // namespace trace
}  // namespace chdash
