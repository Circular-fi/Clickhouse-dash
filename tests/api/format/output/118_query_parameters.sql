SELECT
    entity_key,
    metric_value
FROM {source_table:Identifier}
WHERE
    (
        event_date >= {start_date:Date}
        AND event_date <= {end_date:Date}
    )
    AND entity_group IN ({groups:Array(String)})
LIMIT {row_limit:UInt32}