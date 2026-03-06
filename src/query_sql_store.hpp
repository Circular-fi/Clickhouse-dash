#pragma once

#include <optional>
#include <string>

namespace chdash {

void remember_query_sql(const std::string& query_id, std::string sql);
std::optional<std::string> get_query_sql(const std::string& query_id);
void forget_query_sql(const std::string& query_id);

} // namespace chdash
