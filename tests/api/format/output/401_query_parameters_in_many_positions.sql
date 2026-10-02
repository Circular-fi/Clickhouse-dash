SELECT
    {column_name:Identifier},
    count() AS `row_count`
FROM {database_name:Identifier}.{table_name:Identifier}
WHERE
    (
        event_date >= {start_date:Date}
        AND event_date <= {end_date:Date}
    )
    AND entity_key IN ({entity_keys:Array(String)})
GROUP BY {column_name:Identifier}
LIMIT {row_limit:UInt32}