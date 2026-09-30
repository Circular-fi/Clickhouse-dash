SELECT *
FROM otel.logs
WHERE positionCaseInsensitive(
        body,
        'connection reset by peer while reading response header from upstream'
    ) > 0