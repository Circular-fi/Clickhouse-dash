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
std::string services_json(const ServicesAnswer& answer);
std::string services_db_json(const ServicesDbAnswer& answer);
std::string meta_json(const MetaAnswer& answer);
std::string prefill_json(const PrefillAnswer& answer);
std::string facet_keys_json(const FacetKeysAnswer& answer);
std::string facet_values_json(const FacetValuesAnswer& answer);

}  // namespace trace
}  // namespace chdash
