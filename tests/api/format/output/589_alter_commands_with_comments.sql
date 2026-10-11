ALTER TABLE db.t
ADD COLUMN `a` UInt8 default 0, -- first
DROP COLUMN b, -- second
MODIFY COLUMN `c` String -- third