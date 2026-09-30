WITH '< Server: nginx
< Content-Type: text/html; charset=UTF-8
< Connection: keep-alive
' AS raw_headers
SELECT extractAllGroupsHorizontal(raw_headers, '< ([\\w\\-]+): ([^\\r\\n]+)') AS header_pairs