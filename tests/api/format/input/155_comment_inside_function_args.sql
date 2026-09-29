SELECT coalesce(primary_value, -- preferred source
fallback_value /* secondary */, 0) AS resolved_value FROM anon.metrics_store