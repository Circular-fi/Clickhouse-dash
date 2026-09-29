select entity_key, count() as total from anon.metrics_store where note like $$%first line
   second 'line'%$$ and position(label, $tag$--$tag$) = 0 group by entity_key