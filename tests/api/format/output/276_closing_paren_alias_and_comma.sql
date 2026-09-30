SELECT
    service_name,
    replaceRegexpAll(
        lower(trimBoth(user_agent, ' ')),
        '[^a-z0-9]+',
        '_'
    ) AS `ua_key`,
    count() AS `hits`,
    JSONExtract(
        payload,
        'Tuple(status String, retries UInt8, upstream Nullable(String))'
    ) AS `parsed_payload`
FROM http.access_log
GROUP BY
    service_name,
    ua_key,
    parsed_payload