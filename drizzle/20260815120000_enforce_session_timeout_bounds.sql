-- Normalize the previously accepted 1-1440 minute tenant setting to the
-- security policy's 1-15 minute range. Invalid legacy JSON values use the
-- secure 15-minute default.
UPDATE organization_settings
SET
  value = to_jsonb(
    CASE
      WHEN jsonb_typeof(value) IN ('number', 'string')
        AND (value #>> '{}') ~ '^[+-]?[0-9]+$'
        THEN LEAST(
          15::numeric,
          GREATEST(1::numeric, (value #>> '{}')::numeric)
        )::integer
      ELSE 15
    END
  ),
  updated_at = NOW()
WHERE key = 'session_timeout_minutes';

-- Protect the policy even from direct database writes that bypass the API.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'organization_settings_session_timeout_bounds_ck'
      AND conrelid = 'organization_settings'::regclass
  ) THEN
    ALTER TABLE organization_settings
      ADD CONSTRAINT organization_settings_session_timeout_bounds_ck
      CHECK (
        key <> 'session_timeout_minutes'
        OR CASE
          WHEN jsonb_typeof(value) = 'number'
            AND (value #>> '{}') ~ '^[0-9]+$'
            THEN (value #>> '{}')::numeric BETWEEN 1 AND 15
          ELSE FALSE
        END
      );
  END IF;
END $$;
