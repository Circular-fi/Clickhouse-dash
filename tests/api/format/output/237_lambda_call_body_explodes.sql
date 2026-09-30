SELECT
    arrayJoin(
        arrayMap(
            i -> toStartOfInterval(
                window_start + toIntervalMinute(i * 5),
                toIntervalMinute(5)
            ),
            range(toUInt32(dateDiff('minute', window_start, window_end) / 5))
        )
    ) AS `slot`
FROM ops.maintenance_windows