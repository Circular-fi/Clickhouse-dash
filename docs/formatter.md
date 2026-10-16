# SQL formatter

The Format button of the Query page and the `format_sql` tool of MCP call `POST /api/format`. The System page does not call this route. The server formats the text of a query shape itself, with the same service (see [`system.md`](system.md#the-formatted-text-of-a-shape)). This page describes what the service does with a text. It also describes what the service promises and where the code is. The style of the output is in [`tests/api/format/README.md`](../tests/api/format/README.md).

## The route

`POST /api/format` takes `{"host_id", "sql"}` for one text. It takes `{"host_id", "sqls": [...]}` for a batch, with at most 1,024 texts. Both forms can take `"line_width"` (40 to 200, 80 by default) and `"cache": false`. The answer for one text is `{"formatted_sql", "cache", "line_width"}`. The answer for a batch has one entry for each text. See [the README](../README.md) for the entries and [`operations.md`](operations.md#errors) for the errors.

The route is an adapter. `FormatBatch` (`src/format_service.cpp`) formats the texts. It asks ClickHouse through a port (`FormatQueryPort`). The server gives the port pooled connections. A test gives the port a fake.

## How a text is formatted

1. The service removes the blanks and the final `;` from the text. The service refuses an empty text.
2. The cache key has the host, the ClickHouse version of the host, the line width and a digest of the text. A cache hit also compares the text. The service formats a text that comes twice in a batch once.
3. The payload of `INSERT ... FORMAT <name>` is data. The service stores the payload separately. It returns the payload byte for byte after the statement.
4. The service replaces a heredoc (`$$...$$`) and a literal on many lines with a placeholder of the same width. The service restores them at the end.
5. The service uses one of two layouts:
   - **The local formatter formats a text with a comment, or with `INSERT ... VALUES`.** The formatQuery function of ClickHouse drops the comments. It also does not keep the rows of the insert.
   - **For any other text, the service calls `formatQuery` first.** The local formatter then formats the result for the width of the line.
6. The service restores the spelling of the user. This applies to the names between quote marks, the exact text of each literal, a call written without quotes and the heredocs. The service restores the payload of an insert too.
7. The service checks a text that the local formatter formats (see below).

Both layouts use one code for the lines. The passes in `src/format_*.cpp` run on the output of formatQuery and on the text of the user. The service formats an `ALTER TABLE` in the same way, with or without comments. Its commands take the shape of formatQuery (`(command),`). Then the service writes each command on its own line at the left edge.

## The check of the meaning

The local formatter works on the text. It does not parse the SQL. A rule that is wrong for a text can change the meaning of the text. The service checks the local layout of each text:

- The service asks ClickHouse for `EXPLAIN AST` of the text as it was written. It also asks for `EXPLAIN AST` of the formatted text. ClickHouse parses both texts and does not run them. The tree is the same for two layouts of one statement. It is also the same for a text with and without its comments. (`formatQuery` is not used for this check, because it prints the parentheses that the text has.)
- ClickHouse does not parse the rows of `INSERT ... VALUES`. They are data. The service compares the tokens of the rows. A comma between two rows is not part of the data.
- When the trees differ, the answer is the text **as it was written**. The answer has a `warning`: `{"code": "format_meaning_changed", "message": "..."}`. For a batch, the warning is in the entry of the text. The service does not keep the text in the cache. The next request checks the text again.
- When ClickHouse cannot judge, the layout stays. The layout is the same as it was before the check existed. This case happens when ClickHouse cannot parse the statement that was written. It also happens when the connection fails. It happens too when the text is longer than `max_query_size` of the server.

A client that does not read `warning` shows the text as it was written. The Query page does not show the warning.

The check sends two `EXPLAIN AST` queries for a text with comments. The service does not check a text that formatQuery formats. The formatQuery function gives its own tree. The local formatter only formats the lines. The AST suite of the tests checks these cases on a real server.

## Limits

- The service takes up to 500 KiB of SQL (`kMaxFormatSqlBytes`). The service refuses a longer text with 422. The answer names the limit.
- ClickHouse parses at most `max_query_size` bytes (262,144 by default). The health check of each host reads this value. The service refuses a text that formatQuery must parse, if the text is longer than this limit. The service measures this length after it writes the reserved words between backticks. The refusal message names `max_query_size`. The service formats a text with comments up to 500 KiB. It does not check such a text when it is longer than `max_query_size`.
- The local formatter works for at most 2 s for one text. It nests at most 96 levels. After either limit, it returns the text as it was written.
- A batch has a limit of 10 s. The service marks the texts that start after this limit as `skipped`. A text that fails does not fail the other texts.

## The place of an error

When ClickHouse refuses a text, its message says where it stops (`position 12 (line 2, col 9)`). ClickHouse counts positions in the text that it receives, and that text differs from the text of the user. The service writes the reserved words that are aliases between backticks. It also replaces the heredocs and the literals on many lines with placeholders. The service converts the position to the text of the user, and it includes the blanks at the start of the text in the count. The message and the `clickhouse` member of the error (`position`, `line`, `col`) use the same place.

## The code

| Unit | What it holds |
| --- | --- |
| `src/api_format.cpp` | The route: the JSON, the host, the answer |
| `src/format_pooled_port.cpp` | The port of the server: `formatQuery` and `EXPLAIN AST` on a pooled connection of the runner account of the host. The route and the text of a query shape use this port. |
| `src/system_query_format.cpp` | The text of a query shape: the placeholders of normalizeQuery, masked as numbers. The service restores them after the formatter. |
| `src/format_service.cpp` | `FormatBatch`: the steps above, the cache, the check of the meaning, the place of an error |
| `src/format_clickhouse.cpp` | `formatQuery` and `EXPLAIN AST` on one connection. The unit makes one reconnect. |
| `src/format_postprocess.cpp` | The two entry points: `postprocess_format_query` and `unwrap_alter_table_commands` |
| `src/format_text.cpp` ... `src/format_layout.cpp` | The passes of the layout (text, scan, align, arithmetic, calls, statements, expressions, DDL, INSERT, the explosion of long lines). `src/format_internal.hpp` holds the code that these passes share. |
| `src/sql_scan.hpp` | The masks of the heredocs and the literals, and the restoration of the spelling |

The restoration matches the names and the literals of the formatted text to the names and literals of the written text. It matches them in order, by value. The restoration skips a name that formatQuery removes (`x::T` becomes `CAST(x, 'T')`). The service still restores the names after it. The search for the next equal value does not scan the rest of the text.

## Tests

- `tests/api/format` holds the fixtures (`input/` and `output/`). The tests check the AST equivalence of each fixture on a real server. They check the idempotence of each output. They use the corpus of the examples of ClickHouse.
- `tests/native/format_test.cpp` tests the service on a fake ClickHouse. It checks the meaning check, the place of an error, the limits and the restoration. It also checks the properties of the layout for each fixture and for statements with comments. The layout does not crash, keeps the comments and keeps the tokens. A second pass does not change the text.
- `tests/native/format_depth_test.cpp` tests the depth guard on small stacks.
- `tests/fuzz/fuzz_format.cpp` fuzzes the local layout and the service under the sanitizers.

## Known limits

- The local formatter formats a statement that has comments. The local formatter keeps the spelling of the user (`x::Int32`, `INTERVAL 1 DAY`). formatQuery rewrites this spelling. The two outputs for one statement can differ for this reason.
- In an `ALTER` with comments, the words of the clauses of a column (`DEFAULT`, `CODEC`) in `ADD COLUMN` keep their case.
- A statement with 100 levels of redundant parentheses and a comment needs a second pass. The second pass writes the statement on one line.
- The service re-wraps the text of a block comment. A `-` in the comment can get spaces around it.
