SELECT
    format(
        '{} served {} requests in {} ms',
        service_name,
        toString(request_count),
        toString(p95_latency_ms)
    ) AS `summary_line`
FROM observability.service_rollup_1m
WHERE event_date = today()
FORMAT JSONEachRow