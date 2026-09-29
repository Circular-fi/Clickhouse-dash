SELECT
    payload.user.id                    AS `user_id`,
    CAST(payload.user.name, 'String')  AS `user_name`,
    payload.^user                      AS `user_object`,
    payload.value.:Int64               AS `typed_value`
FROM anon.json_events
WHERE payload.user.id IS NOT NULL