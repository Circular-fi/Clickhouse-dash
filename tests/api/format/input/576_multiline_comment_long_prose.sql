select a from t
where b = 1 -- this condition keeps rows where b is one, or else the report would double count events, and FROM the left side WHERE x
and c = 2