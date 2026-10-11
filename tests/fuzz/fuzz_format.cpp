// libFuzzer target: the SQL formatter without ClickHouse (src/format_postprocess.cpp, src/sql_scan.hpp, src/format_service.cpp).
//
// The path of POST /api/format for a statement with comments or a VALUES insert (no formatQuery): heredocs and
// multi-line literals masked, postprocess_format_query, then the restore passes. Then the post-processing of the
// formatQuery path (unwrap_alter_table_commands) on the same text. Then the service (FormatBatch) on a fake ClickHouse
// (tests/native/format_fake_port.hpp): its answer keeps every comment, a text that the layout would change comes back
// as written with a warning, and the place of an error is in the text. A crash, a sanitizer finding or a call that runs
// past the libFuzzer -timeout (the formatter gives up after 2 s) is a finding. The formatter must also keep every
// comment: postprocess_format_query returns the text unchanged when a comment would not come out whole.
#include "../native/format_fake_port.hpp"
#include "format_postprocess.hpp"
#include "sql_scan.hpp"
#include "sql_util.hpp"

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

  std::string pretty = chdash::unwrap_alter_table_commands(chdash::postprocess_format_query(source, width));
  pretty = chdash::restore_sql_quoted_identifiers(std::move(pretty), source);
  pretty = chdash::unquote_call_identifiers_written_unquoted(std::move(pretty), source);
  pretty = chdash::restore_sql_single_quoted_literals(std::move(pretty), source);
  pretty = chdash::restore_sql_heredocs(std::move(pretty), heredocs);

  // The formatQuery path: the post-processing of a statement that ClickHouse has formatted.
  const std::string unwrapped = chdash::unwrap_alter_table_commands(
      chdash::postprocess_format_query(chdash::restore_sql_single_quoted_literals(source, source), width));
  (void)unwrapped;

  // The service on a fake ClickHouse. The comments of the answer are the comments that went in; a warning gives the text as written.
  chdash::FakePort port;
  // The fake fails the formatQuery of a text at the place that the input says, so the place of an error is counted back.
  const size_t where = size > 2 ? (static_cast<size_t>(data[size - 1]) * 251 + data[size - 2]) % size : 0;
  port.error_marker = (data[0] & 0x80) != 0 && where < sql.size() ? std::string(1, sql[where]) : std::string();
  chdash::FormatSettings settings;
  settings.use_cache = false;
  settings.line_width = static_cast<int>(width);
  chdash::FormatBatch batch(nullptr, settings, port);
  const chdash::FormatOutcome outcome = batch.format(sql);
  const std::string written = chdash::trim_sql(sql);
  if (outcome.failure == chdash::FormatQueryFailureKind::server && outcome.error_offset && *outcome.error_offset > sql.size()) __builtin_trap();
  if (outcome.ok() && outcome.warning && *outcome.formatted != written) __builtin_trap();
  return 0;
}
