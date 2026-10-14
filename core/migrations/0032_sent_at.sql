-- Unzeen 0032: `relayer_jobs.sent_at` — when the job first became `sent` (tx broadcast). Set by
-- the database only on the transition into 'sent' (a value written by the relayer is replaced
-- by now()); a claim or retry (queued / claimed) never sets or changes it.
ALTER TABLE relayer_jobs ADD COLUMN sent_at TIMESTAMPTZ;
CREATE FUNCTION unzeen_jobs_sent_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.sent_at := CASE WHEN NEW.status = 'sent' THEN now() END;
    ELSIF NEW.status = 'sent' AND OLD.status IS DISTINCT FROM 'sent' THEN
        NEW.sent_at := now();
    ELSE
        NEW.sent_at := OLD.sent_at;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER relayer_jobs_sent_at BEFORE INSERT OR UPDATE ON relayer_jobs
    FOR EACH ROW EXECUTE FUNCTION unzeen_jobs_sent_at();
