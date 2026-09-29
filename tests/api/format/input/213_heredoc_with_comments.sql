-- heredoc next to comments
select entity_key, -- key
$$ -- inside heredoc$$ as dashed, /* block */ $q$it's$q$ as quoted_body
from anon.metrics_store where label = $$a'b$$ -- trailing