#pragma once

// This is the HTTP server. Its routes can also run in the process.
// A route is registered as before, for example http_.Get("/api/traces/search", handler).
// The pattern and the handler are kept too. A caller that is not a socket, such as the API tools of MCP, can run the same handler on a request that it builds. It can read the answer as well.
// Nothing goes through the network. No second worker thread waits for the first. There is no port and no address.

#include <httplib.h>

#include <functional>
#include <regex>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace chdash {

// A bump of cpp-httplib needs a new review of process_and_close_socket below: it repeats the loop of the library with one change.
static_assert(std::string_view(CPPHTTPLIB_VERSION) == "0.54.1", "RoutedServer::process_and_close_socket repeats the code of cpp-httplib 0.54.1: review it for the new version");

class RoutedServer : public httplib::Server {
public:
  RoutedServer() {
    // cpp-httplib reports a request line or the headers that it cannot parse to the error logger, in the thread that serves the connection,
    // just before it answers 400. The flag lets process_and_close_socket close the connection after that answer.
    set_error_logger([](const httplib::Error& error, const httplib::Request*) {
      if (error == httplib::Error::InvalidRequestLine || error == httplib::Error::InvalidHeaders) unparsable_request() = true;
    });
  }

  // A check that runs before the handler of each route that this class registers, after the server has read the body. The handlers
  // of the socket and the handlers that dispatch() runs both pass through it. It returns true when it answered: the handler then
  // does not run. The access of humans uses it for a rule whose host is in the body (server_access.cpp, check_access_body).
  using BeforeHandler = std::function<bool(const httplib::Request&, httplib::Response&)>;
  void set_before_handler(BeforeHandler check) { before_handler_ = std::move(check); }

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

  // Runs the handler of the first route that matches the method and the path of `req`. The routes are checked in the order of registration, as the server checks them.
  // The capture groups of the pattern are put in req.matches. It returns false when no route matches. In that case, `res` is not touched.
  // The handler may throw. The caller decides what that means.
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
  // True from the report of a request that cannot be parsed, until the next request of the thread starts.
  static bool& unparsable_request() {
    static thread_local bool flag = false;
    return flag;
  }

  // The loop of cpp-httplib that serves one connection, with one change. The library answers 400 with "Connection: close" to a bad request line or to
  // bad headers, but it keeps the connection and reads the next bytes as a new request. A gateway that reuses the connection would then have bytes
  // of one request read as another. The connection closes after any request that cannot be parsed. The other refusals of the library close it already.
  bool process_and_close_socket(socket_t sock) override {
    std::string remote_addr;
    int remote_port = 0;
    httplib::detail::get_remote_ip_and_port(sock, remote_addr, remote_port);

    std::string local_addr;
    int local_port = 0;
    httplib::detail::get_local_ip_and_port(sock, local_addr, local_port);

    bool websocket_upgraded = false;
    const bool ret = serve_guarded([&]() {
      return httplib::detail::process_server_socket(
          svr_sock_, sock, keep_alive_max_count_, keep_alive_timeout_sec_, read_timeout_sec_, read_timeout_usec_, write_timeout_sec_, write_timeout_usec_,
          [&](httplib::Stream& strm, bool close_connection, bool& connection_closed) {
            unparsable_request() = false;
            const bool answered = process_request(strm, remote_addr, remote_port, local_addr, local_port, close_connection, connection_closed, nullptr,
                                                  &websocket_upgraded);
            if (unparsable_request()) connection_closed = true;
            return answered;
          });
    });

    httplib::detail::drain_and_close_socket(sock);
    return ret;
  }

  struct Route {
    std::string method;
    std::regex pattern;
    Handler handler;
  };

  using Register = httplib::Server& (httplib::Server::*)(const std::string&, Handler);

  RoutedServer& keep(const char* method, const std::string& pattern, Handler handler, Register registrar) {
    // The check reads before_handler_ when the request comes, so a check that is set after the routes still applies to them.
    Handler checked = [this, handler = std::move(handler)](const httplib::Request& req, httplib::Response& res) {
      if (before_handler_ && before_handler_(req, res)) return;
      handler(req, res);
    };
    routes_.push_back({method, std::regex(pattern), checked});
    (this->*registrar)(pattern, std::move(checked));
    return *this;
  }

  std::vector<Route> routes_;
  BeforeHandler before_handler_;
};

} // namespace chdash
