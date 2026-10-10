// libFuzzer target: the SQL formatter without ClickHouse (src/format_postprocess.cpp, src/sql_scan.hpp).
//
// The path of POST /api/format for a statement with comments or a VALUES insert (no formatQuery): heredocs and
// multi-line literals masked, postprocess_format_query, then the restore passes. Then the post-processing of the
// formatQuery path (unwrap_alter_table_commands) on the same text. A crash, a sanitizer finding or a call that runs
// past the libFuzzer -timeout (the formatter gives up after 2 s) is a finding. The formatter must also keep every
// comment: postprocess_format_query returns the text unchanged when a comment would not come out whole.
#include "format_postprocess.hpp"
#include "sql_scan.hpp"

#include <cstdint>
#include <cstdlib>
#include <string>

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  if (size < 1) return 0;
  static const size_t kWidths[] = {40, 60, 80, 100, 120, 200};
  const size_t width = kWidths[data[0] % 6];
  const std::string sql(reinterpret_cast<const char*>(data + 1), size - 1);

  chdash::SqlHeredocMask heredocs = chdash::mask_sql_heredocs(sql);
  if (sql.find('\xEE') == std::string::npos) chdash::mask_sql_multiline_literals(heredocs);
  const std::string& source = heredocs.sql;
  (void)chdash::mask_sql_surface(source);

  std::string pretty = chdash::postprocess_format_query(source, width);
  pretty = chdash::restore_sql_quoted_identifiers(std::move(pretty), source);
  pretty = chdash::unquote_call_identifiers_written_unquoted(std::move(pretty), source);
  pretty = chdash::restore_sql_single_quoted_literals(std::move(pretty), source);
  pretty = chdash::restore_sql_heredocs(std::move(pretty), heredocs);

  // The formatQuery path: the post-processing of a statement that ClickHouse has formatted.
  const std::string unwrapped = chdash::unwrap_alter_table_commands(
      chdash::postprocess_format_query(chdash::restore_sql_single_quoted_literals(source, source), width));
  (void)unwrapped;
  return 0;
}
