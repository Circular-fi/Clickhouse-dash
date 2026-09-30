SELECT
    trace_id,
    attr
FROM otel.traces
ARRAY JOIN arrayFilter(
    x -> x.1 NOT IN ('internal.debug', 'internal.sampling_priority'),
    arrayZip(mapKeys(span_attributes), mapValues(span_attributes))
) AS `attr`