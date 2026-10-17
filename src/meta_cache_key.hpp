#pragma once

#include <string>
#include <string_view>

namespace chdash {

namespace meta_key_detail {

// A part of a key: its length, a colon and the text. A part never joins the part that follows, whatever bytes it holds.
inline void append_part(std::string& key, std::string_view part) {
  key.push_back('\0');
  key += std::to_string(part.size());
  key.push_back(':');
  key.append(part);
}

}  // namespace meta_key_detail

// The key of an entry of the catalog cache of GET /api/meta.
// The cache is shared by all the callers of a host. A column catalog is read for one database and one table that the caller names.
// Every part of the key goes in with its length. Two different (database, table) pairs, such as ("a::b", "c") and ("a", "b::c"), never share an entry.
// The access check covers the database of the request. An entry that another pair filled must never answer it.
inline std::string meta_catalog_cache_key(std::string_view host_id, std::string_view credential_scope, std::string_view type, bool scoped_columns,
                                          std::string_view database, std::string_view table) {
  std::string key;
  meta_key_detail::append_part(key, host_id);
  meta_key_detail::append_part(key, credential_scope);
  meta_key_detail::append_part(key, type);
  if (type == "columns" && scoped_columns) {
    meta_key_detail::append_part(key, database);
    meta_key_detail::append_part(key, table);
  }
  return key;
}

}  // namespace chdash
