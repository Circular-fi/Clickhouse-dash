SELECT
    bytes_out - bytes_in AS net_bytes, -- negative when ingress dominates
    -delta_ms AS reversed_delta -- sign flipped for charts
FROM network.flow_rollup_1m
-- end of report