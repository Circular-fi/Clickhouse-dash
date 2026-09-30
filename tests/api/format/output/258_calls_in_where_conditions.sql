SELECT trace_id
FROM otel.traces
WHERE
    has(mapKeys(span_attributes), 'http.status_code')
    AND toUInt16OrZero(span_attributes['http.status_code']) >= 500
    AND match(
        span_name,
        '(?i)timeout|deadline exceeded|connection reset by peer'
    )