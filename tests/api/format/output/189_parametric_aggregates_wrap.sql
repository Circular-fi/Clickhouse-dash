SELECT
    user_id,
    windowFunnel(3600)(
        event_timestamp,
        event_name = 'view',
        event_name = 'cart',
        event_name = 'buy'
    ) AS `funnel_level`,
    quantiles(0.5, 0.9)(latency_ms) AS `latency_quantiles`,
    quantilesTDigestIf(0.5, 0.75, 0.9, 0.95, 0.99, 0.999)(
        response_time_ms,
        status_code = 200
    ) AS `ok_latency_quantiles`,
    sequenceMatch('(?1)(?t<=3600)(?2)')(
        event_timestamp,
        event_name = 'signup',
        event_name = 'purchase'
    ) AS `converted`,
    topK(10)(search_query) AS `top_queries`,
    round(
        quantile(0.99)(response_time_ms) / quantile(0.5)(response_time_ms),
        2
    ) AS `tail_ratio`,
    histogram(5)(session_duration_seconds) AS `duration_histogram`,
    sumMapFiltered(['revenue', 'refund', 'chargeback', 'fee', 'tax'])(
        event_keys,
        event_values
    ) AS `filtered_totals`
FROM anon.events
GROUP BY user_id
HAVING windowFunnel(86400)(
        event_timestamp,
        event_name = 'view',
        event_name = 'buy'
    ) >= 2