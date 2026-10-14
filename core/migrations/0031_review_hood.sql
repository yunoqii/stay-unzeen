-- Unzeen 0031 (review-hood-final.md):
-- п. 8: `needs_review` — the tx landed but its result could not be parsed (event not found,
--       ABI change). Not final: core keeps the hold and does not refund; the relayer (re-parse)
--       or the operator moves it to `confirmed` (with amounts) or `failed`.
ALTER TABLE relayer_jobs DROP CONSTRAINT relayer_jobs_status_check;
ALTER TABLE relayer_jobs ADD CONSTRAINT relayer_jobs_status_check
    CHECK (status IN ('held', 'queued', 'claimed', 'sent', 'needs_review', 'confirmed', 'failed'));

-- п. 7: time of the last positive pool price of a token. Set by the database whenever a
-- writer sets `price_sol` (INSERT or UPDATE listing price_sol, same value included), so a
-- status-only update never makes a stale price look fresh. Public data (tokens is public).
ALTER TABLE tokens ADD COLUMN price_at TIMESTAMPTZ;
CREATE FUNCTION unzeen_tokens_price_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.price_sol IS NOT NULL AND NEW.price_sol > 0 THEN
        NEW.price_at := now();
    ELSE
        NEW.price_at := NULL;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER tokens_price_at BEFORE INSERT OR UPDATE OF price_sol ON tokens
    FOR EACH ROW EXECUTE FUNCTION unzeen_tokens_price_at();
UPDATE tokens SET price_at = updated_at WHERE price_sol > 0;
