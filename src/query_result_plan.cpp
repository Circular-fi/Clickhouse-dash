#include "query_result_plan.hpp"

#include "sql_literal.hpp"

#include <clickhouse/columns/string.h>

#include <mutex>
#include <unordered_map>

namespace chdash {

namespace {
using sql::quote_ident;
}

// ClickHouse can pretty-print complex types that DESCRIBE returns, with newlines and indentation.
// This produces noisy JSON ("\n    ") in result_meta. The code normalizes the type to a single line.
// The type stays parseable for the frontend.
std::string normalize_type_string(std::string s) {
  std::string out;
  out.reserve(s.size());

  bool space_pending = false;
  bool in_squote = false;
  bool in_btick = false;

  auto is_ws = [](unsigned char c) {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v';
  };

  for (size_t i = 0; i < s.size(); ++i) {
    const char ch = s[i];
    const char prev = (i > 0) ? s[i - 1] : '\0';

    // Keep the content inside quotes and backticks. This is a best-effort step.
    if (!in_btick && ch == '\'' && prev != '\\') {
      in_squote = !in_squote;
      space_pending = false;
      out.push_back(ch);
      continue;
    }
    if (!in_squote && ch == '`') {
      in_btick = !in_btick;
      space_pending = false;
      out.push_back(ch);
      continue;
    }
    if (in_squote || in_btick) {
      out.push_back(ch);
      continue;
    }

    if (is_ws(static_cast<unsigned char>(ch))) {
      space_pending = true;
      continue;
    }

    if (!out.empty() && (ch == ')' || ch == ']' || ch == '}' || ch == ',')) {
      while (!out.empty() && out.back() == ' ') out.pop_back();
    }

    if (space_pending) {
      const char last = out.empty() ? '\0' : out.back();
      const bool no_space_before = (ch == ')' || ch == ']' || ch == '}' || ch == ',');
      const bool no_space_after = (last == '(' || last == '[' || last == '{' || last == ',');
      if (!no_space_before && !no_space_after && last != ' ' && last != '\0') {
        out.push_back(' ');
      }
      space_pending = false;
    }

    out.push_back(ch);
    if (ch == ',') {
      out.push_back(' ');
    }
  }

  // Trim.
  while (!out.empty() && out.back() == ' ') out.pop_back();
  size_t start = 0;
  while (start < out.size() && out[start] == ' ') start++;
  if (start > 0) out.erase(0, start);

  return out;
}

bool icontains(std::string_view hay, std::string_view needle) {
  if (needle.empty()) return true;
  for (size_t i = 0; i + needle.size() <= hay.size(); ++i) {
    bool ok = true;
    for (size_t j = 0; j < needle.size(); ++j) {
      char a = hay[i + j];
      char b = needle[j];
      if (a >= 'A' && a <= 'Z') a = char(a - 'A' + 'a');
      if (b >= 'A' && b <= 'Z') b = char(b - 'A' + 'a');
      if (a != b) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

bool iequals_ascii(std::string_view a, std::string_view b) {
  if (a.size() != b.size()) return false;
  for (size_t i = 0; i < a.size(); ++i) {
    char x = a[i];
    char y = b[i];
    if (x >= 'A' && x <= 'Z') x = char(x - 'A' + 'a');
    if (y >= 'A' && y <= 'Z') y = char(y - 'A' + 'a');
    if (x != y) return false;
  }
  return true;
}

static std::string trim_copy(std::string s) {
  auto is_ws = [](char ch) {
    return ch == ' ' || ch == 9 || ch == 10 || ch == 13;
  };
  while (!s.empty() && is_ws(s.front())) s.erase(s.begin());
  while (!s.empty() && is_ws(s.back())) s.pop_back();
  return s;
}

std::string strip_trailing_semicolon_copy(std::string s) {
  s = trim_copy(std::move(s));
  if (!s.empty() && s.back() == ';') {
    s.pop_back();
    s = trim_copy(std::move(s));
  }
  return s;
}

struct CachedDescribePlan {
  ResultPlan plan;
  std::chrono::steady_clock::time_point expires_at{};
  uint64_t access_sequence = 0;
};

struct DescribePlanCache::Impl {
  std::mutex mu;
  std::unordered_map<std::string, CachedDescribePlan> plans;
  uint64_t sequence = 0;
};

DescribePlanCache::DescribePlanCache() : impl(std::make_unique<Impl>()) {}
DescribePlanCache::~DescribePlanCache() = default;

static uint64_t fnv1a64(std::string_view value, uint64_t seed) {
  uint64_t hash = seed;
  for (const unsigned char ch : value) {
    hash ^= ch;
    hash *= UINT64_C(1099511628211);
  }
  return hash;
}

std::string describe_cache_key(
    std::string_view host_id,
    std::string_view database,
    std::string_view sql
) {
  // Keep the cache keys small, even for editor buffers of several hundred kilobytes.
  // Two independently seeded 64-bit hashes and the SQL length make accidental
  // collisions negligible. The cache is local to the process and short-lived.
  const uint64_t hash_a = fnv1a64(sql, UINT64_C(14695981039346656037));
  const uint64_t hash_b = fnv1a64(sql, UINT64_C(7809847782465536322));
  std::string key;
  key.reserve(host_id.size() + database.size() + 64);
  key.append(host_id.data(), host_id.size());
  key.push_back('\x1f');
  key.append(database.data(), database.size());
  key.push_back('\x1f');
  key += std::to_string(sql.size());
  key.push_back(':');
  key += std::to_string(hash_a);
  key.push_back(':');
  key += std::to_string(hash_b);
  return key;
}

std::optional<ResultPlan> get_cached_describe_plan(
    DescribePlanCache* cache,
    const std::string& key,
    size_t max_entries,
    int ttl_ms
) {
  if (!cache || max_entries == 0 || ttl_ms <= 0) return std::nullopt;
  const auto now = std::chrono::steady_clock::now();
  auto& state = *cache->impl;
  std::lock_guard<std::mutex> lk(state.mu);
  auto it = state.plans.find(key);
  if (it == state.plans.end()) return std::nullopt;
  if (it->second.expires_at <= now) {
    state.plans.erase(it);
    return std::nullopt;
  }
  it->second.access_sequence = ++state.sequence;
  return it->second.plan;
}

void put_cached_describe_plan(
    DescribePlanCache* cache,
    const std::string& key,
    ResultPlan plan,
    size_t max_entries,
    int ttl_ms
) {
  if (!cache || key.empty() || plan.empty() || max_entries == 0 || ttl_ms <= 0) return;
  const auto now = std::chrono::steady_clock::now();
  auto& state = *cache->impl;
  std::lock_guard<std::mutex> lk(state.mu);

  for (auto it = state.plans.begin(); it != state.plans.end();) {
    if (it->second.expires_at <= now) it = state.plans.erase(it);
    else ++it;
  }

  CachedDescribePlan entry;
  entry.plan = std::move(plan);
  entry.expires_at = now + std::chrono::milliseconds(ttl_ms);
  entry.access_sequence = ++state.sequence;
  state.plans[key] = std::move(entry);

  while (state.plans.size() > max_entries) {
    auto victim = state.plans.begin();
    for (auto it = std::next(state.plans.begin()); it != state.plans.end(); ++it) {
      if (it->second.access_sequence < victim->second.access_sequence) victim = it;
    }
    state.plans.erase(victim);
  }
}

void invalidate_cached_describe_plan(DescribePlanCache* cache, const std::string& key) {
  if (!cache || key.empty()) return;
  std::lock_guard<std::mutex> lk(cache->impl->mu);
  cache->impl->plans.erase(key);
}

const char* transport_mode_name(ResultTransportMode mode) {
  switch (mode) {
    case ResultTransportMode::Passthrough: return "passthrough";
    case ResultTransportMode::Stringify: return "stringify";
    case ResultTransportMode::Opaque: return "opaque";
  }
  return "passthrough";
}

bool unwrap_outer_type(std::string_view type, std::string_view outer_name, std::string_view* inner_out) {
  if (type.size() <= outer_name.size() + 2) return false;
  if (!iequals_ascii(type.substr(0, outer_name.size()), outer_name)) return false;
  if (type[outer_name.size()] != '(' || type.back() != ')') return false;

  int depth = 0;
  for (size_t i = outer_name.size(); i < type.size(); ++i) {
    const char ch = type[i];
    if (ch == '(') depth++;
    else if (ch == ')') {
      depth--;
      if (depth == 0 && i != type.size() - 1) return false;
    }
  }
  if (depth != 0) return false;

  if (inner_out) {
    *inner_out = type.substr(outer_name.size() + 1, type.size() - outer_name.size() - 2);
  }
  return true;
}

bool is_top_level_nullable_type(std::string_view type) {
  std::string_view inner;
  return unwrap_outer_type(type, "Nullable", &inner);
}

static bool has_json_like_type(std::string_view type) {
  return icontains(type, "JSON") || icontains(type, "Dynamic") || icontains(type, "Object(");
}

static bool has_256_bit_int_type(std::string_view type) {
  return icontains(type, "UInt256") || icontains(type, "Int256");
}

// clickhouse-cpp reads Decimal32/64/128 natively, up to a precision of 38.
// The cell encoder writes them at their scale. Only a wider Decimal needs text.
// Decimal256 is one such type: DESCRIBE prints Decimal(76, S).
static bool has_wide_decimal_type(std::string_view type) {
  if (icontains(type, "Decimal256")) return true;
  for (size_t at = 0; at + 8 < type.size(); ++at) {
    if (!iequals_ascii(type.substr(at, 8), "Decimal(")) continue;
    size_t i = at + 8;
    while (i < type.size() && type[i] == ' ') ++i;
    int precision = 0;
    bool digits = false;
    while (i < type.size() && type[i] >= '0' && type[i] <= '9' && precision < 1000) {
      precision = precision * 10 + (type[i] - '0');
      digits = true;
      ++i;
    }
    if (digits && precision > 38) return true;
  }
  return false;
}

// A type with a structure (Array, Map, Tuple, Nested, JSON, Dynamic, Variant) is sent as the JSON text
// of toJSONString(). A scalar is sent as the text of toString(). This text is exact.
// toJSONString() drops the trailing zeros of a Decimal.
bool is_structured_type(std::string_view type) {
  std::string_view inner = type;
  for (int guard = 0; guard < 4; ++guard) {
    std::string_view next;
    if (unwrap_outer_type(inner, "Nullable", &next) || unwrap_outer_type(inner, "LowCardinality", &next)) {
      inner = next;
      continue;
    }
    break;
  }
  for (const std::string_view outer : {"Array(", "Map(", "Tuple(", "Nested(", "Variant("}) {
    if (inner.size() >= outer.size() && iequals_ascii(inner.substr(0, outer.size()), outer)) return true;
  }
  return has_json_like_type(inner);
}

bool is_bool_type_name(std::string_view type) {
  std::string_view inner;
  if (unwrap_outer_type(type, "Nullable", &inner)) type = inner;
  return iequals_ascii(type, "Bool");
}

static bool has_aggregate_function_type(std::string_view type) {
  return icontains(type, "AggregateFunction(");
}

ResultTransportMode classify_result_transport(std::string_view type) {
  if (has_aggregate_function_type(type)) return ResultTransportMode::Opaque;
  if (has_256_bit_int_type(type) || has_json_like_type(type) || has_wide_decimal_type(type)) {
    return ResultTransportMode::Stringify;
  }
  return ResultTransportMode::Passthrough;
}


bool should_retry_with_describe_after_direct_path_error(std::string_view msg) {
  return icontains(msg, "unimplemented") ||
         icontains(msg, "unsupported column type") ||
         icontains(msg, "unsupported type") ||
         icontains(msg, "unsupported custom serialization") ||
         icontains(msg, "unsupported json serialization version") ||
         icontains(msg, "output_format_native_write_json_as_string") ||
         icontains(msg, "cannot create column") ||
         icontains(msg, "cannot read data") ||
         icontains(msg, "cannot parse type");
}

std::string build_projected_expr(const std::string& col_name, const ResultColumnPlan& plan) {
  const std::string ref = std::string("_q.") + quote_ident(col_name);
  const std::string alias = quote_ident(col_name);
  const bool nullable = is_top_level_nullable_type(plan.original_type);

  if (plan.mode == ResultTransportMode::Passthrough) {
    return ref + " AS " + alias;
  }

  std::string converted;
  if (plan.mode == ResultTransportMode::Opaque || !is_structured_type(plan.original_type)) {
    converted = "toString(" + ref + ")";
  } else {
    converted = "toJSONString(" + ref + ")";
  }

  if (nullable) {
    converted = "if(isNull(" + ref + "), CAST(NULL AS Nullable(String)), " + converted + ")";
  }
  return converted + " AS " + alias;
}

std::string build_transport_wrapper_sql(
  const std::string& original_sql,
  const std::vector<std::pair<std::string, ResultColumnPlan>>& columns,
  bool* used_wrapper_out
) {
  bool needs_wrapper = false;
  for (const auto& kv : columns) {
    if (kv.second.mode != ResultTransportMode::Passthrough) {
      needs_wrapper = true;
      break;
    }
  }
  if (used_wrapper_out) *used_wrapper_out = needs_wrapper;
  if (!needs_wrapper || columns.empty()) {
    return original_sql;
  }

  std::string out;
  out.reserve(original_sql.size() + columns.size() * 64 + 32);
  out += "SELECT\n";
  for (size_t i = 0; i < columns.size(); ++i) {
    out += "    ";
    out += build_projected_expr(columns[i].first, columns[i].second);
    if (i + 1 < columns.size()) out.push_back(',');
    out.push_back('\n');
  }
  out += "FROM\n(\n";
  out += strip_trailing_semicolon_copy(original_sql);
  out += "\n) AS _q";
  return out;
}

void add_described_columns(const clickhouse::Block& b, ResultPlan* described) {
  if (b.GetRowCount() == 0 || b.GetColumnCount() < 2) return;

  int idx_name = -1;
  int idx_type = -1;
  for (size_t i = 0; i < b.GetColumnCount(); ++i) {
    const auto& cn = b.GetColumnName(i);
    if (cn == "name") idx_name = static_cast<int>(i);
    else if (cn == "type") idx_type = static_cast<int>(i);
  }
  if (idx_name < 0) idx_name = 0;
  if (idx_type < 0) idx_type = 1;

  auto c_name = b[idx_name]->As<clickhouse::ColumnString>();
  auto c_type = b[idx_type]->As<clickhouse::ColumnString>();
  if (!c_name || !c_type) return;

  for (size_t r = 0; r < b.GetRowCount(); ++r) {
    const std::string_view n = c_name->At(r);
    const std::string normalized_type = normalize_type_string(std::string(c_type->At(r)));
    ResultColumnPlan plan;
    plan.original_type = normalized_type;
    plan.mode = classify_result_transport(normalized_type);
    plan.transport_type = (plan.mode == ResultTransportMode::Passthrough)
      ? normalized_type
      : (is_top_level_nullable_type(normalized_type)
          ? std::string("Nullable(String)")
          : std::string("String"));
    described->emplace_back(std::string(n), std::move(plan));
  }
}

std::vector<const ResultColumnPlan*> resolve_column_plans(const clickhouse::Block& block, const ResultPlan& result_plan) {
  std::vector<const ResultColumnPlan*> resolved_column_plans(block.GetColumnCount(), nullptr);
  if (result_plan.size() == block.GetColumnCount()) {
    for (size_t i = 0; i < block.GetColumnCount(); ++i) {
      resolved_column_plans[i] = &result_plan[i].second;
    }
  } else if (!result_plan.empty()) {
    // A defensive fallback for servers that reorder the DESCRIBE metadata.
    for (size_t i = 0; i < block.GetColumnCount(); ++i) {
      const auto& block_name = block.GetColumnName(i);
      for (const auto& item : result_plan) {
        if (item.first == block_name) {
          resolved_column_plans[i] = &item.second;
          break;
        }
      }
    }
  }
  return resolved_column_plans;
}

} // namespace chdash
