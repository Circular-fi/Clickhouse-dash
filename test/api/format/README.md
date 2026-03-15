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

## Canonical Principle

When in doubt, choose the formatting that makes two queries with the same structure look the same.
Consistency across the repository matters more than local stylistic preference.

## Test Data Layout

- `sql_raw/` contains the raw ClickHouse output used as formatter input.
- `sql/` contains the expected final formatted SQL returned by the API.

The roundtrip test sends each file from `sql_raw/` to `/api/format` and compares the response to the matching file in `sql/`.

All `.sql` files are normalized without a trailing newline.