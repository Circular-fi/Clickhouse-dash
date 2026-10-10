SELECT a
FROM t
SETTINGS
    max_threads    = 4,
    -- or 8, when idle
    max_block_size = 1024