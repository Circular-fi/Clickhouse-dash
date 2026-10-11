"""The vectors of the one SQL lexer (tests/frontend/model/sql-lex-vectors.json): the data that the page lexer (sql-lex.test.cjs, Node), the
kernels (wasm-sql.spec.js) and the backend lexer (tests/native/sql_test.cpp) all read. This checks the data itself: the cases that must be
there, the differences from ClickHouse that are on purpose, and positions counted in UTF-16 units as in the editor. That no module scans
SQL by hand is a rule of test_frontend_code_rules.py."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STATIC = ROOT / "src" / "static"


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


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
