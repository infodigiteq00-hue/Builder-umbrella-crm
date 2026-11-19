-- A builder's logo, stored in R2 like property photos. Nullable — existing
-- builders stay valid with no logo until someone uploads one.

ALTER TABLE builders ADD COLUMN logo_r2_key TEXT;
