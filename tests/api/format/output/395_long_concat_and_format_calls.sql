SELECT
    format(
        '{}/{}/{}: {} events, {} errors, {}% error rate',
        service_namespace,
        service_name,
        deployment_environment,
        toString(event_count),
        toString(error_count),
        toString(round(100 * error_count / event_count, 2))
    ) AS `summary_line`
FROM anon.service_stats