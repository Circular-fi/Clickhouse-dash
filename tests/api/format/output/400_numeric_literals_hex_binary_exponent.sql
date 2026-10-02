SELECT
    255                   AS `hex_value`,
    11                    AS `binary_value`,
    0.00001               AS `small_exponent`,
    25000000000.          AS `large_exponent`,
    -inf                  AS `negative_infinity`,
    nan                   AS `not_a_number`,
    1000000               AS `underscored_million`,
    0.000001              AS `micro_value`,
    18446744073709551615  AS `max_uint64`
FROM system.one