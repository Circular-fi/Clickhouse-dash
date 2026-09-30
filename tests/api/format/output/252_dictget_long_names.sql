SELECT
    dictGetOrDefault(
        'observability.service_owners_dictionary',
        'team_slack_channel',
        tuple(service_name, deployment_environment),
        '#oncall-default'
    ) AS `oncall_channel`,
    dictGet('geo.ip_ranges', 'country', toIPv4(client_ip)) AS `country`
FROM http.access_log