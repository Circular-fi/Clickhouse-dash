SELECT
    CAST(metric_value, 'Decimal(18, 4)')    AS `decimal_value`,
    CAST(metric_value, 'Float32')           AS `float_value`,
    CAST('1', 'UInt8')                      AS `parsed_flag`,
    CAST(NULL, 'Nullable(String)')          AS `empty_label`,
    accurateCastOrNull(raw_value, 'UInt8')  AS `safe_value`
FROM anon.metrics_store