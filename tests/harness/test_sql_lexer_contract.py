"""One SQL lexer for the frontend (ARCH-F-089): src/static/app_sql_lex.js is the reference of the WebAssembly kernels, and no
other module scans quotes, comments and semicolons by hand. The behaviour is tested by tests/frontend/model/sql-lex.test.cjs
(Node), the kernels by tests/frontend/specs/wasm-sql.spec.js and the backend lexer by tests/native/sql_test.cpp, which all
read tests/frontend/model/sql-lex-vectors.json."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STATIC = ROOT / "src" / "static"


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_no_module_but_the_lexer_scans_quotes_and_comments_by_hand():
    # The state flags of a hand-written scanner.
    scanner = re.compile(r"\b(?:inSingle|inDouble|inBacktick|inLineComment|inBlockComment|lineComment|blockComment)\b")
    for path in sorted(STATIC.glob("app_*.js")):
        text = path.read_text(encoding="utf-8")
        assert not scanner.search(text), f"{path.name} scans SQL by hand: use app_sql_lex.js"
    # The consumers read the text through it.
    for name in ("app_highlight.js", "app_autocomplete.js", "app_sql.js", "app_results.js", "app_explorer_detail.js"):
        assert 'import { sqlLex } from "./app_sql_lex.js";' in read(f"src/static/{name}"), name
    assert "sqlLex.nextSpan(" in read("src/static/app_highlight.js")
    assert "sqlLex.mask(sql)" in read("src/static/app_autocomplete.js")
    assert "sqlLex.splitRanges(s)" in read("src/static/app_sql.js")
    # The text that the server wrote is read with the ClickHouse rules, the text that a person types with those of the page.
    assert "sqlLex.spanAt(text, at, true)" in read("src/static/app_explorer_detail.js")


def test_the_kernels_follow_the_lexer():
    kernel = read("src/wasm/sqlscan.c")
    assert "static i32 span_at(const u16 *s, i32 i, i32 len, i32 *kind) {" in kernel and "app_sql_lex.js" in kernel
    # Every scan of the kernel that reads quotes and comments goes through span_at.
    for function in ("mask_into", "statement_range", "split_top", "sq_split"):
        body = kernel[kernel.index(function):]
        assert "span_at(" in body[:2500], function
    assert "escaped" not in kernel
    assert "tests/frontend/model/sql-lex-vectors.json" in read("src/static/app_sql_lex.js")


def test_the_vectors_are_the_answers_of_the_lexer_on_texts_that_cover_its_rules():
    vectors = json.loads(read("tests/frontend/model/sql-lex-vectors.json"))
    assert len(vectors) >= 35
    texts = {vector["sql"] for vector in vectors}
    for needle in ("select 'a;b'; select 2", 'select "a;b"; select 2', "select `a;b`; select 2", "select 1 -- a;b\n; select 2", "select 1 /* a;b */; select 2",
                   "select 'abc", "select `a\\`; select 2", "/* a /* b */ ; c */ select 1", "select $$a;'b$$; select 2", "select 1 #a; b\n; select 2"):
        assert needle in texts, needle
    # The differences from ClickHouse that are on purpose are the ones that the lexer of the backend reads another way.
    differing = {vector["sql"] for vector in vectors if vector.get("differs")}
    assert {"select `a\\`; select 2", "/* a /* b */ ; c */ select 1", "select $$a;'b$$; select 2", "select 1 #a; b\n; select 2"} <= differing
    for vector in vectors:
        assert set(vector) <= {"sql", "note", "differs", "spans", "split", "statements", "mask"}, vector["sql"]
        # A position is a UTF-16 unit, as in the editor.
        units = lambda text: len(text.encode("utf-16-le")) // 2  # noqa: E731
        assert units(vector["mask"]) == units(vector["sql"])
