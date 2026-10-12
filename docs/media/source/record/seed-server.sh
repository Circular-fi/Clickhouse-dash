#!/bin/bash
# The library (two folders, four queries) and the three MCP keys of the demo server (API_URL, default 127.0.0.1:18290).
API=${API_URL:-http://127.0.0.1:18290}
H='Content-Type: application/json'
post() { curl -s -X POST "$API/api/$1" -H "$H" -d "$2"; }
F1=$(post query-library/folders '{"host_id":"prod-eu-1","parent_id":null,"name":"Observability"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
F2=$(post query-library/folders '{"host_id":"prod-eu-1","parent_id":null,"name":"Capacity"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
q() { post query-library/queries "$1" >/dev/null; }
q "{\"host_id\":\"prod-eu-1\",\"folder_id\":\"$F1\",\"name\":\"Error rate by service\",\"description\":\"Failed spans per service over the last day\",\"sql\":\"SELECT ServiceName, countIf(StatusCode = 'Error') AS errors, count() AS spans FROM otel.otel_traces GROUP BY ServiceName ORDER BY errors DESC\"}"
q "{\"host_id\":\"prod-eu-1\",\"folder_id\":\"$F1\",\"name\":\"Slowest operations\",\"description\":\"Top operations by p99 latency\",\"sql\":\"SELECT SpanName, quantile(0.99)(Duration) / 1e6 AS p99_ms FROM otel.otel_traces GROUP BY SpanName ORDER BY p99_ms DESC LIMIT 20\"}"
q "{\"host_id\":\"prod-eu-1\",\"folder_id\":\"$F2\",\"name\":\"Largest tables\",\"description\":\"Bytes on disk by table\",\"sql\":\"SELECT database, table, sum(bytes_on_disk) AS bytes FROM system.parts WHERE active GROUP BY database, table ORDER BY bytes DESC LIMIT 10\"}"
q "{\"host_id\":\"prod-eu-1\",\"folder_id\":null,\"name\":\"Recent weather\",\"description\":\"The latest observations\",\"sql\":\"SELECT * FROM chdash_ui.weather_observations ORDER BY observed_at DESC LIMIT 10\"}"
post mcp/keys '{"name":"claude-analyst","hosts":["prod-eu-1"],"tools":["list_hosts","list_databases","list_tables","describe_table","query_table","list_services","search_traces","get_trace","search_logs","list_metrics","query_metric","explorer_catalog","explorer_table","explorer_graph","system_overview","system_queries","format_sql"],"databases":["otel","chdash_ui"]}' >/dev/null
post mcp/keys '{"name":"oncall-bot","hosts":["prod-eu-1"],"tools":["list_services","search_traces","get_trace","search_logs","list_metrics","query_metric","traces_heatmap","traces_service_map","logs_patterns","metrics_series","traces_logs"],"databases":["otel"],"max_rows":200}' >/dev/null
post mcp/keys '{"name":"weather-dashboards","hosts":["prod-eu-1"],"tools":["list_databases","list_tables","describe_table","query_table"],"databases":["chdash_ui.weather_*"]}' >/dev/null
echo seeded
