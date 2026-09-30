SELECT
    toDecimal64(
        sumIf(amount, currency = 'EUR' AND status = 'settled')
            / nullIf(countIf(currency = 'EUR' AND status = 'settled'), 0),
        4
    ) AS `avg_eur_settled`,
    uniqExactIf(
        user_id,
        status = 'refunded' OR status = 'chargeback'
    ) AS `disputed_users`
FROM payments.transactions