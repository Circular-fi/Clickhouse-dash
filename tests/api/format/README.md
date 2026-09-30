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

Keep short function calls inline.
Break long or nested expressions vertically.

Example:

```sql
SELECT
    multiIf(
        metric_value >= 1000,
        'high',
        metric_value >= 100,
        'medium',
        'low'
    ) AS metric_tier
```

For multiline expressions with an alias, keep the closing `)` aligned with the expression block and place `AS alias_name` on the same line when readable.

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

Keep lambda bodies compact unless the logic is genuinely complex.
Do not add unnecessary parentheses around simple lambda expressions.

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

### Index definitions

`INDEX name expr TYPE type GRANULARITY n` rows of one table are aligned in
columns while every aligned row fits the line width. When any row would
overflow, the rows are stacked instead, one clause per continuation line:

```sql
    INDEX idx_attributes_keys mapKeys(attributes)
        TYPE text(tokenizer = array)
        GRANULARITY 100000000
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

Every fixture is also checked for semantic safety (`test_format_fixture_preserves_ast`):
`EXPLAIN AST <input>` must equal `EXPLAIN AST <output>` on the reference ClickHouse server,
so formatting can never change what a query means. The only fixture whose input is
intentionally not the same query is the one-line comment recovery fixture (see
"One-line comment recovery"); it is listed with its reason in `AST_EQUIVALENCE_EXEMPT`.
Comment fixtures must otherwise end every `--` comment with a newline so they stay checked.