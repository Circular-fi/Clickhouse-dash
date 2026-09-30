SELECT
    arrayMap(
        x -> round(x, 2),
        quantiles(0.5, 0.9, 0.99)(duration_ms)
    ) AS `latency_quantiles`,
    arrayFilter(t -> t != '', splitByChar(',', tags)) AS `clean_tags`
FROM otel.traces
GROUP BY tags