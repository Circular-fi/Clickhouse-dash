#pragma once

#include <httplib.h>

#include <rapidjson/document.h>

namespace chdash {

bool parse_json_body(const httplib::Request& req, rapidjson::Document& doc);

} // namespace chdash
