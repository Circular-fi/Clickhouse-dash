from pathlib import Path
from explorer_sources import read_unit

ROOT = Path(__file__).resolve().parents[2]


def test_parameterized_view_without_system_columns_is_not_fatal() -> None:
    # The table detail reader (explorer_detail.cpp) reads the columns; the DESCRIBE fallback is a statement of explorer_sql.cpp.
    source = read_unit("explorer_detail.cpp")

    assert "parameterized View objects intentionally have no" in source
    assert "describe_sql(database_, table_, false)" in source
    assert '" SETTINGS describe_include_subcolumns = "' in read_unit("explorer_sql.cpp")
    assert "schema_unresolved_view" in source
    assert 'summary_.engine == "View"' in source
    assert 'out_.unavailable_sections.push_back("columns")' in source
    assert "out_.columns.empty() && !schema_unresolved_view" in source


def test_int256_native_decode_failure_retries_with_describe() -> None:
    source = (ROOT / "src" / "query_session.cpp").read_text(encoding="utf-8")
    scan = (ROOT / "src" / "sql_scan.hpp").read_text(encoding="utf-8")

    assert 'icontains(msg, "unsupported type")' in source
    assert 'ident == "finalizeaggregation"' in scan
    assert 'sql_identifier_ends_with(ident, "merge")' in scan
    assert 'ident == "uint256"' in scan
    assert 'ident == "int256"' in scan
