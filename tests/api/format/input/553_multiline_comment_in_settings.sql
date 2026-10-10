select a from t
settings max_threads = 4, -- or 8, when idle
max_block_size = 1024