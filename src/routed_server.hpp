#pragma once

// The HTTP server, with the routes that its handlers answer also callable in the process. A route is registered as it always
// was (http_.Get("/api/traces/search", handler)); the pattern and the handler are kept as well, so that a caller that is not
// a socket (the API tools of MCP) can run the same handler on a request that it builds, and read the answer. Nothing goes through
// the network: no second worker thread waits for the first, no port, no address.

#include <httplib.h>

#include <functional>
#include <regex>
#include <string>
#include <utility>
#include <vector>

namespace chdash {

class RoutedServer : public httplib::Server {
public:
  using httplib::Server::Delete;
  using httplib::Server::Get;
  using httplib::Server::Patch;
  using httplib::Server::Post;
  using httplib::Server::Put;

  RoutedServer& Get(const std::string& pattern, Handler handler) { return keep("GET", pattern, std::move(handler), &httplib::Server::Get); }
  RoutedServer& Post(const std::string& pattern, Handler handler) { return keep("POST", pattern, std::move(handler), &httplib::Server::Post); }
  RoutedServer& Put(const std::string& pattern, Handler handler) { return keep("PUT", pattern, std::move(handler), &httplib::Server::Put); }
  RoutedServer& Patch(const std::string& pattern, Handler handler) { return keep("PATCH", pattern, std::move(handler), &httplib::Server::Patch); }
  RoutedServer& Delete(const std::string& pattern, Handler handler) { return keep("DELETE", pattern, std::move(handler), &httplib::Server::Delete); }

  // Runs the handler of the first route that matches the method and the path of `req` (the order of registration, as the
  // server routes), with the capture groups of the pattern in req.matches. False when no route matches (`res` is not touched).
  // The handler may throw: the caller decides what that means.
  bool dispatch(httplib::Request& req, httplib::Response& res) const {
    for (const Route& route : routes_) {
      if (route.method != req.method) continue;
      std::smatch matches;
      if (!std::regex_match(req.path, matches, route.pattern)) continue;
      req.matches = std::move(matches);
      route.handler(req, res);
      return true;
    }
    return false;
  }

  // True when a route of the method matches the path.
  bool has_route(const std::string& method, const std::string& path) const {
    for (const Route& route : routes_) {
      if (route.method == method && std::regex_match(path, route.pattern)) return true;
    }
    return false;
  }

private:
  struct Route {
    std::string method;
    std::regex pattern;
    Handler handler;
  };

  using Register = httplib::Server& (httplib::Server::*)(const std::string&, Handler);

  RoutedServer& keep(const char* method, const std::string& pattern, Handler handler, Register registrar) {
    routes_.push_back({method, std::regex(pattern), handler});
    (this->*registrar)(pattern, std::move(handler));
    return *this;
  }

  std::vector<Route> routes_;
};

} // namespace chdash
