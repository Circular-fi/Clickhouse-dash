-- weighted top-k over inline rows
SELECT topKWeighted(2)(k, w) FROM VALUES('k Char, w UInt64', ('y', 1), ('y', 1), ('x', 5), ('y', 1), ('z', 10))