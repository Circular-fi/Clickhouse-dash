-- scrape grid shared by the rate and delta examples
WITH
    [110, 120, 130, 140, 190, 200, 210, 220, 230, 240, 250]::Array(DateTime) AS `scrape_timestamps_for_grid`,
    [1, 1, 3, 4, 5, 5, 8, 12, 13]::Array(Float32) AS `vals`
SELECT arrayZip(scrape_timestamps_for_grid, vals) AS `pairs`