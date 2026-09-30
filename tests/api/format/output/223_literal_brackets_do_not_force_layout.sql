SELECT
    concat('[', service_name, '] -> {', region, '}')  AS `label`,
    replaceRegexpAll(path, '\\{[0-9]+\\}', '{id}')    AS `route`
FROM http_requests
LIMIT 10