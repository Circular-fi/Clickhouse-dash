import json
import textwrap
from pathlib import Path

import requests

BASE_URL = "http://127.0.0.1:18080"
API_ENDPOINT = f"{BASE_URL}/api/format"

ARTIFACT_DIR = Path("tmp")
ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)

cases = []


def add_case(name: str, category: str, sql: str) -> None:
    compact = textwrap.dedent(sql)
    cases.append({"name": name, "category": category, "sql": compact})


for i in range(10):
    add_case(
        name=f"deep_nesting_{i}",
        category="deep_nesting",
        sql=f"""
        SELECT
            top_level.value,
            (
                SELECT
                    arrayJoin(arrayMap(x -> x * {i + 1}, [1, 2, 3])) AS nested_value
                FROM (
                    SELECT
                        tupleElement(inner_tuple, 1) AS inner_value,
                        (
                            SELECT inner_value * {i + 2}
                            FROM (
                                SELECT
                                    nested_base.value AS inner_value
                                FROM (
                                    SELECT number AS value
                                    FROM numbers({i + 2})
                                ) AS nested_base
                            )
                        ) AS depth_expr
                    FROM (
                        SELECT
                            tuple(number % 3 + {i + 1}, number + {i}) AS inner_tuple
                        FROM numbers(2)
                    ) AS level_two
                ) AS level_one
            ) AS nested_additions
        FROM (
            SELECT
                number * {i + 1} AS value
            FROM numbers(5)
        ) AS top_level
        WHERE
            top_level.value % {i + 3} = 0
        """,
    )

for i in range(8):
    add_case(
        name=f"cte_union_{i}",
        category="cte_union",
        sql=f"""
        WITH
            base_cte AS (
                SELECT
                    number AS value,
                    toDate('2026-03-20') AS base_date
                FROM numbers({i + 5})
            ),
            filtered_cte AS (
                SELECT
                    value AS filtered_value
                FROM base_cte
                WHERE value % {i + 2} = 0
            )
        SELECT
            value
        FROM base_cte
        UNION ALL
        SELECT
            filtered_value
        FROM filtered_cte
        WHERE
            filtered_value IN ({', '.join(str((i + 1) * val + 1) for val in range(3))})
        """,
    )

lambda_templates = [
    "arrayMap(item -> lowerUTF8(item), ['One', 'Two', 'Three'])",
    "arrayFilter(item -> length(item) > 3, ['abc', 'defgh', 'ijk'])",
    "arrayMap(item -> item * 2, [1, 2, 3])",
]
for i in range(8):
    template = lambda_templates[i % len(lambda_templates)]
    add_case(
        name=f"lambda_{i}",
        category="lambda",
        sql=f"""
        SELECT
            {template} AS transformed_values,
            arrayMap((item, idx) -> concat(item, toString(idx), '{i}'), ['a', 'b', 'c']) AS indexed_values,
            arrayMap(item -> if(length(item) > {i}, concat(item, '_long'), item), ['alpha', 'beta']) AS alias_mix
        FROM (
            SELECT
                ['nested', 'values'] AS arr
        )
        """,
    )

for i in range(6):
    add_case(
        name=f"arrays_tuples_maps_{i}",
        category="arrays_tuples_maps",
        sql=f"""
        SELECT
            tupleElement(nested.tuple_col, 1) AS first_part,
            tupleElement(nested.tuple_col, 2) AS second_part,
            nested.map_col['key_{i}'] AS map_value,
            arrayJoin(nested.arr_col) AS exploded,
            mapKeys(nested.map_col) AS map_keys
        FROM (
            SELECT
                tuple(number, number + {i}) AS tuple_col,
                map('key_{i}', ['value_' || toString(number)], 'key_static', ['static']) AS map_col,
                ['one', 'two', 'three'] AS arr_col
            FROM numbers(2)
        ) AS nested
        WHERE
            nested.map_col['key_static'][1] = 'static'
        """,
    )

json_snippets = [
    r"'{\"k\": \"v\"}'",
    r"'{\"escaped\": \"line\\nbreak\"}'",
    r"'{\"quote\": \"He said \\\"hello\\\"\"}'",
]
for i in range(6):
    snippet = json_snippets[i % len(json_snippets)]
    add_case(
        name=f"json_escape_{i}",
        category="json_escape",
        sql=f"""
        SELECT
            JSONExtractString({snippet}, 'k') AS key_value,
            JSONExtractString({snippet}, 'escaped') AS escaped_value,
            JSONExtractString({snippet}, 'quote') AS quoted_value,
            {snippet} AS raw_json,
            {snippet} AS repeated
        FROM (
            SELECT
                number + {i} AS id
            FROM numbers(1)
        )
        """,
    )

for i in range(6):
    add_case(
        name=f"comments_{i}",
        category="comments",
        sql=f"""
        SELECT /* inline comment */
            number /* weird comment */ AS value -- trailing comment
        FROM numbers({i + 3})
        WHERE
            -- filter comment
            value % {i + 2} = 0
        /*
        block comment spanning
        lines
        */
        ORDER BY value DESC -- order comment
        LIMIT {i + 1} -- limit comment
        """,
    )

for i in range(6):
    add_case(
        name=f"window_{i}",
        category="window",
        sql=f"""
        SELECT
            number,
            sum(number) OVER (PARTITION BY number % {i + 3} ORDER BY number DESC ROWS BETWEEN {i} PRECEDING AND CURRENT ROW) AS rolling_sum,
            row_number() OVER (PARTITION BY toString(number % 2) ORDER BY number) AS rn,
            lag(number, 1, -1) OVER (ORDER BY number DESC) AS previous_number
        FROM numbers({i + 5})
        WHERE number % {i + 4} != 0
        """,
    )

join_variants = [
    {"type": "LEFT JOIN", "with_on": True},
    {"type": "RIGHT JOIN", "with_on": True},
    {"type": "FULL OUTER JOIN", "with_on": True},
    {"type": "CROSS JOIN", "with_on": False},
    {"type": "INNER JOIN", "with_on": True},
    {"type": "ANY LEFT JOIN", "with_on": True},
]
for idx, variant in enumerate(join_variants):
    join_type = variant["type"]
    with_on = variant["with_on"]
    base_rows = idx + 4
    join_rows = idx + 3
    on_clause = "" if not with_on else f"\n    ON base.number = joined.key_value\n    AND base.number % {idx + 2} != 0"
    where_condition = (
        f"WHERE\n    joined.key_plus > {idx}"
        if with_on
        else f"WHERE\n    base.number % {idx + 3} != 0\n    AND joined.key_plus > {idx}"
    )
    add_case(
        name=f"join_variant_{idx}",
        category="join",
        sql=f"""
        SELECT
            base.number AS base_number,
            joined.key_value AS joined_key
        FROM numbers({base_rows}) AS base
        {join_type} (
            SELECT
                number AS key_value,
                number + {idx} AS key_plus
            FROM numbers({join_rows})
        ) AS joined{on_clause}
        {where_condition}
        """,
    )

for i in range(6):
    add_case(
        name=f"insert_hybrid_{i}",
        category="insert",
        sql=f"""
        INSERT INTO analytics.events (entity_key, event_value)
        VALUES
            ('entity_0', {i}),
            ('entity_1', {i + 1})
        SELECT
            entity_key,
            sum(event_value) AS event_value
        FROM (
            SELECT
                'entity_' || toString(number % 3) AS entity_key,
                number * {i + 2} AS event_value
            FROM numbers(3)
        )
        GROUP BY entity_key
        """,
    )

for i in range(4):
    add_case(
        name=f"settings_{i}",
        category="settings",
        sql=f"""
        SELECT
            entity_key,
            metric_value
        FROM (
            SELECT
                'entity_' || toString(number % 2) AS entity_key,
                number * {i + 10} AS metric_value
            FROM numbers(2)
        )
        SETTINGS
            max_threads = {i + 1},
            max_memory_usage = {1000 + i * 500},
            max_rows_to_read = {10000 + i * 1000}
        """,
    )

unicode_names = ['таблица', 'ключ', 'café', 'niño']
for i, uname in enumerate(unicode_names):
    add_case(
        name=f"unicode_{i}",
        category="unicode",
        sql=f"""
        SELECT
            "{uname}" AS "{uname}_alias",
            "{uname}" + toString({i}) AS combined
        FROM (
            SELECT
                {i + 1} AS "{uname}"
        ) AS "{uname}_sub"
        WHERE
            "{uname}" > {i}
        """,
    )

for i in range(6):
    values = ", ".join(str((i + 1) * val) for val in range(1, 21))
    add_case(
        name=f"long_in_{i}",
        category="long_in",
        sql=f"""
        SELECT
            number
        FROM numbers({i + 25})
        WHERE
            number IN ({values})
            OR number IN (
                {', '.join(str(val) for val in range(i * 3, i * 3 + 15))}
            )
        """,
    )

for i in range(6):
    add_case(
        name=f"case_chain_{i}",
        category="case",
        sql=f"""
        SELECT
            number,
            CASE
                WHEN number % {i + 2} = 0 THEN 'zero_mod'
                WHEN number % {i + 3} = 1 THEN 'one_mod'
                WHEN number % {i + 4} = 2 THEN 'two_mod'
            ELSE 'other'
            END AS mod_label,
            CASE mod_label
                WHEN 'zero_mod' THEN 0
                WHEN 'one_mod' THEN 1
                ELSE 2
            END AS mod_rank,
            multiIf(
                number = {i},
                'equal_index',
                number > {i},
                'greater',
                'lesser'
            ) AS multi_comp
        FROM numbers({i + 7})
        """,
    )

# weird whitespace cases intentionally keep blank lines and odd spacing

def weird_whitespace(i: int) -> str:
    return f"""
        SELECT    number

            ,   toString( number  )  AS  label

        FROM    numbers(  
            {i + 5}
        )   AS   spaced

        WHERE  spaced.number   >=   {i * 2}

        ORDER   BY
            spaced.number   DESC

        """

for i in range(4):
    add_case(
        name=f"weird_whitespace_{i}",
        category="whitespace",
        sql=weird_whitespace(i),
    )

print(f"Prepared {len(cases)} adversarial SQL cases")

results = []
failures = []

for idx, case in enumerate(cases, start=1):
    print(f"[{idx}/{len(cases)}] Formatting case {case['name']} ({case['category']})")
    payload = {"host_id": "local", "sql": case["sql"]}

    try:
        response = requests.post(API_ENDPOINT, json=payload, timeout=30)
        response.raise_for_status()
    except requests.RequestException as exc:
        body = getattr(exc, 'response', None)
        failures.append(
            {
                "name": case["name"],
                "category": case["category"],
                "error": str(exc),
                "response_body": body.text if body is not None else None,
            }
        )
        print(f"  -> Failed to format {case['name']}: {exc}")
        continue

    formatted = response.json().get("formatted_sql", "")

    try:
        second_response = requests.post(
            API_ENDPOINT, json={"host_id": "local", "sql": formatted}, timeout=30
        )
        second_response.raise_for_status()
    except requests.RequestException as exc:
        body = getattr(exc, 'response', None)
        failures.append(
            {
                "name": case["name"],
                "category": case["category"],
                "error": f"second pass failed: {exc}",
                "response_body": body.text if body is not None else None,
            }
        )
        print(f"  -> Second formatting pass failed for {case['name']}: {exc}")
        continue

    formatted_second = second_response.json().get("formatted_sql", "")

    results.append(
        {
            "name": case["name"],
            "category": case["category"],
            "input": case["sql"],
            "formatted": formatted,
            "formatted_again": formatted_second,
            "idempotent": formatted == formatted_second,
        }
    )

(ARTIFACT_DIR / "adversarial_format_results.json").write_text(
    json.dumps({"results": results, "failures": failures}, indent=2),
    encoding="utf-8",
)

print("Finished formatting campaign")
print(f"Written results to {ARTIFACT_DIR / 'adversarial_format_results.json'}")
