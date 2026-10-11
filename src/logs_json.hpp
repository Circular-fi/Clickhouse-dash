#pragma once

// The JSON of each answer of the Logs page (docs/logs.md).

#include "logs_service.hpp"

#include <string>

namespace chdash {
namespace logs {

std::string search_json(const SearchAnswer& answer);
std::string histogram_json(const HistogramAnswer& answer);
std::string context_json(const ContextAnswer& answer);
std::string patterns_json(const PatternsAnswer& answer);
std::string services_json(const ServicesAnswer& answer);
std::string facets_json(const FacetKeysAnswer& answer);
std::string facet_values_json(const FacetValuesAnswer& answer);

}  // namespace logs
}  // namespace chdash
