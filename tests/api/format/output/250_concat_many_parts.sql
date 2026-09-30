SELECT
    concat(
        service_namespace,
        '/',
        service_name,
        '@',
        service_version,
        ' [',
        deployment_environment,
        ']'
    ) AS `service_label`,
    concat(host_name, ':', toString(port)) AS `endpoint`
FROM otel.resources