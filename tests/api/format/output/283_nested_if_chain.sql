SELECT
    if(
        status_code >= 500,
        'server_error',
        if(
            status_code >= 400,
            'client_error',
            if(status_code >= 300, 'redirect', 'success')
        )
    ) AS `outcome`
FROM http.access_log