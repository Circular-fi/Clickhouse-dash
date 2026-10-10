// The hooks of every request (docs/operations.md): the security headers of every answer, and the guard of the writes
// before the routing.

#include "server.hpp"

#include "http_guard.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <string>

namespace chdash {

namespace {

// {"error", "error_code", "message"}: the two keys that the error answers of ChDash use.
void refuse(httplib::Response& res, int status, std::string_view code, std::string_view message) {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("error"); w.String(code.data(), static_cast<rapidjson::SizeType>(code.size()));
  w.Key("error_code"); w.String(code.data(), static_cast<rapidjson::SizeType>(code.size()));
  w.Key("message"); w.String(message.data(), static_cast<rapidjson::SizeType>(message.size()));
  w.EndObject();
  res.status = status;
  res.headers.erase("Cache-Control");
  res.set_header("Cache-Control", "no-store");
  res.set_content(sb.GetString(), sb.GetSize(), "application/json");
}

bool is_write(const std::string& method) {
  return method == "POST" || method == "PUT" || method == "PATCH" || method == "DELETE";
}

} // namespace

void Server::install_http_hooks() {
  http_.set_default_headers(security_headers());
  http_.set_pre_routing_handler([this](const httplib::Request& req, httplib::Response& res) { return before_routing(req, res); });
}

httplib::Server::HandlerResponse Server::before_routing(const httplib::Request& req, httplib::Response& res) {
  // Every write but the MCP endpoint (its Origin list and its Content-Type check are its own, api_mcp.cpp). The body
  // is not read yet: close the connection rather than read it.
  if (is_write(req.method) && req.path != "/mcp") {
    if (const auto refusal = check_browser_write(req)) {
      res.set_header("Connection", "close");
      refuse(res, refusal->status, refusal->code, refusal->message);
      return httplib::Server::HandlerResponse::Handled;
    }
  }
  return httplib::Server::HandlerResponse::Unhandled;
}

} // namespace chdash
