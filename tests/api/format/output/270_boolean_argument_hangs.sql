SELECT
    if(
        isNotNull(parent_span_id)
            AND parent_span_id != ''
            AND service_name != 'frontend-proxy',
        concat(
            service_name,
            ' <- ',
            dictGetOrDefault(
                'obs.span_parents',
                'service_name',
                parent_span_id,
                'unknown'
            )
        ),
        service_name
    ) AS `edge`
FROM otel.traces