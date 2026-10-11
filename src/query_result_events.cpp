#include "query_result_events.hpp"

#include "block_encoder.hpp"
#include "json_clickhouse.hpp"
#include "json_text.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <limits>
#include <stdexcept>

namespace chdash {

void ResultEventWriter::begin_attempt(const ResultPlan* plan, bool used_transport_wrapper, bool described, bool plan_from_cache) {
  plan_ = plan;
  used_transport_wrapper_ = used_transport_wrapper;
  described_ = described;
  plan_from_cache_ = plan_from_cache;
  column_plans_.clear();
  column_plans_for_ = static_cast<size_t>(-1);
}

void ResultEventWriter::restart() {
  meta_sent_ = false;
  rows_returned_ = 0;
}

void ResultEventWriter::write_meta(const clickhouse::Block& block) {
  rapidjson::StringBuffer sb(nullptr, 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("query_id"); write_json_text(w, query_id_);
  w.Key("columns");
  w.StartArray();
  for (size_t i = 0; i < block.GetColumnCount(); ++i) write_json_text(w, block.GetColumnName(i));
  w.EndArray();
  w.Key("types");
  w.StartArray();
  for (size_t i = 0; i < block.GetColumnCount(); ++i) {
    if (column_plans_[i]) {
      const auto& tn = column_plans_[i]->transport_type;
      write_json_text(w, tn);
    } else {
      const auto& tn = block[i]->Type()->GetName();
      write_json_text(w, tn);
    }
  }
  w.EndArray();
  w.Key("original_types");
  w.StartArray();
  for (size_t i = 0; i < block.GetColumnCount(); ++i) {
    if (column_plans_[i]) {
      const auto& tn = column_plans_[i]->original_type;
      write_json_text(w, tn);
    } else {
      const auto& tn = block[i]->Type()->GetName();
      write_json_text(w, tn);
    }
  }
  w.EndArray();
  w.Key("transport_modes");
  w.StartArray();
  for (size_t i = 0; i < block.GetColumnCount(); ++i) {
    w.String(column_plans_[i] ? transport_mode_name(column_plans_[i]->mode) : "passthrough");
  }
  w.EndArray();
  w.Key("used_transport_wrapper"); w.Bool(used_transport_wrapper_);
  w.Key("describe_mode"); w.String(described_ ? "described" : "direct");
  w.Key("describe_cache_hit"); w.Bool(plan_from_cache_);
  w.EndObject();
  emit_("result_meta", std::string_view(sb.GetString(), sb.GetSize()));
  meta_sent_ = true;
}

void ResultEventWriter::write(const clickhouse::Block& block) {
  if (column_plans_for_ != block.GetColumnCount()) {
    static const ResultPlan kNoPlan;
    // The pointers refer to the plan of the attempt, not to a copy of it.
    column_plans_ = resolve_column_plans(block, plan_ ? *plan_ : kNoPlan);
    column_plans_for_ = block.GetColumnCount();
  }

  if (!meta_sent_ && block.GetColumnCount() > 0) write_meta(block);

  if (block.GetRowCount() == 0) return;

  const size_t row_limit = limits_.row_limit;
  const size_t max_rows_per_event = limits_.max_rows_per_event;
  const size_t max_bytes_per_event = limits_.max_bytes_per_event;
  size_t row = 0;

  // Resolve column handles once per block: Block::operator[] returns a
  // shared_ptr by value, which would otherwise cost atomic refcount
  // traffic for every single cell.
  std::vector<clickhouse::ColumnRef> columns;
  columns.reserve(block.GetColumnCount());
  for (size_t c = 0; c < block.GetColumnCount(); ++c) columns.push_back(block[c]);
  // One encoder per column of the block: the nested structure of a column
  // (Nullable, Array, Tuple, Map) is resolved once instead of per cell.
  std::vector<detail::CellEncoder> encoders;
  encoders.reserve(columns.size());
  for (const auto& column : columns) encoders.emplace_back(column);
  // The declared type of a DESCRIBE plan: an opaque aggregate state, or a Bool that clickhouse-cpp
  // reads as UInt8 (write_cell_json_declared() writes it true or false, as ClickHouse prints it).
  std::vector<char> use_declared(columns.size(), 0);
  for (size_t c = 0; c < columns.size(); ++c) {
    const ResultColumnPlan* plan = column_plans_[c];
    use_declared[c] = plan && (plan->mode == ResultTransportMode::Opaque || is_bool_type_name(plan->original_type)) ? 1 : 0;
  }

  // One event buffer per block, cleared (capacity kept) between events,
  // so a multi-event block grows it once instead of once per event.
  rapidjson::StringBuffer sb(nullptr, std::min<size_t>(max_bytes_per_event, 64 * 1024));
  while (row < block.GetRowCount() && rows_returned_ < row_limit) {
    sb.Clear();
    rapidjson::Writer<rapidjson::StringBuffer> w(sb);
    w.StartObject();
    w.Key("query_id"); write_json_text(w, query_id_);
    w.Key("rows");
    w.StartArray();

    size_t rows_in_event = 0;
    while (row < block.GetRowCount() &&
           rows_in_event < max_rows_per_event &&
           rows_returned_ < row_limit) {
      w.StartArray();
      for (size_t c = 0; c < columns.size(); ++c) {
        // Compatibility projections are already String columns: the text of
        // toString() for a scalar (Int256, Decimal256), the JSON text of
        // toJSONString() for a structure (JSON, Dynamic, Array(Int256), ...).
        // Opaque aggregate states additionally get a valid-UTF8/hex safety guard.
        //
        // Cells are serialized straight into the event buffer: a
        // per-cell StringBuffer+Writer costs several heap allocations and
        // an extra copy per cell. The cell size is the buffer delta (it
        // includes at most one separator byte).
        const size_t cell_start = sb.GetSize();
        if (use_declared[c]) {
          write_cell_json_declared(w, columns[c], row, column_plans_[c]->original_type);
        } else {
          encoders[c].write(w, row);
        }
        const size_t cell_bytes = sb.GetSize() - cell_start;
        if (cell_bytes > limits_.max_result_cell_bytes) {
          throw std::runtime_error(
              "result_cell_too_large: Result cell exceeds query.max_result_cell_bytes (" +
              std::to_string(limits_.max_result_cell_bytes) + " bytes).");
        }
      }
      w.EndArray();
      ++row;
      ++rows_in_event;
      ++rows_returned_;

      // Batch-size target: hard safety is enforced separately by
      // max_result_cell_bytes and max_result_event_bytes.
      if (rows_in_event > 0 && sb.GetSize() >= max_bytes_per_event) break;
    }

    w.EndArray();
    w.EndObject();
    emit_("result_rows", std::string_view(sb.GetString(), sb.GetSize()));

    account_(rows_in_event, sb.GetSize());
  }
}

} // namespace chdash
