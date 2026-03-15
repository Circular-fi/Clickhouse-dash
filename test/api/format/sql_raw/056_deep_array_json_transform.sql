WITH
    '[{"name":"alpha","value":10},{"name":"beta","value":20},{"name":"gamma","value":5}]' AS payload_json,
    JSONExtractArrayRaw(payload_json) AS raw_items,
    arrayMap(item -> JSONExtractString(item, 'name'), raw_items) AS item_names,
    arrayMap(item -> JSONExtractUInt(item, 'value'), raw_items) AS item_values,
    arrayMap(item -> (item.1, item.2, (item.2) >= 10), arrayZip(item_names, item_values)) AS item_tuples,
    arrayFilter(item -> (item.3), item_tuples) AS filtered_items,
    arrayMap(item -> map('name', item.1, 'value', toString(item.2)), filtered_items) AS mapped_items,
    arrayReduce('sum', arrayMap(item -> toUInt64(item.2), filtered_items)) AS filtered_sum,
    arrayStringConcat(arrayMap(item -> concat(item.1, ':', toString(item.2)), filtered_items), ', ') AS filtered_summary
SELECT
    raw_items,
    item_names,
    item_values,
    item_tuples,
    filtered_items,
    mapped_items,
    filtered_sum,
    filtered_summary
