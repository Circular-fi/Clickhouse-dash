SELECT
    profile_id
FROM anon_probe_table
WHERE
    is_active = 1
    AND profile_id IN (
        SELECT profile_id
        FROM anon_probe_allowlist
    )
