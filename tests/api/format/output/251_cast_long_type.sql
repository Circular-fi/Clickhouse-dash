SELECT
    CAST(
        attributes,
        'Map(String, Array(Tuple(key String, value Nullable(Float64), unit LowCardinality(String))))'
    ) AS `typed_attributes`,
    CAST(status_code, 'UInt16') AS `status`
FROM otel.metrics_raw