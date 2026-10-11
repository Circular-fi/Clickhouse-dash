#pragma once

// The JSON of each answer of the Metrics page (docs/metrics.md, "Metrics browser API").

#include "metrics_service.hpp"

#include <string>

namespace chdash {
namespace metrics {

std::string catalog_json(const CatalogAnswer& answer);
std::string attributes_json(const AttributesAnswer& answer);
std::string series_json(const SeriesAnswer& answer);
std::string exemplars_json(const ExemplarsAnswer& answer);

}  // namespace metrics
}  // namespace chdash
