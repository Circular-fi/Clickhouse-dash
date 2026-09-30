SELECT
    map(
        'checkout', 99.9,
        'payments', 99.95,
        'inventory', 99.5,
        'shipping', 99.,
        'frontend', 99.99
    ) AS `slo_targets`,
    map('env', 'prod') AS `labels`,
    map(
        'checkout', ['payments', 'inventory', 'shipping'],
        'frontend', ['checkout', 'recommendations', 'ad-service', 'cart']
    ) AS `dependencies`