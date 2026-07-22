from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
NODE = shutil.which("node")


@pytest.mark.skipif(NODE is None, reason="Node.js is not installed in the test runner")
def test_editor_diagnostics_accept_array_join_aliases_and_reserved_aliases() -> None:
    script_path = ROOT / "src" / "static" / "app_autocomplete.js"
    node_script = r"""
const fs = require("fs");
const vm = require("vm");
const source = fs.readFileSync(process.argv[1], "utf8");
const tableColumns = {
  "system.tables": [
    { name: "parameterized_view_parameters", insertName: "parameterized_view_parameters", type: "Array(String)" },
    { name: "name", insertName: "name", type: "String" }
  ]
};
const localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {}
};
global.window = {
  localStorage,
  ChDash: {
    state: {},
    meta: {
      getTableColumns(database, table) {
        return tableColumns[`${database}.${table}`] || [];
      },
      ensureTableColumns() {}
    }
  }
};
vm.runInThisContext(source, { filename: process.argv[1] });
const tables = [{ database: "system", name: "tables" }];
const meta = {
  databases: { items: [{ name: "system" }] },
  tables: { items: tables },
  table_functions: { items: [{ name: "numbers" }] },
  functions: { items: [] },
  keywords: { items: [
    { name: "SELECT" }, { name: "FROM" }, { name: "AS" },
    { name: "ARRAY" }, { name: "JOIN" }
  ] },
  autocomplete: { tablesByDatabase: new Map([["system", tables]]) }
};
const queries = [
  `SELECT
    param,
    num
FROM system.tables
ARRAY JOIN
    parameterized_view_parameters AS param
    ARRAY JOIN[1, 2] AS num`,
  "SELECT 1 AS FROM, number FROM numbers(10)",
  `SELECT 1 AS FROM, number
FROM numbers(10)`
];
const results = queries.map((query) => window.ChDash.autocomplete.diagnose(query, meta));
process.stdout.write(JSON.stringify(results));
"""
    completed = subprocess.run(
        [NODE, "-e", node_script, str(script_path)],
        check=True,
        capture_output=True,
        text=True,
    )
    assert json.loads(completed.stdout) == [[], [], []]


def test_formatting_fixtures_cover_array_join_and_reserved_keyword_alias() -> None:
    expected_array_join = (ROOT / "tests/api/format/output/082_repeated_array_join.sql").read_text(encoding="utf-8")
    expected_reserved = (ROOT / "tests/api/format/output/083_reserved_keyword_alias.sql").read_text(encoding="utf-8")

    assert "ARRAY JOIN parameterized_view_parameters AS `param`" in expected_array_join
    assert "ARRAY JOIN [1, 2] AS `num`" in expected_array_join
    assert expected_reserved == "SELECT\n    1 AS `FROM`,\n    number\nFROM numbers(10)\n"
