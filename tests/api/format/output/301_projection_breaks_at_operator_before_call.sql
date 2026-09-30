SELECT
    hmac('SHA256', 'message', 'key')
        = HMAC('sha256', 'message', 'key') AS `same_result`,
    toRelativeDayNum(toDate('2023-04-01'))
        - toRelativeDayNum(toDate('2023-01-01')) AS `days`
FROM system.one