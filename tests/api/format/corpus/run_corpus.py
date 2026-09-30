#!/usr/bin/env python3
"""Formatter robustness corpus.

Formats thousands of real ClickHouse statements (the SQL examples shipped in
system.functions / system.table_functions documentation, plus every fixture
input) through /api/format and checks, for each statement that ClickHouse can
parse:
  * ast        EXPLAIN AST of the input equals EXPLAIN AST of the output;
  * idempotent formatting the output again returns it unchanged;
  * width      no line exceeds line_width unless it is a single unbreakable
               token (a long literal / identifier).
Usage: run_corpus.py [--api URL] [--ch URL] [--out report.json] [--limit N]
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import re
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[3]
SQL_BLOCK = re.compile(r"```sql[^\n]*\n(.*?)```", re.S)


def split_statements(text: str) -> list[str]:
    out, cur, quote, i = [], [], None, 0
    while i < len(text):
        ch = text[i]
        nxt = text[i + 1] if i + 1 < len(text) else ""
        if quote:
            cur.append(ch)
            if ch == "\\" and quote in "'\"":
                cur.append(nxt); i += 2; continue
            if ch == quote:
                quote = None
            i += 1; continue
        if ch == "-" and nxt == "-":
            j = text.find("\n", i)
            j = len(text) if j < 0 else j
            cur.append(text[i:j]); i = j; continue
        if ch in "'\"`":
            quote = ch
        if ch == ";":
            stmt = "".join(cur).strip()
            if stmt: out.append(stmt)
            cur = []; i += 1; continue
        cur.append(ch); i += 1
    stmt = "".join(cur).strip()
    if stmt: out.append(stmt)
    return out


def corpus(ch: str, auth) -> list[tuple[str, str]]:
    items = []
    tables = requests.post(ch, data=b"SELECT table FROM system.columns WHERE database = 'system' AND name = 'examples'",
                           auth=auth, timeout=60).text.split()
    for table in tables:
        name_col = "name"
        sql = f"SELECT {name_col}, examples FROM system.{table} WHERE notEmpty(examples) FORMAT JSONEachRow"
        r = requests.post(ch, data=sql.encode(), auth=auth, timeout=60)
        if r.status_code != 200:
            continue
        for line in r.text.splitlines():
            row = json.loads(line)
            for block in SQL_BLOCK.findall(row["examples"]):
                for stmt in split_statements(block):
                    if stmt.upper().startswith(("SELECT", "WITH", "CREATE", "INSERT", "ALTER", "EXPLAIN", "SHOW", "DESCRIBE")):
                        items.append((f"{table}:{row[name_col]}", stmt))
    for path in sorted((ROOT / "tests/clickhouse-init").glob("*.sql")):
        for stmt in split_statements(path.read_text(encoding="utf-8")):
            if not stmt.lstrip().startswith("--"):
                items.append((f"init:{path.name}", stmt))
    for path in sorted((ROOT / "tests/api/format/input").glob("*.sql")):
        for stmt in split_statements(path.read_text(encoding="utf-8")):
            items.append((f"fixture:{path.name}", stmt))
    if COMMENTS:
        # Comments route statements through the local formatter instead of
        # ClickHouse's formatQuery; they never change the AST.
        commented = []
        for origin, stmt in items:
            if "--" in stmt or "/*" in stmt:
                continue
            commented.append((origin + "+comments", "-- corpus leading comment\n" + stmt + "\n-- corpus trailing comment"))
        items = commented
    seen, unique = set(), []
    for origin, stmt in items:
        if stmt not in seen:
            seen.add(stmt); unique.append((origin, stmt))
    return unique


def explain_ast(ch, auth, sql):
    params = {f"param_{m}": "1" for m in re.findall(r"\{(\w+):", sql)}
    r = requests.post(ch, params=params, data=("EXPLAIN AST " + sql).encode(), auth=auth, timeout=30)
    return r.text if r.status_code == 200 else None


LINE_WIDTH = None
COMMENTS = False


def fmt(api, sql):
    payload = {"host_id": "local", "sql": sql}
    if LINE_WIDTH:
        payload["line_width"] = LINE_WIDTH
    r = requests.post(api + "/api/format", json=payload, timeout=60)
    if r.status_code != 200:
        return None, f"HTTP {r.status_code}: {r.text[:300]}", 80
    body = r.json()
    return body.get("formatted_sql"), None, int(body.get("line_width") or 80)


def check(api, ch, auth, origin, sql):
    res = {"origin": origin, "input": sql, "issues": []}
    before = explain_ast(ch, auth, sql)
    if before is None:
        res["skipped"] = "ClickHouse cannot parse/explain the input"
        return res
    out, err, width = fmt(api, sql)
    if out is None:
        res["issues"].append({"kind": "format_error", "detail": err}); return res
    res["output"] = out
    after = explain_ast(ch, auth, out)
    if after != before:
        res["issues"].append({"kind": "ast", "detail": (after or "output does not parse")[:400]})
    again, err2, _ = fmt(api, out)
    if again is not None and again != out:
        res["issues"].append({"kind": "idempotent", "detail": again})
    # Comments are never re-wrapped (their text is the author's), so only the
    # code part of a line counts.
    def code_part(line):
        return re.sub(r"\s*--.*$", "", line) if "'" not in line.split("--", 1)[0][-1:] else line
    long_lines = [l for l in out.splitlines() if len(code_part(l)) > width and len(code_part(l).strip().split()) > 1
                  and not re.fullmatch(r"\s*('([^'\\]|\\.)*'|`[^`]*`)\s*,?\s*(AS \S+)?", code_part(l))]
    if long_lines:
        res["issues"].append({"kind": "width", "detail": long_lines[:3]})
    return res


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://localhost:18080")
    ap.add_argument("--ch", default="http://localhost:18123/")
    ap.add_argument("--user", default="test"); ap.add_argument("--password", default="test")
    ap.add_argument("--out", default="corpus-report.json")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--line-width", type=int, default=0,
                    help="format at this width (e.g. 40) to stress wrapping paths")
    ap.add_argument("--comments", action="store_true",
                    help="inject comments so every statement takes the local (non-formatQuery) path")
    args = ap.parse_args()
    ap_comments = args.comments
    global LINE_WIDTH, COMMENTS
    LINE_WIDTH = args.line_width or None
    COMMENTS = ap_comments
    auth = (args.user, args.password)
    items = corpus(args.ch, auth)
    if args.limit: items = items[: args.limit]
    with cf.ThreadPoolExecutor(8) as ex:
        results = list(ex.map(lambda it: check(args.api, args.ch, auth, *it), items))
    checked = [r for r in results if "skipped" not in r]
    by_kind = {}
    for r in checked:
        for issue in r["issues"]:
            by_kind[issue["kind"]] = by_kind.get(issue["kind"], 0) + 1
    summary = {"statements": len(items), "checked": len(checked), "skipped": len(results) - len(checked),
               "clean": sum(1 for r in checked if not r["issues"]), "issues": by_kind}
    Path(args.out).write_text(json.dumps({"summary": summary, "results": [r for r in checked if r["issues"]]}, indent=1), encoding="utf-8")
    print(json.dumps(summary))
    return 0 if not by_kind.get("ast") and not by_kind.get("format_error") else 1


if __name__ == "__main__":
    sys.exit(main())
