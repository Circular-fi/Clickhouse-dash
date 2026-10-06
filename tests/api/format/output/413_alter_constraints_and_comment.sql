ALTER TABLE anon.orders
    ADD CONSTRAINT IF NOT EXISTS positive_price CHECK unit_price > 0,
    DROP CONSTRAINT IF EXISTS legacy_check,
    MODIFY COMMENT 'orders with validated prices'