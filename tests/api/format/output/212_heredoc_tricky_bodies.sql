SELECT
    entity_key,
    $$it's -- not a comment /* nor this */ a+b   spaced$$  AS `tricky_body`,
    concat($x$prefix: "dq" `bt`$x$, entity_key)            AS `prefixed_key`,
    length($$$$)                                           AS `empty_len`
FROM anon.metrics_store
WHERE
    note = $body$ a = 'b' AND c $body$
    AND entity_group != $$live$$