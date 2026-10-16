// The preview of the Explorer. It shows the first rows of a table that the runner may read, as typed JSON cells.
// The encoder of the query results writes these cells. The columns are the ones that the runner may read. The statement finalizes the state of an aggregate function.
#include "explorer_catalog.hpp"

#include "explorer_sql.hpp"
#include "explorer_values.hpp"
#include "json_clickhouse.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <stdexcept>

namespace chdash {

using namespace explorer;

namespace {

// Lists the columns of the table that the runner may read, in the order of DESCRIBE.
std::vector<std::string> allowed_columns_for_table(
    const AllowedObjectSet& allowed,
    const std::string& database,
    const std::string& table,
    ChExecutor& runner,
    std::vector<ExplorerPreviewColumn>* info,
    std::string* error) {
  std::vector<std::string> columns;
  std::string describe_error;
  const bool loaded = try_select(runner, preview_columns_sql(database, table),
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        const auto name = block_string_at(block, 0, row);
        if (name.empty() || !allowed.allows_column(database, table, name)) continue;
        columns.push_back(name);
        if (info) {
          ExplorerPreviewColumn column;
          column.name = name;
          column.type = block.GetColumnCount() > 1 ? block_string_at(block, 1, row) : std::string{};
          info->push_back(std::move(column));
        }
      }
    }, &describe_error);
  if (!loaded && error) *error = "DESCRIBE TABLE failed: " + describe_error;
  return columns;
}

}  // namespace

bool load_explorer_preview(
    ChExecutor& runner,
    const AllowedObjectSet& allowed,
    const std::string& database,
    const std::string& table,
    size_t limit,
    ExplorerPreview& out,
    std::string* error) {
  if (!allowed.allows_table(database, table)) {
    if (error) *error = "object not found";
    return false;
  }
  limit = std::max<size_t>(1, std::min<size_t>(limit, 500));
  out = ExplorerPreview{};
  out.limit = limit;

  auto columns = allowed_columns_for_table(allowed, database, table, runner, &out.columns, error);
  if (columns.empty()) {
    if (error && error->empty()) *error = "no readable columns";
    return false;
  }

  // Keep the native ClickHouse types. Pass every cell through the same JSON encoder that Query results use.
  // This is critical for LowCardinality, Nullable, Bool, Array, Tuple, Map and other nested types.
  // Explorer must not have a second, string-only serialization path.
  std::vector<std::string> types;
  types.reserve(columns.size());
  for (size_t i = 0; i < columns.size(); ++i) {
    const std::string& declared_type = out.columns[i].type;
    out.columns[i].finalized_for_preview = declared_type.rfind("AggregateFunction(", 0) == 0;
    types.push_back(declared_type);
  }
  const SqlStatement statement = preview_sql(database, table, columns, types, limit);

  try {
    runner.select(statement.sql, statement.params.list(), [&](const clickhouse::Block& block) {
      if (block.GetRowCount() == 0) return;
      if (block.GetColumnCount() != columns.size()) {
        throw std::runtime_error(
            "Explorer preview returned " + std::to_string(block.GetColumnCount()) +
            " columns; expected " + std::to_string(columns.size()) + ".");
      }
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        std::vector<std::string> values;
        values.reserve(columns.size());
        for (size_t i = 0; i < columns.size(); ++i) {
          rapidjson::StringBuffer cell_buffer;
          rapidjson::Writer<rapidjson::StringBuffer> cell_writer(cell_buffer);
          const std::string& declared_type = out.columns[i].type;
          if (declared_type.rfind("AggregateFunction(", 0) == 0) {
            // The SELECT projection above finalized and stringified the state. Decode the returned String column by its runtime type.
            // The public preview metadata keeps the original AggregateFunction type.
            write_cell_json(cell_writer, block[i], row);
          } else if (!declared_type.empty()) {
            write_cell_json_declared(cell_writer, block[i], row, declared_type);
          } else {
            write_cell_json(cell_writer, block[i], row);
          }
          values.emplace_back(cell_buffer.GetString(), cell_buffer.GetSize());
        }
        out.rows.push_back(std::move(values));
      }
    });
  } catch (const std::exception& e) {
    if (error) *error = e.what();
    return false;
  }
  return true;
}

}  // namespace chdash
