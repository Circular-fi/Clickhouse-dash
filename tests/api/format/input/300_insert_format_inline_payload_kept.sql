insert into events (id, payload) settings async_insert=1 format JSONEachRow
{"id": 1, "payload": "a -- not a comment"}
{"id": 2, "payload": "b"}
