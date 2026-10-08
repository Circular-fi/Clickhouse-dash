#pragma once

#include "export_job.hpp"
#include "json_clickhouse.hpp"

#include <clickhouse/block.h>

#include <rapidjson/stringbuffer.h>

#include <cstddef>
#include <string>
#include <string_view>
#include <vector>

namespace chdash {

class Zip64StreamWriter;

class ExportSerializer {
public:
  ExportSerializer(Zip64StreamWriter& zip, ExportFormat format, size_t buffer_bytes);
  ~ExportSerializer();

  bool write_block(const clickhouse::Block& block);
  bool finish();
  bool ok() const { return ok_; }
  const std::string& error() const { return error_; }
  uint64_t rows_written() const { return rows_written_; }

private:
  bool append(std::string_view value);
  bool append_char(char value);
  bool flush();
  bool write_csv_header(const clickhouse::Block& block);
  bool write_csv_row(size_t row);
  bool write_json_row(size_t row);
  bool write_csv_field(std::string_view value);
  bool write_csv_cell(const clickhouse::ColumnRef& column, size_t row);
  void fail(std::string message);

  Zip64StreamWriter& zip_;
  ExportFormat format_;
  size_t buffer_limit_;
  std::string buffer_;
  // Per-block column handles/names (Block::operator[] returns a shared_ptr by
  // value) and one reusable JSON row buffer instead of a fresh StringBuffer
  // plus two std::string copies for every exported row.
  std::vector<clickhouse::ColumnRef> columns_;
  // One cell encoder per column of the block, for the JSON Lines rows.
  std::vector<detail::CellEncoder> encoders_;
  std::vector<std::string> column_names_;
  rapidjson::StringBuffer json_row_;
  bool ok_ = true;
  bool header_written_ = false;
  uint64_t rows_written_ = 0;
  std::string error_;
};

} // namespace chdash
