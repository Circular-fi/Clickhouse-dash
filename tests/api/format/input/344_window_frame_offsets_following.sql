SELECT entity_key,event_date,
sum(metric_value) OVER (PARTITION BY entity_key ORDER BY event_date ROWS BETWEEN 3 PRECEDING AND 3 FOLLOWING) AS centered_sum,
max(metric_value) OVER (PARTITION BY entity_key ORDER BY event_date ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) AS future_max,
min(metric_value) over (partition by entity_key order by event_date rows unbounded preceding) as running_min
FROM anon.metrics_store