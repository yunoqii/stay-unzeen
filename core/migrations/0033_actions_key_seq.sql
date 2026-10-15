-- Unzeen 0033: `actions.key_seq` — per-key insertion counter (1, 2, 3, … for each anon key).
-- `created_at` keeps only the UTC day (N5), so `Portfolio.actions` (≤ 8, newest first) could
-- not tell which of a day's actions is the newest: a just-executed action could fall off the
-- list (devnet run 15.10). The counter orders a key's own actions and nothing else: no global
-- sequence across keys, no time finer than the day. Set by the database on insert only.
ALTER TABLE actions ADD COLUMN key_seq BIGINT NOT NULL DEFAULT 0;
UPDATE actions a SET key_seq = s.n
  FROM (SELECT id, row_number() OVER (PARTITION BY anon_pubkey ORDER BY created_at, id) AS n FROM actions) s
 WHERE a.id = s.id;
CREATE FUNCTION unzeen_actions_key_seq() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.key_seq := COALESCE((SELECT max(key_seq) FROM actions WHERE anon_pubkey = NEW.anon_pubkey), 0) + 1;
    ELSE
        NEW.key_seq := OLD.key_seq;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER actions_key_seq BEFORE INSERT OR UPDATE ON actions
    FOR EACH ROW EXECUTE FUNCTION unzeen_actions_key_seq();
CREATE INDEX actions_key_seq_idx ON actions (anon_pubkey, key_seq DESC);
