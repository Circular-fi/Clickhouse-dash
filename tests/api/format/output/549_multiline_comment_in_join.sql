SELECT *
FROM a
left join b
    ON a.id = b.id -- or a.id = b.parent
WHERE a.x = 1