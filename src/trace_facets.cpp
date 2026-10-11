#include "trace_facets.hpp"

#include "ch_block_value.hpp"
#include "sql_literal.hpp"

#include <algorithm>
#include <iterator>

namespace chdash {
namespace trace {

using sql::quote_string;

void read_schema(ChExecutor& db, const TraceSettings& traces, MetaOutcome* out) {
  std::set<std::string> columns;
  const std::string database = quote_string(traces.database);
  const std::string table = quote_string(traces.table);
  db.select("SELECT toString(name) FROM system.columns WHERE database = " + database + " AND `table` = " + table,
            [&](const clickhouse::Block& block) {
    for (size_t row = 0; row < block.GetRowCount(); ++row) columns.insert(ch_block_text_at(block, 0, row));
  });
  const char* required[] = {"Timestamp", "TraceId", "SpanId", "ParentSpanId", "SpanName", "ServiceName", "Duration", "StatusCode"};
  out->schema_ok = std::all_of(std::begin(required), std::end(required), [&](const char* name) { return columns.count(name) != 0; });

  if (!traces.trace_index_table.empty()) {
    uint64_t count = 0;
    db.select("SELECT toString(count()) FROM system.tables WHERE database = " + database +
                  " AND name = " + quote_string(traces.trace_index_table),
              [&](const clickhouse::Block& block) {
      if (block.GetRowCount()) count = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 0, 0)));
    });
    out->index_available = count > 0;
  }
}

std::string prefill_excluded_sql(const std::set<std::pair<std::string, std::string>>& known) {
  std::string excluded;
  if (known.empty()) return excluded;
  for (const auto& [service, operation] : known) {
    if (excluded.size() > kPrefillExcludeBytes) break;
    excluded += (excluded.empty() ? "(" : ", (") + quote_string(service) + ", " + quote_string(operation) + ")";
  }
  return " AND (ServiceName, SpanName) NOT IN (" + excluded + ")";
}

std::string prefill_pass_sql(const std::string& table, int64_t from_ms, int64_t end_ms, const std::string& visibility,
                             const std::string& tag_filters, const std::string& excluded, uint64_t cap) {
  return "SELECT toString(ServiceName), toString(SpanName) FROM " + table +
         " PREWHERE " + time_predicate(from_ms, end_ms) + " WHERE " + visibility + tag_filters + excluded +
         " LIMIT 1 BY ServiceName, SpanName LIMIT " + std::to_string(kPrefillHardLimit + 1) + facet_settings_sql(cap, false);
}

Prefill read_prefill(ChExecutor& db, const std::string& table, const std::string& visibility, const std::string& tag_filters,
                     int64_t aligned_start_ms, int64_t aligned_end_ms, uint64_t read_budget) {
  Prefill value;
  const uint64_t pass_rows = std::min(read_budget, kPrefillPassRows);
  std::set<std::pair<std::string, std::string>> known;
  uint64_t rows_left = read_budget;
  bool complete = false;
  bool stopped = false;
  auto pass = [&](int64_t from_ms, bool exclude) {
    const uint64_t cap = std::min<uint64_t>(rows_left, pass_rows);
    const std::string excluded = exclude ? prefill_excluded_sql(known) : std::string{};
    size_t found = 0;
    const BoundedRead read = db.bounded_select(
        prefill_pass_sql(table, from_ms, aligned_end_ms, visibility, tag_filters, excluded, cap), [&](const clickhouse::Block& block) {
          for (size_t row = 0; row < block.GetRowCount(); ++row) {
            if (known.emplace(ch_block_text_at(block, 0, row), ch_block_text_at(block, 1, row)).second) ++found;
          }
        });
    rows_left -= std::min(rows_left, read.read_rows);
    ++value.passes;
    value.read_rows += read.read_rows;
    if (timed_out(read) || known.size() > kPrefillHardLimit) stopped = true;
    return std::make_pair(read.capped(cap) || timed_out(read), found);
  };
  const int64_t seed_start_ms = std::max(aligned_start_ms, aligned_end_ms - kPrefillSeedMs);
  if (seed_start_ms > aligned_start_ms) pass(seed_start_ms, false);
  for (int i = 0; i < kPrefillMaxPasses && !stopped && !complete && rows_left > 0; ++i) {
    const auto [cut, found] = pass(aligned_start_ms, true);
    complete = !cut;
    // A cut pass that found nothing new would read the same granules again.
    if (cut && found == 0) break;
  }
  value.estimated = !complete && known.size() <= kPrefillHardLimit;
  value.pairs.assign(known.begin(), known.end());
  std::sort(value.pairs.begin(), value.pairs.end());
  value.truncated = value.pairs.size() > kPrefillHardLimit;
  if (value.truncated) value.pairs.resize(kPrefillHardLimit);
  value.start_ms = aligned_start_ms;
  value.end_ms = aligned_end_ms;
  return value;
}

std::string facet_keys_sql(const std::string& table, int64_t aligned_start_ms, int64_t aligned_end_ms, const std::string& visibility,
                           const std::string& span_filters, bool span, bool resource, uint64_t read_cap) {
  const std::string ones = "arrayResize([toUInt64(1)], length(%), toUInt64(1))";
  auto sum_map = [&](const std::string& column) {
    std::string counts = ones;
    counts.replace(counts.find('%'), 1, column);
    return "sumMap(" + column + ", " + counts + ")";
  };
  std::vector<std::string> inner_columns, aggregates, tuples;
  if (span) {
    inner_columns.push_back("SpanAttributes.keys AS sk");
    aggregates.push_back(sum_map("sk") + " AS sm");
    tuples.push_back("arrayMap((k, c) -> tuple('span', toString(k), c), sm.1, sm.2)");
  }
  if (resource) {
    inner_columns.push_back("ResourceAttributes.keys AS rk");
    aggregates.push_back(sum_map("rk") + " AS rm");
    tuples.push_back("arrayMap((k, c) -> tuple('resource', toString(k), c), rm.1, rm.2)");
  }
  auto join = [](const std::vector<std::string>& parts) {
    std::string out;
    for (size_t i = 0; i < parts.size(); ++i) out += (i ? ", " : "") + parts[i];
    return out;
  };
  return "SELECT toString(sampled), toString(t.1), toString(t.2), toString(t.3) FROM ("
         "SELECT count() AS sampled, " + join(aggregates) + " FROM ("
         "SELECT " + join(inner_columns) + " FROM " + table +
         " PREWHERE " + time_predicate(aligned_start_ms, aligned_end_ms) +
         " WHERE " + visibility + span_filters +
         " LIMIT " + std::to_string(kFacetSampleRows) + ")) LEFT ARRAY JOIN arrayConcat(" + join(tuples) + ") AS t" +
         // The served keys only (and one more, which says truncated), in the order of the sort below.
         " ORDER BY t.3 DESC, t.2 ASC, t.1 DESC LIMIT " + std::to_string(kFacetMaxKeys + 1) +
         facet_settings_sql(read_cap, false);
}

std::string facet_values_sql(const std::string& table, int64_t aligned_start_ms, int64_t aligned_end_ms, const std::string& visibility,
                             const std::string& span_filters, const std::string& key_scope, const std::string& key, int limit,
                             uint64_t read_cap) {
  const std::string column = key_scope == "span" ? "SpanAttributes" : "ResourceAttributes";
  return "SELECT toString(v), toString(c), toString(sum(c) OVER ()), toString(count() OVER ()) FROM ("
         "SELECT v, count() AS c FROM ("
         "SELECT " + column + "[" + quote_string(key) + "] AS v FROM " + table +
         " PREWHERE " + time_predicate(aligned_start_ms, aligned_end_ms) +
         " WHERE " + visibility + " AND mapContains(" + column + ", " + quote_string(key) + ")" +
         span_filters + " LIMIT " + std::to_string(kFacetSampleRows) + ") GROUP BY v) "
         "ORDER BY c DESC, v LIMIT " + std::to_string(limit) + facet_settings_sql(read_cap, true);
}

FacetKeys read_facet_keys(ChExecutor& db, const std::string& sql, uint64_t read_cap) {
  FacetKeys value;
  const BoundedRead read = db.bounded_select(sql, [&](const clickhouse::Block& block) {
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      value.sampled_spans = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 0, row)));
      const std::string key_scope = ch_block_text_at(block, 1, row);
      if (key_scope.empty()) continue;
      value.keys.push_back(FacetKeys::Key{key_scope, ch_block_text_at(block, 2, row),
                                          static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 3, row)))});
    }
  });
  value.timed_out = timed_out(read);
  // The sample LIMIT, the read cap or the time budget stopped it.
  value.estimated = value.sampled_spans >= kFacetSampleRows || read.capped(read_cap) || value.timed_out;
  value.query_ms = read.elapsed_ms;
  std::sort(value.keys.begin(), value.keys.end(), [](const FacetKeys::Key& a, const FacetKeys::Key& b) {
    if (a.count != b.count) return a.count > b.count;
    if (a.key != b.key) return a.key < b.key;
    return a.scope > b.scope;  // span before resource
  });
  if (value.keys.size() > kFacetMaxKeys + 1) value.keys.resize(kFacetMaxKeys + 1);
  return value;
}

FacetValues read_facet_values(ChExecutor& db, const std::string& sql, uint64_t read_cap) {
  FacetValues value;
  const BoundedRead read = db.bounded_select(sql, [&](const clickhouse::Block& block) {
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      value.values.emplace_back(ch_block_text_at(block, 0, row), static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 1, row))));
      value.spans_with_key = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 2, row)));
      value.distinct_values = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 3, row)));
    }
  });
  value.timed_out = timed_out(read);
  value.estimated = value.spans_with_key >= kFacetSampleRows || read.capped(read_cap) || value.timed_out ||
      value.distinct_values >= kFacetGroupByCap;
  value.query_ms = read.elapsed_ms;
  return value;
}

}  // namespace trace
}  // namespace chdash
