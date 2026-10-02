SELECT
    mapUpdate(
        map('service', service_name, 'environment', deployment_environment),
        map(
            'region', region_code,
            'zone', availability_zone,
            'cluster', cluster_name
        )
    ) AS `merged_labels`
FROM anon.service_store