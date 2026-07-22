SELECT
    param,
    num
FROM system.tables
ARRAY JOIN
    parameterized_view_parameters AS param
    ARRAY JOIN[1, 2] AS num
