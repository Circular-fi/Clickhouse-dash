"""The editor diagnostics on WebAssembly (src/wasm/sqlscan.c, docs/wasm.md): the kernel scans, the page decides, and the
JavaScript reference stays the fallback and the reference of the tests."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


def test_the_query_page_lists_the_scan_kernel_as_a_lazy_group():
    modules = json.loads(read("src/static/modules.json"))
    assert modules["pages"]["query"]["lazy"]["wasm-sqlscan"] == ["app_wasm.js", "app_wasm_sqlscan.js"]
    # Only the Query page loads the editor module.
    owners = [page for page, entry in modules["pages"].items() if "app_autocomplete.js" in entry["modules"]]
    assert owners == ["query"]
    assert (ROOT / "src/static/wasm/sqlscan.wasm").is_file() and (ROOT / "src/wasm/sqlscan.c").is_file()


def test_the_editor_keeps_the_reference_and_falls_back_to_it():
    text = read("src/static/app_autocomplete.js")
    assert "function computeDiagnosticsJs(text, meta) {" in text
    assert "function computeDiagnosticsWasm(text, meta) {" in text
    # The reference answers while the kernel loads, when it is absent and when the kernel gives up.
    assert "return computeDiagnosticsJs(text, meta);" in text
    assert 'ns.loader.loadGroup("wasm-sqlscan")' in text
    assert "diagnoseJs: computeDiagnosticsJs," in text and "diagnoseWasm: computeDiagnosticsWasm," in text
    # A failure of the kernel is a null answer, never an exception of the editor.
    body = text[text.index("function computeDiagnosticsWasm(text, meta) {"):text.index("function computeDiagnostics(text, meta) {")]
    assert "} catch (error) {\n      return null;" in body
    # Both implementations share the order, the duplicate rule and the limit of 200 marks.
    assert text.count("return finishIssues(issues);") == 2
    assert "if (dedup.length >= 200) break;" in text


def test_the_adapter_and_the_kernel_agree_on_the_rows():
    adapter = read("src/static/app_wasm_sqlscan.js")
    kernel = read("src/wasm/sqlscan.c")
    rows = re.search(r"const ROWS = \[(.*?)\];", adapter).group(1)
    assert [name.strip().strip('"') for name in rows.split(",")] == ["sel", "item", "lam", "ref", "aj", "rel", "fn"]
    assert "id == 0 ? &v_sel : id == 1 ? &v_item : id == 2 ? &v_lam : id == 3 ? &v_ref : id == 4 ? &v_aj : id == 5 ? &v_rel : &v_fn" in kernel
    for export in ("sq_run", "sq_set_names", "sq_vec_ptr", "sq_vec_len", "sq_has_from", "sq_statement", "sq_statement_before"):
        assert f"EXPORT({export})" in kernel and f"exports.{export}(" in adapter, export
    # Sets of names and the page's reading of the rows use the same column counts.
    page = read("src/static/app_autocomplete.js")
    assert "for (let s = 0; s < sel.length; s += 8)" in page and "const row = n * 10;" in page and "for (let r = 0; r < rel.length; r += 6)" in page


def test_the_statement_around_the_cursor_uses_the_kernel_only_for_a_long_script():
    text = read("src/static/app_autocomplete.js")
    assert "const STATEMENT_WASM_MIN_CHARS = " in text
    assert "if (text.length < STATEMENT_WASM_MIN_CHARS) return null;" in text
    for name in ("currentStatementBefore", "currentStatementAt", "currentStatementInfoAt"):
        assert f"function {name}Js(" in text, name
        assert f"function {name}(" in text, name
    # The reference calls the reference only: a prefix of the text never goes through the kernel's copy of the last text.
    js = text[text.index("function currentStatementAtJs("):text.index("function lastTopLevelComma(")]
    assert "currentStatementBefore(" not in js.replace("currentStatementBeforeJs(", "").split("function currentStatementBefore(")[0]
    adapter = read("src/static/app_wasm_sqlscan.js")
    assert "statementStart(kernel, { text })" in adapter and "names(kernel, sets) {\n      dropCached(kernel);" in adapter


def test_the_kernel_is_freestanding_and_documents_the_reference_it_follows():
    kernel = read("src/wasm/sqlscan.c")
    assert '#include "rt.h"' in kernel and "#include <" not in kernel
    for reference in ("maskSql()", "splitTopLevelWithSpans()", "collectLambdaParams()", "collectIdentifierRefs()", "collectArrayJoinAliases", "currentStatementAt", "normalizeQualifiedName"):
        assert reference in kernel, reference


def test_the_spec_compares_the_two_implementations_on_the_corpus_and_on_seeded_scripts():
    spec = read("tests/frontend/specs/wasm-sql.spec.js")
    for needle in ("sqlCorpus()", "fuzzScripts(", "fuzzSql(", "diagnoseJs", "diagnoseWasm", "route('**/wasm/sqlscan.wasm*'", "performance budget:"):
        assert needle in spec, needle
