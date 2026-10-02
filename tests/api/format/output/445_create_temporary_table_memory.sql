CREATE TEMPORARY TABLE scratch_keys
(
    `entity_key` String,
    `first_seen` DateTime
)
ENGINE = Memory