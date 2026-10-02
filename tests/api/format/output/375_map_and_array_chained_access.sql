SELECT
    resource_attributes['service.name'] AS `service_name`,
    (span_attributes['http.request.header'])['x-request-id'] AS `request_id`,
    metric_values[1] AS `first_value`,
    metric_values[-1] AS `last_value`,
    (nested_arrays[2])[3] AS `nested_element`,
    arraySlice(metric_values, 2, 3) AS `middle_values`,
    arraySlice(metric_values, -3) AS `last_three`
FROM anon.otel_store