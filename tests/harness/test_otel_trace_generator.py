"""The synthetic OpenTelemetry trace generator (examples/generate_otel_traces.py), run for real.

The fixture of the tests and the load tests read its output: a trace count, a span count and a service count within the
bounds that were asked, the columns of the exporter table, events and links.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "examples" / "generate_otel_traces.py"

REQUIRED_COLUMNS = {
    "Timestamp", "TraceId", "SpanId", "ParentSpanId", "SpanName", "SpanKind", "ServiceName",
    "Duration", "StatusCode", "StatusMessage", "SpanAttributes", "ResourceAttributes",
    "Events.Timestamp", "Events.Name", "Events.Attributes", "Links.TraceId", "Links.SpanId", "Links.Attributes",
}


def generate(out: Path, seed: int) -> tuple[dict, list[dict]]:
    subprocess.run(
        [sys.executable, str(SCRIPT), "--traces", "3", "--min-spans", "60", "--max-spans", "90", "--seed", str(seed), "--output-dir", str(out)],
        check=True, capture_output=True, text=True,
    )
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    rows = [json.loads(line) for line in (out / "otel_traces.jsonl").read_text(encoding="utf-8").splitlines()]
    return manifest, rows


@pytest.mark.parametrize("seed", [53, 54])
def test_the_generator_makes_traces_of_the_asked_size_across_many_services(tmp_path: Path, seed: int) -> None:
    manifest, rows = generate(tmp_path / "fixture", seed)
    assert manifest["trace_count"] == 3
    assert 180 <= manifest["span_count"] <= 270
    assert len(rows) == manifest["span_count"]
    assert all(60 <= trace["span_count"] <= 90 for trace in manifest["traces"])
    assert all(trace["service_count"] >= 8 for trace in manifest["traces"])
    assert REQUIRED_COLUMNS.issubset(rows[0])
    assert any(row["Events.Name"] for row in rows)
    assert any(row["Links.TraceId"] for row in rows)
    assert {"test_ingest", "test_worker", "test_enrichment", "edge_gateway", "processing_worker", "clickhouse_writer"} & set(manifest["services"])


def test_the_generator_is_deterministic_for_a_seed_and_domain_neutral(tmp_path: Path) -> None:
    first, rows_first = generate(tmp_path / "a", 7)
    second, rows_second = generate(tmp_path / "b", 7)
    assert first["span_count"] == second["span_count"]
    assert [row["SpanName"] for row in rows_first] == [row["SpanName"] for row in rows_second]
    other, _ = generate(tmp_path / "c", 8)
    assert [t["span_count"] for t in other["traces"]] != [t["span_count"] for t in first["traces"]] or other["span_count"] != first["span_count"]
    payload = json.dumps(rows_first).lower()
    for forbidden in ("solana", "slot_number", "mint_", "supply_", "pumpfun"):
        assert forbidden not in payload
