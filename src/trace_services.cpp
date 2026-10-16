#include "trace_services.hpp"

#include "ch_block_numeric.hpp"
#include "ch_block_value.hpp"
#include "log.hpp"
#include "trace_request.hpp"

#include <algorithm>
#include <chrono>

namespace chdash {
namespace trace {

namespace {

uint64_t elapsed_ms_since(std::chrono::steady_clock::time_point since) {
  return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - since).count());
}

uint64_t estimate_window_rows(ChExecutor& db, const std::string& from) {
  uint64_t rows = 0;
  db.select(services_estimate_sql(from), [&](const clickhouse::Block& block) {
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      if (block.GetColumnCount() >= 4) rows += ch_block_u64_at(block, 3, row);
    }
  });
  return rows;
}

}  // namespace

Result<ServicesOutcome> run_services(ChExecutor& db, const ServicesQuery& query) {
  using Out = Result<ServicesOutcome>;
  ServicesOutcome out;
  out.span_kind = query.span_scope == "root" ? kServiceRootSpans : kServiceEntrySpans;
  const bool detail = !query.detail.empty();

  // The count chart grid of /api/traces/analytics has the same bucket sizes and the same bucket_origin_ms anchor. The
  // parameter align_buckets widens the window to whole buckets.
  out.bucket_ms = static_cast<int64_t>(choose_bucket_seconds(query.end_ms - query.start_ms)) * 1000;
  out.origin_ms = grid_origin_ms(query.bucket_origin_ms, out.bucket_ms);
  out.range_start_ms = query.align_buckets ? grid_floor_ms(query.start_ms, out.bucket_ms, out.origin_ms) : query.start_ms;
  out.range_end_ms = query.align_buckets ? grid_floor_ms(query.end_ms + out.bucket_ms - 1, out.bucket_ms, out.origin_ms) : query.end_ms;

  uint64_t estimated_rows = 0;
  try {
    const auto started = std::chrono::steady_clock::now();
    estimated_rows = estimate_window_rows(db, services_from(query.table, time_predicate(query.start_ms, query.end_ms), out.span_kind,
                                                            query.visibility, query.where));
    out.estimate_ms = elapsed_ms_since(started);
  } catch (const std::exception& e) {
    log_event(LogLevel::Warn, "traces.estimate_failed", {{"route", "services"}, {"error", std::string(e.what()).substr(0, 300)}});
    // Without an estimate, the window is read whole. The read is still time-bounded.
    db.invalidate();
    std::string error;
    if (!db.renew(&error)) {
      return Out::fail(make_error(503, "trace_source_unavailable", error.empty() ? "Cannot connect to trace ClickHouse source." : error));
    }
  }
  out.window = services_window(query.start_ms, query.end_ms, out.bucket_ms, out.origin_ms, estimated_rows, query.exact);
  const std::string from = services_from(query.table, out.window.time_sql, out.span_kind, query.visibility, query.where);

  std::map<std::string, ServiceStats> endpoints;
  try {
    out.read = db.bounded_select(services_sql(from, out.bucket_ms, out.origin_ms, detail), [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        ServiceStats stats;
        stats.spans = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 4, row)));
        stats.errors = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 5, row)));
        const auto quantiles = split_char(ch_block_text_at(block, 6, row), ',');
        if (quantiles.size() >= 3) {
          stats.p50 = static_cast<uint64_t>(std::stoull(quantiles[0]));
          stats.p95 = static_cast<uint64_t>(std::stoull(quantiles[1]));
          stats.p99 = static_cast<uint64_t>(std::stoull(quantiles[2]));
        }
        stats.total_ns = std::stod(ch_block_text_at(block, 7, row));
        const int set = std::stoi(ch_block_text_at(block, 0, row));
        const std::string service = ch_block_text_at(block, 1, row);
        if (set == 3) out.services[service] = stats;
        else if (set == 1) out.series[service][std::stoll(ch_block_text_at(block, 2, row))] = stats;
        else if (set == 2 && detail) endpoints[ch_block_text_at(block, 3, row)] = stats;
      }
    });
  } catch (...) {
    db.invalidate();
    throw;
  }
  // Only the time budget stops this read. The skip indexes and the slices can make read_rows smaller than total_rows, even
  // without any cap.
  out.partial = out.read.elapsed_ms + 250 >= static_cast<uint64_t>(kServicesTimeBudgetSeconds) * 1000;

  // Detail: the slowest entry spans of the sampled window, and the releases.
  if (detail) {
    try {
      const auto started = std::chrono::steady_clock::now();
      db.select(services_slowest_sql(from), [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          out.slowest.push_back(SlowSpan{ch_block_text_at(block, 0, row), ch_block_text_at(block, 1, row),
                                         ch_block_text_at(block, 2, row), ch_block_text_at(block, 5, row),
                                         std::stoll(ch_block_text_at(block, 3, row)),
                                         static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 4, row)))});
        }
      });
      out.slowest_ms = elapsed_ms_since(started);
    } catch (...) {
      db.invalidate();
      throw;
    }
    // Releases (HyperDX useReleaseAnnotations) use the first span of each service.version in the whole window, with any span
    // kind. The bloom filter index of the key skips the granules that do not have the key. A read cap bounds the rest of the
    // granules.
    out.releases_supported = query.releases_supported;
    if (out.releases_supported) {
      try {
        const BoundedRead release_read = db.bounded_select(
            services_releases_sql(query.table, query.start_ms, query.end_ms, query.detail, query.visibility),
            [&](const clickhouse::Block& block) {
              for (size_t row = 0; row < block.GetRowCount(); ++row) {
                out.releases.push_back(Release{ch_block_text_at(block, 0, row), std::stoll(ch_block_text_at(block, 1, row)),
                                               static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 2, row)))});
              }
            });
        out.releases_estimated = release_read.read_rows >= kServicesReleaseReadRowsCap || timed_out(release_read);
        out.releases_ms = release_read.elapsed_ms;
      } catch (const std::exception& e) {
        log_event(LogLevel::Warn, "traces.release_markers_failed", {{"error", std::string(e.what()).substr(0, 300)}});
        // Markers are only decoration. A failure leaves them out.
        db.invalidate();
        out.releases.clear();
        out.releases_estimated = true;
      }
    }
  }

  out.endpoints.assign(endpoints.begin(), endpoints.end());
  std::sort(out.endpoints.begin(), out.endpoints.end(), [](const auto& a, const auto& b) {
    if (a.second.total_ns != b.second.total_ns) return a.second.total_ns > b.second.total_ns;
    return a.first < b.first;
  });
  return Out::ok(std::move(out));
}

DbOutcome run_services_db(ChExecutor& db, const ServicesQuery& query, bool supported) {
  DbOutcome out;
  out.supported = supported;
  if (!supported) return out;
  try {
    out.read = db.bounded_select(services_db_sql(query.table, query.start_ms, query.end_ms, query.visibility, query.where),
                                 [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        out.rows.push_back(DbStatement{ch_block_text_at(block, 0, row), ch_block_text_at(block, 1, row), ch_block_text_at(block, 2, row),
                                       static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 3, row))),
                                       static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 4, row))),
                                       static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 6, row))),
                                       std::stod(ch_block_text_at(block, 5, row))});
      }
    });
  } catch (...) {
    db.invalidate();
    throw;
  }
  return out;
}

}  // namespace trace
}  // namespace chdash
