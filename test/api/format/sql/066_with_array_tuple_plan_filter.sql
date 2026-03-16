WITH
    [
        (
            'Hk9sLm4Qp2vTx7ZaNc5Re8WuJy3Bd6FgMi1KoPrStUvX',
            toDate(now() - toIntervalDay(2))
        )
    ]                                           AS user_plans,
    arrayMin(arrayMap(p -> p.2, user_plans))    AS min_plan_date
SELECT
    user_id,
    date,
    consumed
FROM anon.user_credits_consumption AS c
PREWHERE date >= min_plan_date
WHERE arrayExists(
        p -> (
            user_id = p.1
            AND date >= p.2
        ),
        user_plans
    )