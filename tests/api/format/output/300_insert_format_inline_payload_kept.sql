INSERT INTO events(id, payload)
SETTINGS async_insert = 1
FORMAT JSONEachRow
{"id": 1, "payload": "a -- not a comment"}
{"id": 2, "payload": "b"}