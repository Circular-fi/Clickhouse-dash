# SQL formatter

The Format button of the Query page and the `format_sql` tool of MCP call `POST /api/format`. The System page does not: the server formats the text of a query shape itself, by the same service (see [`system.md`](system.md#the-formatted-text-of-a-shape)). This page describes what the service does with a text, what it promises, and where the code is. The style of the output is in [`tests/api/format/README.md`](../tests/api/format/README.md).

## The route

`POST /api/format` takes `{"host_id", "sql"}` for one text, or `{"host_id", "sqls": [...]}` for a batch (at most 1,024 texts). Both can take `"line_width"` (40 to 200, 80 by default) and `"cache": false`. The answer for one text is `{"formatted_sql", "cache", "line_width"}`. The answer for a batch has one entry for each text. See [the README](../README.md) for the entries and [`operations.md`](operations.md#errors) for the errors.

The route is an adapter. `FormatBatch` (`src/format_service.cpp`) formats the texts. It asks ClickHouse through a port (`FormatQueryPort`): the server gives it pooled connections, and a test gives it a fake.

## How a text is formatted

1. The service takes the blanks and the final `;` off the text. An empty text is refused.
2. The key of the cache is the host, the ClickHouse version of the host, the line width and a digest of the text. A hit compares the text too. A text that comes twice in a batch is formatted once.
3. The payload of `INSERT ... FORMAT <name>` is data. It is kept apart, and it comes back byte for byte after the statement.
4. A heredoc (`$$...$$`) and a literal on many lines are replaced by a placeholder of the same width. They come back at the end.
5. The layout:
   - **A text with a comment, or with `INSERT ... VALUES`, is laid out by the local formatter.** formatQuery of ClickHouse would drop the comments and would not keep the rows of the insert.
   - **Any other text goes through `formatQuery` first.** The local formatter then lays the result out by the width of the line.
6. The spelling of the user comes back: the names between quote marks, the exact text of each literal, a call written without quotes, the heredocs. The payload of an insert follows.
7. A text that the local formatter laid out is checked (see below).

The two layouts have one code for the lines: the passes in `src/format_*.cpp` run on the output of formatQuery and on the text of the user. An `ALTER TABLE` is laid out the same way with or without comments: its commands are put in the shape of formatQuery (`(command),`), and then written one for each line at the left edge.

## The check of the meaning

The local formatter works on the text. It does not parse the SQL. A rule that is wrong for a text can change what the text means. The service checks the local layout of each text:

- It asks ClickHouse for `EXPLAIN AST` of the text as it was written and of the formatted text. ClickHouse parses them and does not run them. The tree is the same for two layouts of one statement, and for a text with and without its comments. (`formatQuery` is not used for this check: it prints the parentheses that the text has.)
- The rows of `INSERT ... VALUES` are data that ClickHouse does not parse. The service compares their tokens. A comma between two rows is not part of the data.
- When the trees differ, the answer is the text **as it was written**. The answer has a `warning`: `{"code": "format_meaning_changed", "message": "..."}`. For a batch, the warning is in the entry of the text. The text is not kept in the cache: the next request checks it again.
- When ClickHouse cannot judge, the layout stays, as it was before the check existed. This happens when ClickHouse cannot parse the statement that was written, when the connection fails, and when the text is longer than `max_query_size` of the server.

A client that does not read `warning` shows the text as it was written. The Query page does not show the warning.

The check costs two `EXPLAIN AST` queries for a text with comments. A text that goes through formatQuery is not checked: formatQuery gave its tree, and the local formatter only lays the lines out. The AST suite of the tests checks them on a real server.

## Limits

- The service takes 500 KiB of SQL (`kMaxFormatSqlBytes`). A longer text is refused with 422 and says the limit.
- ClickHouse parses at most `max_query_size` bytes (262,144 by default). The health check of each host reads it. A text that formatQuery must parse and that is longer than this, once its reserved words are written between backticks, is refused with a message that names `max_query_size`. A text with comments is formatted up to 500 KiB, and it is not checked when it is longer than `max_query_size`.
- The local formatter works for at most 2 s for one text, and nests at most 96 levels. After that, it returns the text as it was written.
- A batch has 10 s. The texts that start after it are `skipped`. A text that fails does not fail the others.

## The place of an error

When ClickHouse refuses a text, its message says where it stopped (`position 12 (line 2, col 9)`). ClickHouse counts in the text that it received. That text is not the text of the user: the reserved words that are aliases are written between backticks, and the heredocs and the literals on many lines are placeholders. The service counts the place back into the text of the user, with the blanks that the text starts with. The message, and the `clickhouse` member of the error (`position`, `line`, `col`), use the same place.

## The code

| Unit | What it holds |
| --- | --- |
| `src/api_format.cpp` | The route: the JSON, the host, the answer |
| `src/format_pooled_port.cpp` | The port of the server: `formatQuery` and `EXPLAIN AST` on a pooled connection of the runner account of the host (the route and the text of a query shape use it) |
| `src/system_query_format.cpp` | The text of a query shape: the placeholders of normalizeQuery masked as numbers, and put back after the formatter |
| `src/format_service.cpp` | `FormatBatch`: the steps above, the cache, the check of the meaning, the place of an error |
| `src/format_clickhouse.cpp` | `formatQuery` and `EXPLAIN AST` on one connection, with one reconnect |
| `src/format_postprocess.cpp` | The two entry points: `postprocess_format_query` and `unwrap_alter_table_commands` |
| `src/format_text.cpp` ... `src/format_layout.cpp` | The passes of the layout (text, scan, align, arithmetic, calls, statements, expressions, DDL, INSERT, the explosion of long lines). `src/format_internal.hpp` is what they share. |
| `src/sql_scan.hpp` | The masks of the heredocs and the literals, and the restoration of the spelling |

The restoration matches the names and the literals of the formatted text to the ones of the written text, in order, by value. A name that formatQuery removes (`x::T` becomes `CAST(x, 'T')`) is passed over, and the names after it are still restored. The search for the next equal value does not walk the rest of the text.

## Tests

- `tests/api/format`: the fixtures (`input/` and `output/`), the AST equivalence of each fixture on a real server, the idempotence of each output, and the corpus of the examples of ClickHouse.
- `tests/native/format_test.cpp`: the service on a fake ClickHouse. It checks the meaning check, the place of an error, the limits, the restoration, and the properties of the layout for each fixture and for statements with comments (no crash, the comments are kept, the tokens are kept, a second pass changes nothing).
- `tests/native/format_depth_test.cpp`: the depth guard on small stacks.
- `tests/fuzz/fuzz_format.cpp`: the local layout and the service, under the sanitizers.

## Known limits

- A statement that has comments goes through the local formatter. It keeps the spelling of the user (`x::Int32`, `INTERVAL 1 DAY`), where formatQuery rewrites it. The two outputs for one statement can differ for this reason.
- The words of the clauses of a column (`DEFAULT`, `CODEC`) in `ADD COLUMN` of an `ALTER` with comments keep their case.
- A statement with 100 levels of redundant parentheses and a comment needs a second pass to be put on one line.
- The text of a block comment is re-wrapped, and a `-` in it can get spaces around it.
