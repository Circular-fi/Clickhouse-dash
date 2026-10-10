// libFuzzer target: the "no direct KILL QUERY" policy of the Query page and the exports (src/user_sql_policy.cpp).
//
// Besides the crashes, three properties: a script that starts with KILL QUERY is refused whatever follows, with any
// space between the words that the ClickHouse lexer takes (Unicode spaces too, SEC-011); and text added after a
// refused script does not make it acceptable (each statement is judged where it starts).
#include "user_sql_policy.hpp"

#include <cstdint>
#include <cstdlib>
#include <string>

namespace {

// The separators of the ClickHouse lexer: the ASCII spaces and the Unicode spaces it skips (UTF-8).
const char* const kSpaces[] = {
    " ", "\t", "\n", "\r", "\v", "\f", "\xC2\x85", "\xC2\xA0", "\xE1\xA0\x8E", "\xE2\x80\x80", "\xE2\x80\x83",
    "\xE2\x80\x8B", "\xE2\x80\x8D", "\xE2\x80\xA8", "\xE2\x80\xA9", "\xE2\x80\xAF", "\xE2\x81\x9F", "\xE2\x81\xA0",
    "\xE3\x80\x80", "\xEF\xBB\xBF", "/* c */", "-- c\n",
};

}  // namespace

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  const std::string sql(reinterpret_cast<const char*>(data), size);
  const bool forbidden = chdash::user_sql_is_forbidden(sql);
  if (!chdash::user_sql_is_forbidden("KILL QUERY WHERE 1;" + sql)) std::abort();
  if (!chdash::user_sql_is_forbidden(" kill\tquery where 1\n;" + sql)) std::abort();
  if (size > 0) {
    const size_t count = sizeof kSpaces / sizeof kSpaces[0];
    const std::string before = kSpaces[data[0] % count], between = kSpaces[(data[0] / count) % count];
    if (!chdash::user_sql_is_forbidden(before + "KILL" + between + "QUERY WHERE 1;" + sql)) std::abort();
  }
  if (forbidden && !chdash::user_sql_is_forbidden(sql + "\n;SELECT 1")) std::abort();
  return 0;
}
