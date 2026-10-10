// libFuzzer target: the bounded JSON parse of every request body (src/json_parse.hpp).
//
// A text that parses is walked the way the handlers walk it (Accept recurses once per level), written back
// and parsed again: the depth bound must keep the walk inside the stack, and the written text must parse to the
// same value.
#include "json_parse.hpp"

#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <string>

namespace {

// Equal values; two doubles within a few units in the last place count as equal: the default parse of rapidjson
// (no kParseFullPrecisionFlag) may read a long or large literal one unit off, and read it back another unit off.
bool same(const rapidjson::Value& a, const rapidjson::Value& b) {
  if (a.IsDouble() || b.IsDouble()) {
    if (!a.IsNumber() || !b.IsNumber()) return false;
    const double x = a.GetDouble(), y = b.GetDouble();
    return x == y || std::fabs(x - y) <= 1e-14 * std::fmax(std::fabs(x), std::fabs(y));
  }
  if (a.GetType() != b.GetType()) return false;
  if (a.IsArray()) {
    if (a.Size() != b.Size()) return false;
    for (rapidjson::SizeType i = 0; i < a.Size(); ++i) if (!same(a[i], b[i])) return false;
    return true;
  }
  if (a.IsObject()) {
    if (a.MemberCount() != b.MemberCount()) return false;
    for (auto ia = a.MemberBegin(), ib = b.MemberBegin(); ia != a.MemberEnd(); ++ia, ++ib) {
      if (ia->name != ib->name || !same(ia->value, ib->value)) return false;
    }
    return true;
  }
  return a == b;
}

}  // namespace

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  const std::string text(reinterpret_cast<const char*>(data), size);

  rapidjson::Document doc;
  const bool parsed = chdash::parse_json_bounded(doc, text);
  if (parsed != !doc.HasParseError()) std::abort();
  if (chdash::json_nests_deeper_than(text, chdash::kJsonMaxDepth) && parsed) std::abort();

  rapidjson::Document strict;
  chdash::parse_json_bounded<rapidjson::kParseValidateEncodingFlag>(strict, text);

  if (parsed) {
    rapidjson::StringBuffer out;
    rapidjson::Writer<rapidjson::StringBuffer> writer(out);
    if (!doc.Accept(writer)) return 0;  // a NaN or an invalid string: the writer refuses it
    rapidjson::Document again;
    if (!chdash::parse_json_bounded(again, std::string_view(out.GetString(), out.GetSize()))) std::abort();
    if (!same(again, doc)) std::abort();
  }
  return 0;
}
