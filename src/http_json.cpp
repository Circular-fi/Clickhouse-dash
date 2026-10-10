#include "http_json.hpp"
#include "json_parse.hpp"

namespace chdash {

bool parse_json_body(const httplib::Request& req, rapidjson::Document& doc) {
  return parse_json_bounded(doc, req.body) && doc.IsObject();
}

} // namespace chdash
