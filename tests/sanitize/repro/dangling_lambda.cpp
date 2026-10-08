// Reproduction of the v2.16.3 bug: a handler stored in a std::function calls another LOCAL lambda
// of the constructor through a [&] capture. The local lambda dies when the constructor returns.
#include <functional>
#include <iostream>
#include <string>
#include <vector>

struct Config { bool traces = false; bool logs = true; };

class Server {
 public:
  explicit Server(Config cfg) : cfg_(cfg) {
    // A local lambda that reads the configuration.
    const auto first_view = [&]() -> std::string {
      if (cfg_.traces) return "traces";
      if (cfg_.logs) return "logs";
      return "";
    };
    // The handler outlives the constructor but holds first_view by reference.
    handlers_.push_back([&](const std::string& path) {
      return path + " -> " + first_view();
    });
  }
  std::string handle(const std::string& path) { return handlers_.front()(path); }

 private:
  Config cfg_;
  std::vector<std::function<std::string(const std::string&)>> handlers_;
};

int main() {
  Server server(Config{});
  std::cout << server.handle("/observability") << "\n";
}
