SELECT
    profile_id,
    metric_score
FROM anon.profile_metrics
WHERE
    is_active = 1
    AND (
        region_code = 'region_alpha'
        OR profile_id IN (
            SELECT profile_id
            FROM anon.profile_allowlist
            WHERE
                source_tag = 'src_beta'
                AND tag_state = 'enabled'
        )
    )
    AND metric_score > 100
ORDER BY metric_score DESC
LIMIT 50