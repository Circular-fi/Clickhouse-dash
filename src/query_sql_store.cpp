#include "query_sql_store.hpp"

#include <mutex>
#include <unordered_map>

namespace chdash {

namespace {

std::mutex g_mu;
std::unordered_map<std::string, std::string> g_map;

}

void remember_query_sql(const std::string& query_id, std::string sql) {
  std::lock_guard<std::mutex> lk(g_mu);
  g_map[query_id] = std::move(sql);
}

std::optional<std::string> get_query_sql(const std::string& query_id) {
  std::lock_guard<std::mutex> lk(g_mu);
  auto it = g_map.find(query_id);
  if (it == g_map.end()) return std::nullopt;
  return it->second;
}

void forget_query_sql(const std::string& query_id) {
  std::lock_guard<std::mutex> lk(g_mu);
  g_map.erase(query_id);
}

} // namespace chdash
