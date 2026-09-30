SELECT
    round(
        sum(
            if(
                status_code >= 500 AND service_name = 'checkout-service-eu',
                duration_ms,
                0
            )
        ) / nullIf(sum(duration_ms), 0),
        4
    ) AS `checkout_error_time_share`
FROM http.access_log