SELECT
    round(
        quantileTDigestIf(0.99)(
            duration_ns / 1000000,
            status_code = 'STATUS_CODE_ERROR' AND service_name = 'checkout'
        ),
        2
    ) AS `p99_error_ms`
FROM otel.traces