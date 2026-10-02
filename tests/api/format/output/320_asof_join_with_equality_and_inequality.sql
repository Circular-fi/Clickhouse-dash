SELECT
    t.symbol_code,
    t.trade_time,
    q.ask_price
FROM anon.trades AS t
ASOF INNER JOIN anon.quotes AS q
    ON t.symbol_code = q.symbol_code
    AND t.venue_code = q.venue_code
    AND t.trade_time >= q.quote_time