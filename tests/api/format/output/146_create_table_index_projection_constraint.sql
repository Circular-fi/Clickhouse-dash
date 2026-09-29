CREATE TABLE anon.orders
(
    `order_id`     UInt64,
    `customer_key` String,
    `amount`       Decimal(18, 2),
    INDEX idx_customer customer_key TYPE bloom_filter GRANULARITY 1,
    CONSTRAINT positive_amount CHECK amount > 0,
    PROJECTION customer_totals
    (
        SELECT
            customer_key,
            sum(amount)
        GROUP BY customer_key
    )
)
ENGINE = MergeTree
ORDER BY order_id