SELECT
    multiIf(status_code >= 500, 'error', 'ok')  AS `outcome`,
    multiIf(retries > 3, 'flaky', NULL)         AS `retry_label`
FROM http.access_log