SELECT count()
FROM otel.logs
WHERE
    severity_number >= 17
    AND service_name IN (
        'checkout',
        'payments',
        'inventory',
        'shipping',
        'recommendations',
        'frontend-proxy'
    )
    AND body ILIKE '%timeout%'