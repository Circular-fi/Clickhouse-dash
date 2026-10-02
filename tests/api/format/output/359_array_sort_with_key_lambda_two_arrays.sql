SELECT
    arraySort(
        (name, score) -> -score,
        entity_names,
        entity_scores
    ) AS `ranked_names`,
    arrayReverseSort(x -> length(x), entity_names) AS `longest_first`,
    arrayMap(
        (k, v, w) -> concat(k, '=', toString(v * w)),
        tag_keys,
        tag_values,
        tag_weights
    ) AS `weighted_tags`
FROM anon.ranking_store