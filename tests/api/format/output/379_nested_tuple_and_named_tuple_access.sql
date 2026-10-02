SELECT
    event_payload.1                              AS `first_element`,
    event_payload.2.1                            AS `nested_first`,
    location_tuple.latitude                      AS `latitude`,
    location_tuple.longitude                     AS `longitude`,
    tupleElement(location_tuple, 'altitude', 0)  AS `altitude_or_zero`,
    (1, 'a', [2, 3]).3                           AS `literal_tuple_element`
FROM anon.tuple_store