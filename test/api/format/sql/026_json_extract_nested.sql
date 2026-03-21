-- INPUT
SELECT
    entity_key,
    JSONExtractString(payload_json, 'outer', 'inner', 'label')  AS nested_label,
    JSONExtractUInt(payload_json, 'metrics', 'count')           AS metric_count,
    JSONExtractBool(payload_json, 'flags', 'is_active')         AS is_active
FROM anon.json_events
WHERE JSONExtractString(payload_json, 'outer', 'inner', 'label') != ''

-- EXPECTED
SELECT
    entity_key,
    JSONExtractString(payload_json, 'outer', 'inner', 'label') AS `nested_label`,
    JSONExtractUInt(payload_json, 'metrics', 'count')          AS `metric_count`,
    JSONExtractBool(payload_json, 'flags', 'is_active')        AS `is_active`
FROM anon.json_events
WHERE JSONExtractString(payload_json, 'outer', 'inner', 'label') != ''
