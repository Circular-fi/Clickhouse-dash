ALTER TABLE db.t
ADD COLUMN IF NOT EXISTS
    `a` UInt8
AFTER b -- one command