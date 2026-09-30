SELECT
    ['checkout', 'payments'] AS `tier_one`,
    [
        'checkout',
        'payments',
        'inventory',
        'shipping',
        'recommendations',
        'frontend-proxy',
        'ad-service'
    ] AS `critical_services`,
    has(['GET', 'HEAD'], http_method) AS `is_read`
FROM http.access_log