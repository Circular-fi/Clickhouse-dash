SELECT
    arrayMap(
        group_items -> arrayFilter(
            item -> arrayExists(tag -> startsWith(tag, 'prio:'), item.tags),
            group_items
        ),
        grouped_items
    ) AS `prioritised_groups`
FROM anon.grouped_store