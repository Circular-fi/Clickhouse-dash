# SQL Formatting Guide

This document defines the canonical SQL layout style used in this repository.
Its purpose is to keep all queries visually consistent. Make queries easy to scan and easy to review.

## Goals

- Keep the layout predictable across all files.
- Make query structure readable at a glance.
- Use a compact layout for simple constructs.
- Use a vertical layout for multi-part or dense constructs.
- Prefer consistency over personal preference.

## General Rules

- Use **4 spaces** for indentation.
- Never use tabs.
- Never leave trailing whitespace.
- Keep top-level clauses at column 0.
- Use **uppercase** for SQL keywords.
- Use `snake_case` for identifiers and aliases.
- Do not add semicolons at the end of queries.

## Top-Level Clause Layout

Each top-level clause must start on its own line and stay left-aligned.

Typical layout:

```sql
SELECT
    entity_key,
    metric_value
FROM anon.metrics_store
WHERE entity_group = 'group_live'
ORDER BY metric_value DESC
LIMIT 20
```

Common top-level clauses are:

- `WITH`
- `SELECT`
- `FROM`
- `WHERE`
- `PREWHERE`
- `GROUP BY`
- `HAVING`
- `ORDER BY`
- `LIMIT`
- `UNION ALL`
- `INSERT INTO`
- `CREATE ...`
- `ALTER TABLE`

## Indentation

Indent one level inside each multiline block:

- `SELECT` lists
- `WITH` lists
- multiline function calls
- multiline boolean conditions
- subqueries
- DDL column definitions

Example:

```sql
SELECT
    entity_key,
    metric_value,
    metric_ratio
FROM anon.metrics_store
WHERE
    entity_group = 'group_live'
    AND metric_value > 0
```

## SELECT and WITH Lists

Use one item per line for multiline `SELECT` and `WITH` blocks.

### Alias alignment

In a homogeneous projection block, align `AS` vertically.
Align `AS` in these blocks:

- multiline `SELECT`
- multiline `WITH`

Example:

```sql
WITH
    toDate('2026-02-01')             AS current_day,
    current_day - toIntervalDay(7)   AS previous_week_day,
    current_day - toIntervalMonth(1) AS previous_month_day
SELECT
    entity_key,
    metric_value * 100               AS scaled_metric_value,
    round(metric_ratio, 6)           AS rounded_metric_ratio,
    toString(event_date)             AS event_date_label
FROM anon.metrics_store
```

Alignment uses the monospace display width. It does not use bytes or code points.
East Asian Wide and Fullwidth characters (CJK, Hangul, fullwidth forms) and emoji count as two columns.
Combining marks, zero-width joiners and variation selectors count as zero columns.
Literals and identifiers with these characters stay aligned.

### Literal spelling

String literals keep the exact spelling of the input. For example, `'it''s'` stays `'it''s'`.
Heredoc literals keep their heredoc form, tag and body byte for byte. Examples are `$$raw 'text'$$` and `$tag$...$tag$`.
The formatter never rewrites a heredoc literal as a quoted string.

### Where alias alignment does not apply

Keep `AS` compact outside projection lists. Examples are:

- table aliases
- subquery aliases
- isolated aliases not part of a vertically aligned block

Example:

```sql
FROM anon.metrics_store AS src
INNER JOIN (
    SELECT entity_key
    FROM anon.reference_table
) AS ref_src
    ON src.entity_key = ref_src.entity_key
```

## Commas

Use trailing commas in multiline lists.

Example:

```sql
SELECT
    entity_key,
    event_timestamp,
    metric_value
```

Do not place commas at the start of lines.

## Compact vs Multiline Formatting

Use a compact layout when the clause is short and easy to read on one line.
Use a multiline layout when the clause contains several elements or becomes visually dense.

### Prefer compact when simple

```sql
GROUP BY entity_key
ORDER BY metric_value DESC
```

### Prefer multiline when there are several items

```sql
GROUP BY
    entity_group,
    entity_key
ORDER BY
    metric_value DESC,
    entity_key ASC
```

## WHERE Conditions

Keep simple predicates compact.
Switch to a vertical layout for several conditions or nested logic.

### Simple

```sql
WHERE entity_group = 'group_live'
```

### Multiple conditions

```sql
WHERE
    entity_group = 'group_live'
    AND metric_value > 0
    AND event_date >= toDate('2026-01-01')
```

### Nested logic

Use parentheses only when they clarify grouping.
Do not put parentheses around every atomic predicate.

```sql
WHERE
    (
        entity_group = 'group_live'
        OR entity_group = 'group_buffer'
    )
    AND metric_value > 0
```

## JOINs

### USING joins

Keep simple `USING` joins compact.

```sql
LEFT JOIN anon.reference_table USING (entity_key)
```

### ON joins

When the join condition has several parts, place `ON` on the next indented line.
Put the conditions in a vertical layout.

```sql
INNER JOIN anon.right_reference AS right_src
    ON left_src.entity_key = right_src.entity_key
    AND left_src.entity_group = right_src.entity_group
```

### JOIN subqueries

Format subqueries as blocks.
Keep the alias compact after the closing parenthesis.

```sql
INNER JOIN (
    SELECT
        entity_key,
        max(metric_value) AS max_metric_value
    FROM anon.metrics_store
    GROUP BY entity_key
) AS right_src
    ON left_src.entity_key = right_src.entity_key
```

## Subqueries

Format subqueries as visual blocks.
Keep the opening parenthesis on the line of the operator or clause that introduces it.
Indent the body by 4 spaces.

### FROM subquery

```sql
FROM (
    SELECT
        entity_key,
        metric_value
    FROM anon.metrics_store
) AS inner_src
```

### IN subquery

A single condition stays on the `WHERE` line.
Indent its block two levels and its `)` one level.
This is the place that the condition takes in the multi-condition layout.

```sql
WHERE entity_key IN (
        SELECT entity_key
        FROM anon.reference_table
    )
```

### EXISTS subquery

```sql
WHERE exists(
        SELECT 1
        FROM anon.reference_table AS ref_src
        WHERE ref_src.entity_key = base_src.entity_key
    )
```

## Functions and Multiline Expressions

Function calls, array literals and `IN` value lists follow one rule.
**A call stays on one line when that whole line fits. Otherwise, it explodes, with one argument per line.**
The fixtures `230`–`287` show every case below.

### Width

- The line width is 80 columns. The `line_width` request field sets it, from 40–200.
  The formatter measures the width in display columns (see "Alias alignment").
- "The line" is the complete output line. It includes the indentation and the text before the call
  on the same line (`AND `, `x -> `, `ON a = `). It also includes everything after the call
  (` AS alias`, the trailing comma, the `)` of the outer call, `> 0`).
  A call that fits by itself, but not with its alias, explodes.
- A single token longer than the width cannot be split. Examples are a long string literal and a long type string.
  Such a token stays whole on its own argument line. The formatter never moves comments to make room.

### Inline or exploded

The formatter decides the outermost call first. When the outermost call fits, it and
everything inside it stay on one line. When it does not fit, it explodes:

- `name(` ends the line;
- each argument goes on its own line, one level (4 spaces) deeper. Add a comma after each argument, except the last one;
- `)` goes on its own line, at the indentation of the line that opened the call. The rest of that line follows the `)`:
  `) AS alias,`, `),`, `) >= 2`. When it fits, an arithmetic operator after the call also stays on the `)` line
  (`) / nullIf(sum(duration_ms), 0),`). This is the same as after a parenthesized block.

The rule applies again to each argument at its new position. An inner call that fits there stays inline:

```sql
SELECT
    coalesce(
        nullIf(span_attributes['http.route'], ''),
        nullIf(span_attributes['url.path'], ''),
        span_name
    ) AS `route`,
    toStartOfInterval(timestamp, toIntervalMinute(5)) AS `bucket`
```

Never hug a sole argument. Put it on its own line, like any other argument.
This keeps closing parentheses apart (no `))`). Each `)` sits under the line that opened it.

```sql
SELECT
    sipHash64(
        concat(
            toString(user_id),
            '|',
            session_id,
            '|',
            toString(toStartOfHour(event_time))
        )
    ) AS `session_bucket_key`
```

Do not write `sipHash64(concat(` with a shared closer.

This rule applies to an item that has only operands joined by binary operators (comparison,
arithmetic, `||`). Its first operand is a call or bracket. Such an item breaks before
its lowest-precedence operators first. Each continuation line is one level deeper, as in an arithmetic chain in a list.
The rules above then decide the operands. A bare first operand keeps the call exploded after it
(`timestamp >= toStartOfInterval(` …).

```sql
SELECT
    hmac('SHA256', 'message', 'key')
        = HMAC('sha256', 'message', 'key') AS `same_result`,
    toRelativeDayNum(toDate('2023-04-01'))
        - toRelativeDayNum(toDate('2023-01-01')) AS `days`
```

### Decision tables and pairs

- A `multiIf` with two or more conditions is always vertical, whatever its width.
  The same applies to a `CASE` with two or more `WHEN` branches.
  Put one `condition, result` pair on each line, and put the default last. `CASE x WHEN ...` (printed as
  `caseWithExpression`) keeps its operand on the first line. With a single condition, they follow the width rule
  (`multiIf(retries > 3, 'flaky', NULL)`). Never join a call that contains such a table onto one line.
- An exploded `map(...)` puts one `key, value` pair on each line.
- A `CASE` that keeps its keywords follows the same rule. This applies to a statement with comments,
  which does not go through formatQuery. `CASE [operand]` stays on the line.
  Put one `WHEN ... THEN ...` branch on each line, one level deeper. Put `ELSE` last.
  Put `END` at the indentation of the line, followed by the rest of the line (`END AS kind,`, `END = 1`).
  On that path, the formatter writes operator keywords in upper case, as formatQuery does.
  These keywords are `NOT`, `NULL`, `AS`, `IS`, `IN`, `LIKE`, `BETWEEN`, CASE words, `ASC` / `DESC` and `NULLS FIRST`.

```sql
SELECT
    caseWithExpression(
        severity_number,
        9, 'info',
        13, 'warn',
        'other'
    ) AS `severity_bucket`
```

### Lambdas

A lambda `x -> body` is one argument. Its body stays on the lambda's line when it fits.
A body that is a call explodes from `x -> f(`, and its `)` goes under the lambda's line.
A boolean body wraps before `AND` / `OR`. The continuation lines are one level deeper than the lambda.

A tuple body keeps its parentheses. For example, `(k, v) -> (k, v * 2)` returns a tuple.
Without the parentheses, `v * 2` becomes the next argument of the call.

```sql
SELECT
    arrayFilter(
        s -> s.duration_ms > 250
            AND s.status = 'error'
            AND s.service NOT IN ('healthcheck', 'metrics-scraper'),
        spans
    ) AS `slow_error_spans`,
    arrayMap((k, v) -> (k, v * 2), pairs) AS `doubled`
```

### Conditions and arithmetic as arguments

Format a condition argument (`if(c, ...)`, `sumIf(x, c)`, `countIf(c)`) like a `WHERE` condition.
Do not add the parentheses that formatQuery puts around each comparison.
In an exploded list, the continuation lines of a wrapped condition or arithmetic argument hang one level deeper.
This keeps a reader from mistaking them for the next argument.
A sole argument keeps its operators aligned under its first operand (see "Arithmetic Expressions").

```sql
SELECT
    if(
        isNotNull(parent_span_id)
            AND parent_span_id != ''
            AND service_name != 'frontend-proxy',
        concat(service_name, ' <- ', parent_service),
        service_name
    ) AS `edge`
```

### Literals as arguments

Array literals, tuples inside them and `IN (...)` value lists follow the same rule.
Keep them inline when the line fits. Otherwise, put one element on each line.
An element that fits stays on one line, for example a tuple in an array of tuples.

```sql
SELECT
    [
        ('checkout', 'payments', 250, 0.999),
        ('payments', 'fraud-detection', 120, 0.9995)
    ] AS `dependency_slos`
```

Keep a literal that is followed by `::Type` exactly as written.
For example, `[110, 120]::Array(DateTime)` casts the literal's source text. The spaces in the literal are part of the query.

### Where the call sits

- A single projection that fits stays on the `SELECT` line. A projection that needs several lines
  goes into the indented block, like a list item.
- A single `WHERE` / `PREWHERE` / `HAVING` condition stays on the keyword line.
  When it explodes, indent its arguments two levels. Indent its `)` one level.
  This is the place that the condition takes in the multi-condition layout. `IN` and
  `exists` subqueries and long `IN` value lists use the same layout.
- In a condition list (`AND` / `OR` lines, `JOIN ... ON` lines), a call explodes under its own line.
- A table function in `FROM` or `JOIN` explodes like a `FROM` subquery. A single `ARRAY JOIN` expression does the same.
  The layout is `FROM s3(`, then the arguments, then `) AS alias`.
- `GROUP BY` and `ORDER BY` items follow the same rule as projections.
- A window function keeps its `OVER (...)` layout (see the window fixtures).
  Never join a call that contains a multi-line `OVER` specification.
  A window that extends a named window keeps that name as its first line
  (`OVER (\n    base_window\n    ROWS BETWEEN ...\n)`). A `WINDOW name AS (...)`
  definition that does not fit its line uses the same layout for its specification, with one clause on each line.
- A scalar subquery beside a comparison or arithmetic operator is a block. Its `(` stays on the line of the operator.
  For example: `WHERE m > (`, then the query, then `)` one level in, as in an `IN` subquery.
  In a projection: `a / (` … `) AS ratio`.
- A boolean projection (`a AND b AS flag`) that is too long for its line wraps before `AND` / `OR`.
  The continuation lines are one level deeper.
- An `ORDER BY x WITH FILL FROM a TO b STEP s` clause that is too long for its line breaks
  before `FROM`, `TO`, `STEP` and `STALENESS`. Each break is one level deeper.

```sql
SELECT count()
FROM s3(
    'https://observability-archive.s3.eu-west-1.amazonaws.com/otel/logs/*.parquet',
    'Parquet'
)
WHERE positionCaseInsensitive(
        body,
        'connection reset by peer while reading response header from upstream'
    ) > 0
```

### Comments inside argument lists

A comment fixes the layout where it sits. Never join a call that contains a comment onto one line.
A `--` comment stays after the comma of its argument.

### Alignment after calls are joined

When calls are joined, a multi-line item can become a one-line item. The formatter then aligns the projection aliases
as for any run of one-line items (see "Alias alignment"). A run whose aligned form exceeds the width is not aligned.
A closing line (`) AS x`, `] AS x`) is never padded.

### Scope

The width rule applies to queries (`SELECT`, `WITH`, `INSERT ... SELECT`, view
bodies). DDL keeps its own layout. The formatter does not treat these items as calls:
column types such as `Array(Tuple(...))`, `INDEX ... TYPE ...`, `CODEC(...)`, `GRANT SELECT(...)`,
and keywords followed by a parenthesis (`GROUPING SETS (`).

### Parametric aggregates

A parametric aggregate `name(parameters)(arguments)` follows the same rules as any other call.
The argument list wraps exactly when a plain call of the same length wraps.
Keep `name(parameters)(` on the opening line. Put the parameter list in a vertical layout only when that head alone does not fit.

```sql
SELECT
    windowFunnel(3600)(
        event_timestamp,
        event_name = 'view',
        event_name = 'cart',
        event_name = 'buy'
    ) AS funnel_level,
    quantiles(0.5, 0.9)(latency_ms) AS latency_quantiles,
    quantilesExactWeighted(
        0.01,
        0.05,
        ...
        0.9999
    )(response_time_ms, request_weight) AS weighted_quantiles
```

## Arithmetic Expressions

Keep arithmetic inline while it fits. A longer expression wraps at the
operators of its lowest precedence level. Put one operand on each line, with the
operator at the start of the line. The layout then shows how the parser groups
the expression. Continuation lines hang one level (4 spaces) under the first operand.

The exception is the sole argument of a call. Its lines stay aligned. An operand that is itself a long
parenthesized expression opens a block. After a block closes, the operator stays on the `)` line.
This is the same as `) AS alias`.

```sql
SELECT
    metric_alpha * 0.25
        + metric_beta * 0.25
        + metric_gamma * 0.2 AS composite_score,
    (
        score_accuracy * weight_accuracy
        + score_latency * weight_latency
        + score_coverage * weight_coverage
    ) / (
        weight_accuracy
        + weight_latency
        + weight_coverage
    ) AS weighted_score
FROM anon.metrics_store
WHERE
    (metric_alpha * weight_alpha + metric_beta * weight_beta)
        / (weight_alpha + weight_beta) > minimum_threshold_value
    AND entity_group = 'group_live'
```

### Redundant parentheses

`formatQuery` adds parentheses to every nested operator. For example:
`((a * w1) + (b * w2)) / ((w1 + w2) + w3)`.

Parentheses are not part of the parsed AST. The formatter therefore removes a group when operator precedence
already produces the same tree. The input above becomes
`(a * w1 + b * w2) / (w1 + w2 + w3)`. Keep a group when it matters:

- the right operand of an operator at the same level: `a - (b - c)`, `a / (b * c)`, `a + (b + c)`
- a lower-precedence operand: `(a + b) * c`
- anything after a unary sign: `-(a + b)`, and `-(1)`, which is `negate(1)`, not the literal `-1`
- `||` chains, because the parser flattens `a || b || c` into a single `concat`
- comparisons next to a comparison: `(a > b) = (c > d)`
- member access, `IN` lists, keyword lists and DDL keys: `(x + 1).1`, `x IN (5)`, `GROUPING SETS ((a), ())`, `ORDER BY (a)`

### Unary minus

Write a unary sign against its operand: `-x`, `-(a + b)`, `a * -b`,
`x > -y`. The two signs of `- -x` keep the space between them. Without that space, `--` starts a comment.

## Lambda Expressions

Keep lambda bodies compact. They wrap by the width rule (see "Lambdas" above).
Do not add unnecessary parentheses around simple lambda expressions. Keep the parentheses of a tuple body.

Preferred:

```sql
arrayMap(item -> lowerUTF8(item), raw_values)
arrayFilter(item -> length(item) > 10, normalized_values)
```

Avoid:

```sql
arrayMap(item -> (lowerUTF8(item)), raw_values)
```

## Parentheses

Use parentheses for:

- logical grouping
- multiline subqueries
- multiline function arguments when needed by the syntax

Do not use parentheses around simple predicates unless grouping requires them.

Preferred:

```sql
WHERE
    (
        event_date >= range_start
        AND event_date <= range_end
    )
    AND metric_value > 0
```

Avoid:

```sql
WHERE
    (event_date >= range_start)
    AND (metric_value > 0)
```

## ORDER BY and GROUP BY

Use an inline layout for single-item clauses.
Use a multiline layout for several items.

```sql
GROUP BY entity_key
ORDER BY metric_value DESC
```

```sql
GROUP BY
    entity_group,
    entity_key
ORDER BY
    metric_value DESC,
    entity_key ASC
```

## DDL Formatting

Use a vertical layout for DDL blocks. Indent nested definitions consistently.

### CREATE TABLE

```sql
CREATE TABLE anon.metrics_store
(
    entity_key String,
    entity_group LowCardinality(String),
    event_date Date,
    metric_value Float64
)
ENGINE = MergeTree
ORDER BY (entity_group, entity_key, event_date)
```

A column list follows this layout. The fixtures `092`, `308` and `597`-`607` show it.

- Back-quote the column names. The types start in one column. The column is as wide as the longest name.
  A name wider than 32 columns (with its quotes) does not stretch the column. In that case, the column keeps one space
  before its type, and the other columns stay aligned. When every name is wider than 32, the longest name sets the column.
- A `Tuple` type stays on the column's line when the whole column fits the line width beside the aligned name.
  For example, `` `point` Tuple(x Float64, y Float64), `` and `` `segments` Array(Tuple(a UInt32, b UInt32)), `` take one line each.
  A type that does not fit puts one element on each line, 4 spaces under the column. Its closing parenthesis goes on a line
  of its own, at the column's indent.
  Inside such a block, a `Tuple` that fits its own line stays on one line (`first Tuple(alpha UInt64, beta String),`).
- A comment after the comma of a column stays at the end of that column's line. The same applies to a comment
  after the closing line of its type. A comment inside a type keeps the type on several lines.

### ALTER TABLE

```sql
ALTER TABLE anon.metrics_store
(
    ADD COLUMN IF NOT EXISTS source_name LowCardinality(String)
    AFTER entity_group
)
```

```sql
ALTER TABLE anon.metrics_store
(
    UPDATE
        metric_ratio = 0.000000,
        tag_values = arrayDistinct(tag_values)
    WHERE
        entity_group = 'group_cleanup'
        AND metric_value = 0
)
```

A one-command `ALTER TABLE ... UPDATE` puts `IN PARTITION p` on its own line, after the assignments and before `WHERE`.
A multi-command ALTER writes one command on each line, at the left edge. Separate the commands with commas.
A statement with comments has the same layout (fixtures `514`, `515`, `559`, `589`-`591`).
The comment stays on the line of the command that it follows. The comma goes before the comment.

### Set operators

`INTERSECT` and `EXCEPT` (with or without `DISTINCT` / `ALL`) stand on their own line between their operands. This is the same as `UNION ALL`.
An operand that formatQuery puts in parentheses to show precedence is a block.

### CREATE FUNCTION

The lambda of `CREATE FUNCTION name AS (x, y) -> body` follows the lambda rules.
Do not put parentheses around a plain body. When its first line does not fit after `AS`, move the lambda to the next line, one level deeper.

### Index definitions

Rows of `INDEX name expr TYPE type GRANULARITY n` in one table are aligned in columns. This happens while every aligned row fits the line width.
When any row is too wide, stack the rows instead, with one clause on each continuation line:

```sql
    INDEX idx_attributes_keys mapKeys(attributes)
        TYPE text(tokenizer = array)
        GRANULARITY 100000000
```

The single `ADD INDEX [IF NOT EXISTS] ...` command of an `ALTER TABLE` stacks in the same way when it does not fit.

### TTL lists

Keep a single short TTL rule on the `TTL` line. Put one rule on each line when there are several rules.
Put one rule on each line also when the rule does not fit. A conditional rule that does not fit splits its `WHERE` like a filter.
The same applies to `ALTER TABLE ... MODIFY TTL`.

```sql
TTL
    event_date + toIntervalDay(30) TO VOLUME 'cold',
    event_date + toIntervalDay(365)
```

```sql
TTL
    event_date + toIntervalDay(90)
    WHERE
        entity_group = 'group_tmp'
        AND metric_value = 0
```

A `GROUP BY ... SET ...` rule is one rule. Its keys and assignments are comma lists.
When it does not fit, `GROUP BY` and `SET` start their own lines. Put one assignment on each line.

```sql
TTL
    event_hour + toIntervalMonth(1)
    GROUP BY entity_key, toStartOfDay(event_hour)
    SET
        metric_sum = sum(metric_sum),
        metric_max = max(metric_max)
```

### Access-control and refreshable view DDL

`CREATE ROW POLICY`, `CREATE SETTINGS PROFILE` and view heads stay on one line while they fit the line width.
View heads contain `REFRESH`, `DEPENDS ON`, `TO`, `DEFINER = user` and `SQL SECURITY`.
A longer statement puts every clause on its own line at column 0. Format `USING` like `WHERE`.
`SETTINGS` lists one item on each line, with aligned `=`. A view head ends with `AS` on its own line, before the query.

```sql
CREATE ROW POLICY tenant_isolation ON anon.metrics_store
AS RESTRICTIVE
FOR SELECT
USING
    tenant_id = currentUser()
    AND is_deleted = 0
TO analyst, reporting_role
```

```sql
CREATE SETTINGS PROFILE `analyst_profile`
SETTINGS
    max_threads = 8 MIN 1 MAX 16,
    readonly    = 1
TO analyst
```

```sql
CREATE MATERIALIZED VIEW anon.daily_mv
REFRESH EVERY 1 HOUR OFFSET 5 MINUTE
DEPENDS ON anon.hourly_mv
APPEND TO anon.daily
AS
SELECT
    ...
```

`ALTER SETTINGS PROFILE` stays on one line. Its `ADD`/`MODIFY`/`DROP SETTINGS` grammar is not a plain `name = value` list.

## INSERT Statements

Keep short `VALUES` inserts compact.
Use a multiline layout for structured `SELECT`-based inserts.

`VALUES` payloads are data. Every value keeps its exact spelling.
The statement stays on one line when it fits. Otherwise, the layout is: `INSERT INTO target`, then the column list
(one line, or one column on each line), then an optional `SETTINGS` line, then `VALUES`.
Each row goes on its own line.

A row that does not fit puts one value on each line:

```sql
INSERT INTO ops.deploy_events
    (id, service, status)
SETTINGS async_insert = 1, wait_for_async_insert = 0
VALUES
    (1, 'api-gateway', 'deployed'),
    (2, 'auth-service', 'rolled_back')
```

```sql
INSERT INTO anon.metrics_store
SELECT
    entity_key,
    metric_value
FROM anon.source_table
```

## Whitespace Hygiene

Always make sure of these points:

- Do not leave trailing spaces.
- Do not add double spaces for alignment outside the intended aligned blocks.
- Do not mix indentation widths.
- Do not add blank lines that break the visual structure of a query.

## Practical Summary

Use this mental model to format queries:

1. Start every major clause on its own line.
2. Indent multiline content by 4 spaces.
3. Align `AS` only inside multiline projection-style blocks.
4. Keep simple clauses compact.
5. Expand complex clauses vertically.
6. Use parentheses only when they improve structure.
7. Keep the layout stable across similar query shapes.

## Comments

The formatter preserves comments. Block comments before a statement or subquery are re-indented and reflowed.
A `--` comment stays at the end of the line of the item or predicate that it follows.

### A comment runs to the end of its line

A `--` (or `#`) comment always ends at its newline. ClickHouse reads it in the same way.
This is true even in a query that is pasted as a **single line**. In that case, the comment swallows the clauses after it.
The formatter never converts comment text to code. This is true whatever the comment contains (`AND`, `OR`, `WHERE`, `FROM`, an identifier and a comma):

```sql
DELETE FROM db.t WHERE id = 5 -- old version: or 1 = 1
```

The result is:

```sql
DELETE FROM db.t
WHERE
    id = 5 -- old version: or 1 = 1
```

The formatter never produces `... WHERE id = 5 OR 1 = 1`. That text deletes every row.
A one-line buffer can have a comment that swallows the rest of the query. The formatter keeps that rest in the comment
(fixture `059_comments_header_and_select`). Fixtures `499`–`588` fix comments that hold clause keywords, commas and quotes.
They cover one line and several lines.

### A layout that changes the statement

The local layout works on the text. For each text with comments, the service
checks that ClickHouse reads the formatted text in the same way as the written text
(`EXPLAIN AST`, see [`docs/formatter.md`](../../../docs/formatter.md)). If it does not, the answer is the text as
it was written, with a `warning`. Fixture `596` fixes this behavior: `WITH t AS (SELECT 1)
INSERT INTO t2 ...` with a comment returns unchanged.

## Canonical Principle

When in doubt, choose the layout that makes two queries with the same structure look the same.
Consistency across the repository matters more than local style preference.

## Test Data Layout

Formatter fixtures are split into bad input and canonical output:

- `input/` contains intentionally badly formatted SQL sent to `/api/format`.
- `output/` contains the expected final formatted SQL returned by the API.

Each fixture must exist in both folders with the same file name. For example:

- `input/001_select_from.sql`
- `output/001_select_from.sql`

The test fails during collection in two cases. In the first case, an `input/` fixture has no corresponding `output/` fixture.
In the second case, an `output/` fixture has no corresponding `input/` fixture.

All `.sql` files are normalized without a trailing newline.

Fixtures `316`–`498` cover ClickHouse syntax, construct by construct. They run in this order:

- windows, grouping, LIMIT / ORDER / SAMPLE forms and joins (`316`–`349`);
- lambdas, aggregate combinators, access and casts, operators and CTEs (`350`–`384`);
- set operators, output clauses, literals, quoted strings, comments and deep nesting (`385`–`409`);
- DDL (`410`–`446`);
- INSERT, maintenance, EXPLAIN / SHOW / SET / KILL and access control (`447`–`476`);
- a mixed batch (`477`–`498`).

Every expected output is also formatted again (`test_expected_format_fixtures_are_idempotent_in_batch`).

The output must return unchanged. That request sends `"cache": false`. The API caches each output as the answer for itself.
Without that request field, the check passes, but the formatter does not run.

Every fixture is also checked for semantic safety (`test_format_fixture_preserves_ast`).
`EXPLAIN AST <input>` must equal `EXPLAIN AST <output>` on the reference ClickHouse server.
The formatter can never change what a query means. No fixture is exempt (`AST_EQUIVALENCE_EXEMPT` is empty).
A comment is never converted to code (see "A comment runs to the end of its line").