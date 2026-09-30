SELECT
    service_name,
    countIf(
        status_code = 'STATUS_CODE_ERROR' -- server side failures only
    ) AS errors,
    uniqExact(trace_id) AS traces /* distinct traces */
FROM otel.traces
GROUP BY service_name