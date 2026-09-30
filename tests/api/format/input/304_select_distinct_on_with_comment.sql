-- keep the latest row per key
select distinct on (service_name,  span_name) service_name, span_name, duration_ms from otel.traces order by timestamp desc