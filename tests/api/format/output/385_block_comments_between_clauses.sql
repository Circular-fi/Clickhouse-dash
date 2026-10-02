SELECT
    /* projection */ entity_key,
    metric_value /* value */
FROM /* source */ anon.metrics_store
WHERE /* filter */ metric_value > 0
GROUP BY
    /* key */ entity_key,
    metric_value
ORDER BY metric_value DESC /* largest first */