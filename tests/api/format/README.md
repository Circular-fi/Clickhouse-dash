# SQL Formatting Guide

This document defines the canonical SQL formatting style used in this repository.
Its purpose is to keep all queries visually consistent, easy to scan, and easy to review.

## Goals

- Keep formatting predictable across all files.
- Make query structure readable at a glance.
- Use compact formatting for simple constructs.
- Use vertical formatting for multi-part or dense constructs.
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

Top-level clauses should start on their own line and remain left-aligned.

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

Common top-level clauses include:

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

Indent one level inside any multiline block:

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

Inside homogeneous projection blocks, align `AS` vertically.
This applies to:

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

Alignment uses monospace display width, not bytes or code points:
East Asian Wide/Fullwidth characters (CJK, Hangul, fullwidth forms) and emoji
count two columns, while combining marks, zero-width joiners and variation
selectors count none, so literals and identifiers containing them stay aligned.

### Literal spelling

String literals keep the exact spelling of the input (`'it''s'` stays `'it''s'`),
and heredoc literals keep their heredoc form, tag and body byte-for-byte
(`$$raw 'text'$$`, `$tag$...$tag$`); they are never rewritten as quoted strings.

### Where alias alignment does not apply

Keep `AS` compact outside projection lists, for example:

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

Do not place commas at the beginning of lines.

## Compact vs Multiline Formatting

Use compact formatting when the clause is short and easy to read on one line.
Use multiline formatting when the clause contains multiple elements or becomes visually dense.

### Prefer compact when simple

```sql
GROUP BY entity_key
ORDER BY metric_value DESC
```

### Prefer multiline when there are multiple items

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
Switch to vertical formatting for multiple conditions or nested logic.

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
Do not wrap every atomic predicate in unnecessary parentheses.

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

When the join condition is composed, place `ON` on the next indented line and format conditions vertically.

```sql
INNER JOIN anon.right_reference AS right_src
    ON left_src.entity_key = right_src.entity_key
    AND left_src.entity_group = right_src.entity_group
```

### JOIN subqueries

Format subqueries as blocks and keep the alias compact after the closing parenthesis.

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
The opening parenthesis should stay attached to the operator or clause that introduces it.
The body should be indented by 4 spaces.

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

A single condition stays on the `WHERE` line; its block is indented two levels
and its `)` one level, where the condition would sit in the multi-condition
layout.

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

Function calls, array literals and `IN` value lists are laid out by one rule:
**a call stays on one line when that whole line fits; otherwise it explodes, one
argument per line.** The fixtures `230`–`286` show every case below.

### Width

- The line width is 80 columns (the `line_width` request field, 40–200),
  measured in display columns (see "Alias alignment").
- "The line" is the complete output line: indentation, the text before the call
  on the same line (`AND `, `x -> `, `ON a = `) and everything after it
  (` AS alias`, the trailing comma, the `)` of an enclosing call, `> 0`).
  A call that fits by itself but not with its alias explodes.
- A single token longer than the width (a long string literal, a long type
  string) cannot be split: it stays whole on its own argument line. Comments
  are never moved to make room.

### Inline or exploded

The decision is taken outermost first. When the outermost call fits, it and
everything inside it stay on one line. When it does not fit it explodes:

- `name(` ends the line;
- each argument goes on its own line, one level (4 spaces) deeper, followed by a
  comma except the last one;
- `)` goes on its own line at the indentation of the line that opened the call,
  followed by the rest of that line: `) AS alias,`, `),`, `) >= 2`.

Each argument is then laid out again at its new position by the same rule, so
an inner call that fits there stays inline:

```sql
SELECT
    coalesce(
        nullIf(span_attributes['http.route'], ''),
        nullIf(span_attributes['url.path'], ''),
        span_name
    ) AS `route`,
    toStartOfInterval(timestamp, toIntervalMinute(5)) AS `bucket`
```

A sole argument is never hugged: it goes on its own line like any other, so
closing parentheses never pile up (`))`) and every `)` sits under the line that
opened it.

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

Not `sipHash64(concat(` with a shared closer.

### Decision tables and pairs

- `multiIf` with two or more conditions, and `CASE` with two or more `WHEN`
  branches, are always vertical, whatever their width: one `condition, result`
  pair per line, the default last. `CASE x WHEN ...` (printed as
  `caseWithExpression`) keeps its operand on the first line. With a single
  condition they follow the width rule (`multiIf(retries > 3, 'flaky', NULL)`).
  A call that contains such a table is never joined onto one line.
- An exploded `map(...)` puts one `key, value` pair per line.

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

A lambda `x -> body` is one argument. Its body stays on the lambda's line when
it fits. A body that is a call explodes from `x -> f(`, its `)` under the
lambda's line. A boolean body wraps before `AND` / `OR`, the continuation
lines one level deeper than the lambda. A tuple body keeps its parentheses:
`(k, v) -> (k, v * 2)` returns a tuple, and without them `v * 2` would become
the next argument of the call.

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

A condition argument (`if(c, ...)`, `sumIf(x, c)`, `countIf(c)`) is formatted
like a `WHERE` condition, without the parentheses formatQuery puts around each
comparison. Inside an exploded list, the continuation lines of a wrapped
condition or arithmetic argument hang one level deeper, so they cannot be
mistaken for the next argument. A sole argument keeps its operators aligned
under its first operand (see "Arithmetic Expressions").

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

Array literals, tuples inside them and `IN (...)` value lists follow the same
rule: inline when the line fits, otherwise one element per line. An element
that fits (a tuple in an array of tuples) stays on one line.

```sql
SELECT
    [
        ('checkout', 'payments', 250, 0.999),
        ('payments', 'fraud-detection', 120, 0.9995)
    ] AS `dependency_slos`
```

A literal followed by `::Type` is kept exactly as written:
`[110, 120]::Array(DateTime)` casts the literal's source text, so its spacing
is part of the query.

### Where the call sits

- A single projection that fits stays on the `SELECT` line; one that needs
  several lines goes into the indented block, like a list.
- A single `WHERE` / `PREWHERE` / `HAVING` condition stays on the keyword line.
  When it explodes, its arguments are indented two levels and its `)` one
  level, the place the condition takes in the multi-condition layout. `IN` and
  `exists` subqueries and long `IN` value lists use the same layout.
- In a condition list (`AND` / `OR` lines, `JOIN ... ON` lines), a call explodes
  under its own line.
- A table function in `FROM` or `JOIN`, and a single `ARRAY JOIN` expression,
  explode like a `FROM` subquery: `FROM s3(` then the arguments, then
  `) AS alias`.
- `GROUP BY` and `ORDER BY` items follow the same rule as projections.
- A window function keeps its `OVER (...)` layout (see the window fixtures);
  a call containing a multi-line `OVER` specification is never joined.

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

A comment pins the layout it sits in: a call containing a comment is never
joined onto one line, and a `--` comment stays after its argument's comma.

### Alignment after joining

Joining calls can turn a multi-line item into a one-line item. Projection
aliases are then aligned as for any run of one-line items (see "Alias
alignment"); a run whose aligned form would exceed the width is not aligned,
and a closing line (`) AS x`, `] AS x`) is never padded.

### Scope

The width rule applies to queries (`SELECT`, `WITH`, `INSERT ... SELECT`, view
bodies). DDL keeps its own layout: column types such as
`Array(Tuple(...))`, `INDEX ... TYPE ...`, `CODEC(...)`, `GRANT SELECT(...)`
and keywords followed by a parenthesis (`GROUPING SETS (`) are not treated as
calls.

### Parametric aggregates

A parametric aggregate `name(parameters)(arguments)` follows the same rules as
any other call. The argument list wraps exactly when a plain call of the same
length would, with `name(parameters)(` kept on the opening line. The parameter
list goes vertical only when that head alone does not fit.

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
operators of its lowest precedence level: one operand per line, with the
operator at the start of the line. The layout then shows how the parser groups
the expression. Continuation lines hang one level (4 spaces) under the first
operand. The exception is the sole argument of a call, whose lines stay
aligned. An operand that is itself a long parenthesized expression opens a
block. After a block closes, the operator stays on the `)` line, the way
`) AS alias` does.

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

`formatQuery` parenthesizes every nested operator, for example
`((a * w1) + (b * w2)) / ((w1 + w2) + w3)`. Parentheses are not part of
the parsed AST, so the formatter removes a group when operator precedence
already produces the same tree. The input above becomes
`(a * w1 + b * w2) / (w1 + w2 + w3)`. A group is kept when it matters:

- the right operand of an operator at the same level: `a - (b - c)`, `a / (b * c)`, `a + (b + c)`
- a lower-precedence operand: `(a + b) * c`
- anything after a unary sign: `-(a + b)`, and `-(1)`, which is `negate(1)`, not the literal `-1`
- `||` chains, because the parser flattens `a || b || c` into a single `concat`
- comparisons next to a comparison: `(a > b) = (c > d)`
- member access, `IN` lists, keyword lists and DDL keys: `(x + 1).1`, `x IN (5)`, `GROUPING SETS ((a), ())`, `ORDER BY (a)`

### Unary minus

A unary sign is written against its operand: `-x`, `-(a + b)`, `a * -b`,
`x > -y`. The two signs of `- -x` keep their separating space, because `--`
would start a comment.

## Lambda Expressions

Keep lambda bodies compact; they wrap by the width rule (see "Lambdas" above).
Do not add unnecessary parentheses around simple lambda expressions, and keep
the parentheses of a tuple body.

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

Use inline formatting for single-item clauses.
Use multiline formatting for multiple items.

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

Use vertical formatting for DDL blocks and keep nested definitions indented consistently.

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

### TTL lists

Keep a single short TTL rule on the `TTL` line. Put one rule per line when there
are several, or when the rule does not fit; a conditional rule that does not fit
splits its `WHERE` like a filter (the same applies to `ALTER TABLE ... MODIFY TTL`).

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

### Access-control and refreshable view DDL

`CREATE ROW POLICY`, `CREATE SETTINGS PROFILE` and materialized view heads stay
on one line while they fit the line width. A longer statement puts every clause on
its own line at column 0: `USING` is formatted like `WHERE`, `SETTINGS` lists one
setting per line with aligned `=`, and a view head ends with `AS` on its own line
before the query.

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

`ALTER SETTINGS PROFILE` keeps its single line: its `ADD`/`MODIFY`/`DROP SETTINGS`
grammar is not a plain `name = value` list.

## INSERT Statements

Keep short `VALUES` inserts compact.
Use multiline formatting for structured `SELECT`-based inserts.

```sql
INSERT INTO anon.metrics_store
SELECT
    entity_key,
    metric_value
FROM anon.source_table
```

## Whitespace Hygiene

Always ensure:

- no trailing spaces
- no accidental double-spacing for alignment outside intended aligned blocks
- no mixed indentation width
- no blank lines that break the visual structure of a query

## Practical Summary

Use this mental model when formatting:

1. Start every major clause on its own line.
2. Indent multiline content by 4 spaces.
3. Align `AS` only inside multiline projection-style blocks.
4. Keep simple clauses compact.
5. Expand complex clauses vertically.
6. Use parentheses only when they improve structure.
7. Keep formatting stable across similar query shapes.

## Comments

Comments are preserved: block comments before a statement or subquery are
re-indented and reflowed, and a `--` comment stays at the end of the line of the
item or predicate it follows.

### One-line comment recovery

A query pasted as a **single line** (the whole buffer has no newline) cannot
contain a meaningful `--` comment in the middle: the comment swallows everything
up to the end of the buffer. The formatter treats that as a collapsed
multi-line query and splits each such comment from the SQL that follows it.
The comment text ends at the earliest of:

- a clause marker ` FROM `, ` WHERE `, ` PREWHERE `, ` GROUP BY `, ` ORDER BY `,
  ` HAVING `, ` LIMIT `, ` SETTINGS `, ` FORMAT `, ` AND `, ` OR `,
  ` UNION ALL `, ` SELECT `, ` NULL` (case-insensitive, never at the very start
  of the comment);
- an identifier directly followed by `,` (the next projection item).

A comment whose text reaches none of these keeps the rest of the line, exactly
as the parser reads it.

```sql
SELECT entity_key,-- stable identifier used for joins metric_value, metric_ratio FROM t
```

becomes

```sql
SELECT
    entity_key, -- stable identifier used for joins
    metric_value,
    metric_ratio
FROM t
```

This is deliberate: it recovers the query the author wrote. It is also the only
case where the formatted output is not the same query as the input (the input
parses as `SELECT entity_key`), which is why its fixture
(`059_comments_header_and_select`) is the single entry of `AST_EQUIVALENCE_EXEMPT`.

In a buffer with more than one line the recovery is **not** applied: every `--`
comment ends at its newline, so prose such as `-- keep rows, even when ORDER BY
is set` stays one comment (fixture `220_multiline_comment_prose_with_keywords`).

## Canonical Principle

When in doubt, choose the formatting that makes two queries with the same structure look the same.
Consistency across the repository matters more than local stylistic preference.

## Test Data Layout

Formatter fixtures are split explicitly between bad input and canonical output:

- `input/` contains intentionally badly formatted SQL sent to `/api/format`.
- `output/` contains the expected final formatted SQL returned by the API.

Each fixture must exist in both folders with the same file name. For example:

- `input/001_select_from.sql`
- `output/001_select_from.sql`

The test fails during collection when an `input/` fixture has no matching `output/` fixture, or when an `output/` fixture has no matching `input/` fixture.

All `.sql` files are normalized without a trailing newline.

Every expected output is also formatted again (`test_expected_format_fixtures_are_idempotent_in_batch`)
and must come back unchanged. That request sends `"cache": false`: the API caches each output as
the answer for itself, which would otherwise make the check pass without running the formatter.

Every fixture is also checked for semantic safety (`test_format_fixture_preserves_ast`):
`EXPLAIN AST <input>` must equal `EXPLAIN AST <output>` on the reference ClickHouse server,
so formatting can never change what a query means. The only fixture whose input is
intentionally not the same query is the one-line comment recovery fixture (see
"One-line comment recovery"); it is listed with its reason in `AST_EQUIVALENCE_EXEMPT`.
Comment fixtures must otherwise end every `--` comment with a newline so they stay checked.