-- keep the view definition in sync
CREATE OR REPLACE VIEW checkout_errors AS
SELECT
    service_name,
    count() AS `errors`
FROM otel.traces
WHERE status_code = 'Error'
GROUP BY service_name