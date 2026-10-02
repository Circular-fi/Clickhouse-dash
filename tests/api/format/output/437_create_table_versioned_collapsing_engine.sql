CREATE TABLE anon.collapsing_state
(
    `entity_key`   String,
    `metric_value` Int64,
    `sign`         Int8,
    `version`      UInt32
)
ENGINE = VersionedCollapsingMergeTree(sign, version)
ORDER BY entity_key