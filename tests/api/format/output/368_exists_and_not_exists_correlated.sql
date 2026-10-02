SELECT o.entity_key
FROM anon.orders AS o
WHERE
    exists(
        SELECT 1
        FROM anon.payments AS p
        WHERE p.order_key = o.entity_key
    )
    AND NOT exists(
        SELECT 1
        FROM anon.refunds AS r
        WHERE r.order_key = o.entity_key
    )