SELECT trace_id
FROM otel.traces
WHERE (service_name, span_name) IN (
        ('checkout', 'POST /api/checkout'),
        ('payments', 'Charge'),
        ('inventory', 'ReserveStock'),
        ('shipping', 'Quote')
    )