SELECT
    entity_key,
    count() AS `total`
FROM anon.metrics_store
WHERE
    note LIKE $$%first line
   second 'line'%$$
    AND position(label, $tag$--$tag$) = 0
GROUP BY entity_key