-- The DB-privilege half of the append-only promise.
--
--   docker exec -i postgres psql -U <superuser> -d stewra -v ON_ERROR_STOP=1 < deploy/audit-log-revoke.sql
--
-- 002_audit_log's comment asks production to REVOKE UPDATE, DELETE ON audit_log from the app role,
-- and no script ever existed. It could not: the app connects as `stewra`, which OWNS audit_log, and
-- Postgres does not honour REVOKE against a table's owner. The trigger was doing all the work alone.
--
-- WHAT THIS CHANGES: audit_log is handed to a NOLOGIN role that nothing connects as, so `stewra`
-- stops being its owner and the REVOKE finally bites. The app keeps connecting as `stewra` — no
-- DATABASE_URL change, no grant sweep over every other table, nothing to get subtly wrong at 2am.
--
-- Defence in depth, not the primary control. 047's trigger is still what defines the rule; this makes
-- the rule survive a `stewra` that has been talked into running arbitrary SQL, which is exactly the
-- attacker the audit log exists to catch.
--
-- WHY THE CASCADE STILL WORKS, which is the thing worth being sure about: audit_log.user_id is
-- ON DELETE SET NULL, and SET NULL is an UPDATE. If that cascade ran with the DELETING role's
-- privileges, this script would re-break account deletion — the precise bug 047 fixed — and the
-- symptom would surface in a user's erasure request, nowhere near this file. Postgres runs referential
-- actions as the referencing table's owner, so it does not. Verified rather than trusted, on a
-- throwaway database reproducing this exact arrangement: the app role's direct UPDATE was refused with
-- `insufficient_privilege`, and DELETE FROM users still cleared user_id with the summary intact.
--
-- ORDER MATTERS: run migrations FIRST. Migration 047 creates a trigger on audit_log, which requires
-- ownership. Applied in the wrong order, the migration fails.
--
-- WHEN A FUTURE MIGRATION TOUCHES audit_log it will fail with "must be owner of table audit_log".
-- That is the intended cost, and the way through is deliberate:
--
--   ALTER TABLE audit_log OWNER TO stewra;     -- as superuser, before migrating
--   ... run the migration ...
--   \i deploy/audit-log-revoke.sql             -- hand it back, re-assert
--
-- Re-runnable. Every step is conditional and the file asserts its own result at the end.

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stewra_audit') THEN
    -- NOLOGIN: this role exists to hold ownership away from the app, not to be connected as. There
    -- is deliberately no password, so it cannot become another way in.
    CREATE ROLE stewra_audit NOLOGIN;
    RAISE NOTICE 'created role stewra_audit';
  ELSE
    RAISE NOTICE 'role stewra_audit already exists';
  END IF;
END $$;

ALTER TABLE audit_log OWNER TO stewra_audit;

-- What the app legitimately does: read the activity feed, append events. Nothing else.
GRANT SELECT, INSERT ON audit_log TO stewra;

-- The point of the file. Harmless if already absent.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM stewra;

-- Assert, do not describe. A script that reported success without checking is the failure shape this
-- repo keeps finding (see iptables-egress.sh, and the tunnel in c74187a).
DO $$
DECLARE
  owner_name text;
  problems   text[] := '{}';
BEGIN
  SELECT tableowner INTO owner_name FROM pg_tables WHERE tablename = 'audit_log';

  IF owner_name IS DISTINCT FROM 'stewra_audit' THEN
    problems := problems || format('audit_log is owned by %L, expected stewra_audit', owner_name);
  END IF;
  IF has_table_privilege('stewra', 'audit_log', 'UPDATE') THEN
    problems := problems || 'stewra still has UPDATE on audit_log';
  END IF;
  IF has_table_privilege('stewra', 'audit_log', 'DELETE') THEN
    problems := problems || 'stewra still has DELETE on audit_log';
  END IF;
  -- Revoking too much is its own outage: without INSERT, every login fails.
  IF NOT has_table_privilege('stewra', 'audit_log', 'INSERT') THEN
    problems := problems || 'stewra has lost INSERT on audit_log — logins will fail';
  END IF;
  IF NOT has_table_privilege('stewra', 'audit_log', 'SELECT') THEN
    problems := problems || 'stewra has lost SELECT on audit_log — the activity feed will fail';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_audit_log_append_only' AND NOT tgisinternal
  ) THEN
    problems := problems || 'trg_audit_log_append_only is missing — run migrations first';
  END IF;

  IF array_length(problems, 1) > 0 THEN
    RAISE EXCEPTION 'audit_log privileges are NOT as intended: %', array_to_string(problems, '; ');
  END IF;

  RAISE NOTICE 'audit_log: owned by stewra_audit; stewra has SELECT+INSERT, not UPDATE/DELETE; trigger present.';
END $$;
