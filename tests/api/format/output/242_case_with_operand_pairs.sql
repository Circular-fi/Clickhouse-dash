SELECT
    caseWithExpression(
        severity_number,
        9, 'info',
        13, 'warn',
        17, 'error',
        'other'
    ) AS `severity_bucket`,
    caseWithExpression(env, 'prod', 1, 0) AS `is_prod`
FROM otel.logs