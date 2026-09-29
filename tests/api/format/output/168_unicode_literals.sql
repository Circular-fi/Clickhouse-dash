SELECT
    'héllo wörld'        AS `greeting`,
    'привет мир'         AS `russian_text`,
    lengthUTF8('Ωmega')  AS `omega_length`
FROM anon.labels
WHERE label IN ('日本語テキスト', '🙂')