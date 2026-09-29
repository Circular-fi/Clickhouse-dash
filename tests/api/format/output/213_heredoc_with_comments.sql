-- heredoc next to comments
SELECT
    entity_key, -- key
    $$ -- inside heredoc$$ AS `dashed`,
    /* block */ $q$it's$q$ AS `quoted_body`
FROM anon.metrics_store
WHERE label = $$a'b$$ -- trailing