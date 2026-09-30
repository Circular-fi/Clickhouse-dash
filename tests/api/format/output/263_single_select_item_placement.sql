SELECT greatest(least(toFloat64(value), upper_bound), lower_bound) AS `clamped`
FROM metrics.gauges