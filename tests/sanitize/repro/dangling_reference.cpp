// A reference that dangles after the full expression. GCC 13 and later report it with
// -Wdangling-reference (src/BuildFlags.cmake): g++ -std=c++17 -Wall -Wextra -Wdangling-reference -c
// The v2.16.3 bug (dangling_lambda.cpp) is a different shape, and this flag does not report it.
#include <string>
const std::string& pick(const std::string& a) { return a; }
int main() {
  const std::string& r = pick(std::string("temporary"));  // r dangles after the full expression
  return static_cast<int>(r.size());
}
