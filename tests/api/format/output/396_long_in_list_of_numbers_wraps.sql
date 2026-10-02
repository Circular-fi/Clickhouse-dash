SELECT entity_key
FROM anon.metrics_store
WHERE
    status_code IN (
        400,
        401,
        403,
        404,
        405,
        408,
        409,
        410,
        413,
        415,
        422,
        429,
        500,
        502,
        503,
        504
    )
    AND method_name IN ('GET', 'POST')