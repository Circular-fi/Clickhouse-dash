SELECT arrayFilter(x -> x != '', -- drop empty names
    ['checkout', -- main flow
    'payments']) AS services, (1, -- first
    2) AS pair FROM otel.traces WHERE service_name IN ('checkout', -- main flow
    'payments' -- money
) AND argMin(duration_ms, -- fastest
    timestamp) > 0