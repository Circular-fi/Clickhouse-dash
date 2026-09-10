#pragma once

#include "export_job.hpp"

#include <clickhouse/block.h>

#include <cstddef>
#include <string>
#include <string_view>

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
  bool write_csv_row(const clickhouse::Block& block, size_t row);
  bool write_json_row(const clickhouse::Block& block, size_t row);
  bool write_csv_field(std::string_view value);
  bool write_csv_cell(const clickhouse::ColumnRef& column, size_t row);
  void fail(std::string message);

  Zip64StreamWriter& zip_;
  ExportFormat format_;
  size_t buffer_limit_;
  std::string buffer_;
  bool ok_ = true;
  bool header_written_ = false;
  uint64_t rows_written_ = 0;
  std::string error_;
};

} // namespace chdash
