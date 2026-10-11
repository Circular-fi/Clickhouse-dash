ALTER TABLE db.t
UPDATE
    v = 0
WHERE
    id = 1 -- and later: OR id > 0