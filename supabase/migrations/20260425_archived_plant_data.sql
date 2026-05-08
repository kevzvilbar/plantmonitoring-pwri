-- =====================================================================
-- 20260425 archived_plant_data
--   Snapshot table used by /api/admin/plants/{id} (DELETE) when called
--   with archive=true. Each row stores a JSONB blob of one source row
--   from a non-cascading child table (well_readings, locator_readings,
--   incidents, …) that was about to be force-deleted along with its
--   parent plant. This preserves operational history for compliance /
--   regulator review even after the plant is hard-deleted.
--
--   Pair with hard_delete_plant(force=True, archive=True). The actor's
--   audit-log row (deletion_audit_log) keeps the high-level "who/why",
--   while this table keeps the "what" at row-level fidelity.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.archived_plant_data (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id      UUID NOT NULL,
  plant_name    TEXT,
  source_table  TEXT NOT NULL,
  source_row_id UUID,
  payload       JSONB NOT NULL,
  archived_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_by   UUID,
  reason        TEXT
);

CREATE INDEX IF NOT EXISTS archived_plant_data_plant_idx
  ON public.archived_plant_data(plant_id);
CREATE INDEX IF NOT EXISTS archived_plant_data_table_idx
  ON public.archived_plant_data(source_table);
CREATE INDEX IF NOT EXISTS archived_plant_data_archived_at_idx
  ON public.archived_plant_data(archived_at DESC);

ALTER TABLE public.archived_plant_data ENABLE ROW LEVEL SECURITY;

-- Read: any authenticated Admin or Manager (parity with deletion_audit_log).
DROP POLICY IF EXISTS archived_plant_data_read ON public.archived_plant_data;
CREATE POLICY archived_plant_data_read
  ON public.archived_plant_data
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role IN ('Admin', 'Manager')
    )
  );

-- Write: Admin only. The backend writes via the user-scoped Supabase
-- client, so RLS still applies.
DROP POLICY IF EXISTS archived_plant_data_insert ON public.archived_plant_data;
CREATE POLICY archived_plant_data_insert
  ON public.archived_plant_data
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role = 'Admin'
    )
  );
