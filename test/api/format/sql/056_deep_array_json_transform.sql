-- INPUT
WITH
    '[{"name":"alpha","scores":[1,2,3],"active":true},{"name":"beta","scores":[4,5,6],"active":false}]' AS payload_json,
    JSONExtractArrayRaw(payload_json)                                                                    AS raw_items,
    arrayMap(
        item -> JSONExtractString(item, 'name'),
        raw_items
    )                                                                                                    AS item_names,
    arrayMap(
        item -> JSONExtractArrayRaw(item, 'scores'),
        raw_items
    )                                                                                                    AS raw_scores,
    arrayMap(
        score_list -> arrayMap(
            score -> toInt32(score),
            score_list
        ),
        raw_scores
    )                                                                                                    AS parsed_scores,
    arrayMap(
        score_list -> arraySum(score_list),
        parsed_scores
    )                                                                                                    AS score_totals,
    arrayMap(
        item -> JSONExtractBool(item, 'active'),
        raw_items
    )                                                                                                    AS active_flags
SELECT
    item_names,
    parsed_scores,
    score_totals,
    active_flags

-- EXPECTED
WITH
    '[{"name":"alpha","scores":[1,2,3],"active":true},{"name":"beta","scores":[4,5,6],"active":false}]' AS `payload_json`,
    JSONExtractArrayRaw(payload_json)                                                                    AS `raw_items`,
    arrayMap(
        item -> JSONExtractString(item, 'name'),
        raw_items
    )                                                                                                    AS `item_names`,
    arrayMap(
        item -> JSONExtractArrayRaw(item, 'scores'),
        raw_items
    )                                                                                                    AS `raw_scores`,
    arrayMap(
        score_list -> arrayMap(
            score -> toInt32(score),
            score_list
        ),
        raw_scores
    )                                                                                                    AS `parsed_scores`,
    arrayMap(
        score_list -> arraySum(score_list),
        parsed_scores
    )                                                                                                    AS `score_totals`,
    arrayMap(
        item -> JSONExtractBool(item, 'active'),
        raw_items
    )                                                                                                    AS `active_flags`
SELECT
    item_names,
    parsed_scores,
    score_totals,
    active_flags
