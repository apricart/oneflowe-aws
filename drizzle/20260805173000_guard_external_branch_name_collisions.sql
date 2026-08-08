-- Enforce at the database boundary that case-only tenant name siblings are
-- allowed exclusively when every sibling is mapped to the same external source
-- with its own stable external ID. Ordinary/unmapped branches retain the
-- platform's case-insensitive uniqueness behavior, including under concurrency.

CREATE OR REPLACE FUNCTION public.enforce_branch_name_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  conflicting_branch_id integer;
BEGIN
  -- Serialize decisions for one tenant + normalized name so an API insert and
  -- an external import cannot race past one another's checks.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'oneflowe:branch-name-identity:'
      || NEW.organization_id::text
      || ':'
      || lower(btrim(NEW.name)),
      0
    )
  );

  SELECT branch.id
  INTO conflicting_branch_id
  FROM public.branches AS branch
  WHERE branch.organization_id = NEW.organization_id
    AND branch.id <> NEW.id
    AND lower(btrim(branch.name)) = lower(btrim(NEW.name))
    AND (
      -- Exact duplicate names are never valid.
      btrim(branch.name) = btrim(NEW.name)
      -- An unmapped/manual branch may never share a normalized name.
      OR NEW.external_source IS NULL
      OR NEW.external_id IS NULL
      OR branch.external_source IS NULL
      OR branch.external_id IS NULL
      -- Case-only siblings must come from the same reviewed source namespace.
      OR branch.external_source <> NEW.external_source
    )
  LIMIT 1;

  IF conflicting_branch_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Branch name conflicts with branch % in organization %',
      conflicting_branch_id,
      NEW.organization_id
      USING
        ERRCODE = '23505',
        CONSTRAINT = 'branches_org_name_identity_guard',
        TABLE = 'branches';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS branches_name_identity_guard_trg ON public.branches;
CREATE TRIGGER branches_name_identity_guard_trg
BEFORE INSERT OR UPDATE OF organization_id, name, external_source, external_id
ON public.branches
FOR EACH ROW
EXECUTE FUNCTION public.enforce_branch_name_identity();

-- Rollback:
-- DROP TRIGGER IF EXISTS branches_name_identity_guard_trg ON public.branches;
-- DROP FUNCTION IF EXISTS public.enforce_branch_name_identity();
