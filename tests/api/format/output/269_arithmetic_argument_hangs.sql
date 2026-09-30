SELECT
    round(
        sumIf(duration_ns, status_code = 'STATUS_CODE_ERROR')
            / greatest(sum(duration_ns), 1)
            * 100,
        2
    ) AS `error_time_share_pct`,
    round(
        100 * countIf(status_code = 'STATUS_CODE_ERROR') / count(),
        3
    ) AS `error_rate_pct`
FROM otel.traces