WITH
    [
        (
            'WX-STN-01',
            toDate(now() - toIntervalDay(2))
        )
    ]                                           AS `site_dates`,
    arrayMin(arrayMap(p -> p.2, site_dates))    AS `min_site_date`
SELECT
    station,
    date,
    rainfall
FROM anon.weather_samples AS c
PREWHERE date >= min_site_date
WHERE arrayExists(
        p -> station = p.1
            AND date >= p.2,
        site_dates
    )
