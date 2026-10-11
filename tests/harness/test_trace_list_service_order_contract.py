from pathlib import Path
from trace_sources import read_traces, read_unit

import modules

ROOT = Path(__file__).resolve().parents[2]


def read(rel):
    return (ROOT / rel).read_text()


def test_trace_list_orders_services_by_first_span_start():
    search = read_traces()
    # Each service's earliest span is kept in the same O(services) aggregate
    # state as its counts and sent as an offset from the trace start.
    assert '"minMap([toString(ServiceName)], [toUnixTimestamp64Nano(Timestamp)])"' in search
    assert "toString(stat.4 - toUnixTimestamp64Nano(min(Timestamp)))" in search
    assert "w.Uint64(stat.first_span_ns);" in search
    js = modules.read_family("app_trace")
    assert "service_stats: orderByFirstSpan(" in js
    assert "first_span_ns: Number(stat?.[3] || 0)" in js
    assert "(a.first_span_ns - b.first_span_ns) || (a.service < b.service ? -1 : a.service > b.service ? 1 : 0)" in js
