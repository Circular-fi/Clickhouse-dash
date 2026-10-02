SELECT
    CAST(metric_value, 'Nullable(Decimal(18, 4))')  AS `nullable_decimal`,
    CAST(raw_value, 'Map(String, UInt64)')          AS `parsed_map`,
    CAST(CAST(metric_value, 'String'), 'UInt64')    AS `round_trip`,
    CAST(CAST(event_timestamp, 'Date'), 'String')   AS `date_text`,
    CAST('42', 'Int32') + 1                         AS `shifted`,
    accurateCastOrNull(raw_value, 'UInt8')          AS `small_or_null`,
    toDecimal64OrZero(raw_value, 2)                 AS `decimal_or_zero`,
    reinterpretAsUInt64(raw_bytes)                  AS `reinterpreted`
FROM anon.raw_store