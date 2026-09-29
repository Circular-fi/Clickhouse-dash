select entity_key, -- stable key, used FROM joins AND exports
metric_value -- ratio, not normalized OR rounded
from anon.metrics_store where metric_value > 0 -- keep rows, even when ORDER BY is set
and entity_group = 'live' order by metric_value DESC