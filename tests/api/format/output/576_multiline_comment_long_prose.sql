SELECT a
FROM t
WHERE
    b = 1 -- this condition keeps rows where b is one, or else the report would double count events, and FROM the left side WHERE x
    AND c = 2