SELECT
    sum(
        if(
            status_code >= 500
                AND service_name IN ('checkout', 'payments', 'inventory'),
            1,
            0
        )
    ) AS `critical_errors`,
    sum(if(status_code >= 500, 1, 0)) AS `all_errors`
FROM http.access_log