-- users.email must NOT be unique.
--
-- `db/schema.ts` declares it as a plain index — `index("users_email_idx")` —
-- but the baseline migration (20251024115710_parched_centennial) created it
-- UNIQUE, and no migration was ever written to change that. Production has it
-- non-unique already, so this only affects databases rebuilt from the journal,
-- where it silently reintroduces a constraint the application contradicts.
--
-- The constraint is wrong because one person legitimately holds several
-- accounts behind a single address: every K-Electric person has a `-ba` and an
-- `-op` account on the same email, and one shared mailbox carries eighteen.
-- With the unique index in place a rebuilt database cannot hold K-Electric at
-- all — `sync-ke.ts` fails on the second account it writes.
--
-- Recreated rather than merely dropped so the lookup path keeps its index.
-- Guarded on `indisunique` so re-running is a no-op and so it does not churn an
-- index that is already correct.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = 'users_email_idx'
       AND n.nspname = 'public'
       AND i.indisunique
  ) THEN
    DROP INDEX "public"."users_email_idx";
    CREATE INDEX "users_email_idx" ON "users" USING btree ("email");
  END IF;
END $$;
