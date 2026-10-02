SELECT entity_key
FROM anon.log_store
WHERE
    match(log_body, '^ERROR [0-9]+')
    AND match(entity_key, '^svc-')
    AND NOT multiSearchAny(log_body, ['healthcheck', 'readiness'])