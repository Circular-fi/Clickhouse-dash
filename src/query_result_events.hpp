#pragma once

// The events send a result to the browser (docs/query.md, "Result events").
// One `result_meta` event has the names and the types of the columns. It comes from the first block that has columns.
// Then come `result_rows` events, with at most a set number of rows and bytes. Each cell is written straight into the event.
// The writer knows the plan of the columns (query_result_plan.hpp) and the limits of the result.
// Where an event goes, and what is counted, are given as functions. So the session and a test use the same writer.

#include "query_result_plan.hpp"

#include <clickhouse/block.h>

#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>
#include <string_view>
#include <vector>

namespace chdash {

struct ResultEventLimits {
  // Rows of the result that are written. The rest is dropped by the preview limit. SIZE_MAX means all rows.
  size_t row_limit = static_cast<size_t>(-1);
  // An event holds at most this many rows. It stops at this many bytes. This is a target, and the cell limit is the safety.
  size_t max_rows_per_event = 1000;
  size_t max_bytes_per_event = 256 * 1024;
  // A cell above this size fails the run (result_cell_too_large).
  size_t max_result_cell_bytes = 32 * 1024 * 1024;
};

class ResultEventWriter {
 public:
  // Where an event goes (name and JSON). It also gives what was written: the rows and bytes of one result_rows event.
  using Emit = std::function<void(std::string_view event, std::string_view json)>;
  using Account = std::function<void(size_t rows, size_t bytes)>;

  ResultEventWriter(std::string query_id, ResultEventLimits limits, Emit emit, Account account)
      : query_id_(std::move(query_id)), limits_(limits), emit_(std::move(emit)), account_(std::move(account)) {}

  // A new attempt to read the result. It has the plan, which the caller keeps for the attempt, and what the meta event says about it.
  void begin_attempt(const ResultPlan* plan, bool used_transport_wrapper, bool described, bool plan_from_cache);
  // The result written so far is dropped. The next block sends the meta event again, and the row count starts from 0.
  void restart();

  // Writes the meta event (once) and the row events of one block. Throws when a cell is too large.
  void write(const clickhouse::Block& block);

  uint64_t rows_returned() const { return rows_returned_; }

 private:
  void write_meta(const clickhouse::Block& block);

  std::string query_id_;
  ResultEventLimits limits_;
  Emit emit_;
  Account account_;

  const ResultPlan* plan_ = nullptr;
  bool used_transport_wrapper_ = false;
  bool described_ = false;
  bool plan_from_cache_ = false;
  std::vector<const ResultColumnPlan*> column_plans_;
  size_t column_plans_for_ = static_cast<size_t>(-1);
  bool meta_sent_ = false;
  uint64_t rows_returned_ = 0;
};

} // namespace chdash
