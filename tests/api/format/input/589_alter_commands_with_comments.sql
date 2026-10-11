alter table db.t add column a UInt8 default 0, -- first
  drop column b, -- second
  modify column c String -- third