#include "http_json.hpp"

namespace chdash {

bool parse_json_body(const httplib::Request& req, rapidjson::Document& doc) {
  doc.Parse(req.body.c_str());
  return !doc.HasParseError() && doc.IsObject();
}

} // namespace chdash
