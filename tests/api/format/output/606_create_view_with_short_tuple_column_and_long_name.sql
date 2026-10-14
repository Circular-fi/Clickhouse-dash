CREATE VIEW anon.v
(
    `id`    UInt64,
    `point` Tuple(x Float64, y Float64),
    `a_view_column_whose_name_is_longer_than_the_cap` String
) AS
SELECT
    1,
    (1., 2.),
    'x'