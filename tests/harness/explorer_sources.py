"""The sources of the Explorer for the contract tests.

The routes are adapters in src/api_explorer.cpp. What they call lives in src/explorer_*.{hpp,cpp}: the readers of the catalog, the sidebar, the storage
map, the card of a table, the functions and the preview (over a ChExecutor), every statement as a pure function (explorer_sql.cpp), the rules on the rows
that were read, the lineage, the TTL parser, and the graph (its reads, its builder and its scope). A test that checks the text of a statement or of a rule
reads the unit that holds it (`read_unit`), or one of the bundles:

  read_catalog()  every reader of the catalog, in the order of the routes (sidebar, storage map, table summary, catalog, table detail, lineage,
                  functions, preview), then the statements, the rules, the replica counts and the helpers of the readers
  read_graph()    the reads of the graph, its builder, the TTL parser and the statements
  read_api()      the routes (adapters), the service, the JSON writers and the scope of the graph: what the routes do from the request to the answer
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"

CATALOG_UNITS = [
    "explorer_catalog.hpp", "explorer_index.cpp", "explorer_storage.cpp", "explorer_table.cpp", "explorer_catalog.cpp", "explorer_detail.hpp",
    "explorer_detail.cpp", "explorer_lineage.cpp", "explorer_functions.cpp", "explorer_preview.cpp", "explorer_replicas.cpp", "explorer_rules.hpp",
    "explorer_rules.cpp", "explorer_sql.hpp", "explorer_sql.cpp", "explorer_values.hpp",
]
GRAPH_UNITS = [
    "explorer_graph.hpp", "explorer_graph.cpp", "explorer_graph_build.hpp", "explorer_graph_build.cpp", "explorer_ttl.hpp", "explorer_ttl.cpp",
    "explorer_sql.cpp", "explorer_values.hpp",
]


API_UNITS = [
    "api_explorer.cpp", "explorer_service.hpp", "explorer_service.cpp", "explorer_json.hpp", "explorer_json.cpp", "explorer_graph_scope.hpp",
    "explorer_graph_scope.cpp",
]


def read_unit(name: str) -> str:
    """One unit by its file name, for example read_unit("explorer_sql.cpp")."""
    return (SRC / name).read_text()


def _read(names: list[str]) -> str:
    return "\n".join((SRC / name).read_text() for name in names)


def read_catalog() -> str:
    """The readers of the catalog, the sidebar, the storage map, the card of a table, the functions and the preview, with their statements."""
    return _read(CATALOG_UNITS)


def read_graph() -> str:
    """The reads of the graph, its builder, the TTL parser and the statements."""
    return _read(GRAPH_UNITS)


def read_api() -> str:
    """The routes, the service, the JSON writers and the scope of the graph."""
    return _read(API_UNITS)
