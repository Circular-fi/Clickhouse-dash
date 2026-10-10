// libFuzzer target: the "no direct KILL QUERY" policy of the Query page and the exports (src/user_sql_policy.cpp).
//
// Besides the crashes, two properties: a script that starts with KILL QUERY is refused whatever follows, and text
// added after a refused script does not make it acceptable (each statement is judged where it starts).
#include "user_sql_policy.hpp"

#include <cstdint>
#include <cstdlib>
#include <string>

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  const std::string sql(reinterpret_cast<const char*>(data), size);
  const bool forbidden = chdash::user_sql_is_forbidden(sql);
  if (!chdash::user_sql_is_forbidden("KILL QUERY WHERE 1;" + sql)) std::abort();
  if (!chdash::user_sql_is_forbidden(" kill\tquery where 1\n;" + sql)) std::abort();
  if (forbidden && !chdash::user_sql_is_forbidden(sql + "\n;SELECT 1")) std::abort();
  return 0;
}
