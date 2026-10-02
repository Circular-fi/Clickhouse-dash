SELECT
    payload.user.id                     AS `user_id`,
    CAST(payload.user.name, 'String')   AS `user_name`,
    payload.items.:`Array(JSON)`.price  AS `item_prices`,
    payload.^metadata                   AS `metadata_subobject`,
    payload.amount.:Float64             AS `typed_amount`,
    mixed_value.String                  AS `string_variant`,
    mixed_value.UInt64                  AS `number_variant`,
    dynamicType(dynamic_value)          AS `dynamic_kind`
FROM anon.json_store