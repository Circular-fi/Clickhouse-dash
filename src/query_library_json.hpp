#pragma once

// The JSON of the query library, both ways: reading a value of a document, and writing a folder or a query. The persisted file and the
// answers of the store write the same fields.

#include "query_library_state.hpp"

#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <optional>
#include <string>
#include <string_view>

namespace chdash {
namespace qlib {

using JsonWriter = rapidjson::Writer<rapidjson::StringBuffer>;

inline std::string json_text(const rapidjson::Value& v) { return std::string(v.GetString(), v.GetStringLength()); }

inline const rapidjson::Value* member(const rapidjson::Value& obj, const char* key) {
  const auto it = obj.FindMember(key);
  return it == obj.MemberEnd() ? nullptr : &it->value;
}

inline void write_string(JsonWriter& w, std::string_view s) { w.String(s.data(), static_cast<rapidjson::SizeType>(s.size())); }

template <typename W>
inline void write_str(W& w, std::string_view s) {
  w.String(s.data(), static_cast<rapidjson::SizeType>(s.size()));
}

template <typename W>
inline void write_opt(W& w, const std::optional<std::string>& s) {
  if (s) write_str(w, *s);
  else w.Null();
}

template <typename W>
inline void write_folder_fields(W& w, const QueryLibraryFolder& f) {
  w.Key("id"); write_str(w, f.id);
  w.Key("host_id"); write_str(w, f.host_id);
  w.Key("parent_id"); write_opt(w, f.parent_id);
  w.Key("name"); write_str(w, f.name);
  w.Key("created_at_ms"); w.Int64(f.created_at_ms);
  w.Key("updated_at_ms"); w.Int64(f.updated_at_ms);
}

template <typename W>
inline void write_query_fields(W& w, const QueryLibraryQuery& q) {
  w.Key("id"); write_str(w, q.id);
  w.Key("folder_id"); write_opt(w, q.folder_id);
  w.Key("name"); write_str(w, q.name);
  w.Key("description"); write_str(w, q.description);
  w.Key("sql"); write_str(w, q.sql);
  w.Key("host_id"); write_str(w, q.host_id);
  w.Key("created_at_ms"); w.Int64(q.created_at_ms);
  w.Key("updated_at_ms"); w.Int64(q.updated_at_ms);
}

} // namespace qlib
} // namespace chdash
