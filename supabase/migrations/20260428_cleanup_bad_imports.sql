-- =====================================================================
-- 20260428 Cleanup: hard-delete bad-imported plants
--          ('Mambaling 3', 'SRP MCWD')
-- =====================================================================
-- This script:
--   1. Snapshots the plant_ids + dependency counts BEFORE deletion.
--   2. Inserts one audit row per plant into `deletion_audit_log` BEFORE
--      the plant rows go away (so the FK in actor_user_id and the row
--      itself remain referenceable).
--   3. Explicitly deletes all dependent rows that don't have
--      ON DELETE CASCADE through their primary parent (locator_*, well_*,
--      ro_train_readings, incidents) — needed because their plant_id
--      FKs are NO ACTION and would block the final plant delete.
--   4. Deletes the plants. The remaining tables with
--      ON DELETE CASCADE on plants(id) (locators, wells, ro_trains,
--      chemical_inventory, chemical_dosing_logs, power_readings,
--      power_tariffs, electric_bills, production_costs,
--      chemical_deliveries, ro_pretreatment_readings,
--      daily_plant_summary, checklist_templates) are removed by the
--      cascade chain.
--   5. Wrapped in a SAVEPOINT-friendly DO block; counts reported via
--      RAISE NOTICE so you can verify in the SQL editor output pane.
--
-- Pre-requisites:
--   - Run 20260424_deletion_audit_log.sql first (audit table).
--   - Run 20260428_admin_audit_enhancements.sql first (kind='well'
--     constraint relax, login_attempts table — both unrelated to
--     plant cleanup but already part of iter-7 setup).
--   - Run this AS AN ADMIN (auth.uid() must resolve to an Admin row
--     in user_roles, otherwise the audit-log RLS policy blocks the
--     insert).
--
-- Idempotent: re-running after the plants are gone does nothing
-- (the WHERE filter matches zero rows) and emits a 'no plants found'
-- notice.
-- =====================================================================

DO $$
DECLARE
  target_names CONSTANT TEXT[] := ARRAY['Mambaling 3', 'SRP MCWD'];
  doomed_ids   UUID[];
  plant_row    RECORD;
  acting_uid   UUID := auth.uid();
  cnt          BIGINT;
BEGIN
  -- 1. Snapshot the plant ids
  SELECT array_agg(id) INTO doomed_ids
  FROM public.plants
  WHERE name = ANY(target_names);

  IF doomed_ids IS NULL OR array_length(doomed_ids, 1) IS NULL THEN
    RAISE NOTICE 'No plants found matching %; nothing to do.', target_names;
    RETURN;
  END IF;

  RAISE NOTICE 'Cleaning up % plant(s): %', array_length(doomed_ids, 1), doomed_ids;

  -- 2. Audit-log BEFORE delete (one row per plant, with dependency
  --    snapshot). Uses our actual schema: kind / entity_id / entity_label
  --    / action / actor_user_id / actor_label / reason / dependencies.
  FOR plant_row IN
    SELECT id, name FROM public.plants WHERE id = ANY(doomed_ids)
  LOOP
    INSERT INTO public.deletion_audit_log (
      kind, entity_id, entity_label, action,
      actor_user_id, actor_label, reason, dependencies
    )
    SELECT
      'plant',
      plant_row.id,
      plant_row.name,
      'hard',
      acting_uid,
      'Smart-import cleanup script',
      'Smart importation error cleanup',
      jsonb_build_object(
        'wells',                   (SELECT count(*) FROM public.wells              WHERE plant_id = plant_row.id),
        'locators',                (SELECT count(*) FROM public.locators           WHERE plant_id = plant_row.id),
        'ro_trains',               (SELECT count(*) FROM public.ro_trains          WHERE plant_id = plant_row.id),
        'well_readings',           (SELECT count(*) FROM public.well_readings      WHERE plant_id = plant_row.id),
        'locator_readings',        (SELECT count(*) FROM public.locator_readings   WHERE plant_id = plant_row.id),
        'power_readings',          (SELECT count(*) FROM public.power_readings     WHERE plant_id = plant_row.id),
        'incidents',               (SELECT count(*) FROM public.incidents          WHERE plant_id = plant_row.id),
        'production_costs',        (SELECT count(*) FROM public.production_costs   WHERE plant_id = plant_row.id),
        'chemical_inventory',      (SELECT count(*) FROM public.chemical_inventory WHERE plant_id = plant_row.id)
      );
  END LOOP;

  -- 3. Delete dependent rows whose plant_id FK has NO CASCADE.
  --    (These would otherwise block the plant DELETE.)

  --    Wipe deepest descendants first (readings) before parents.
  DELETE FROM public.well_meter_replacements
   WHERE plant_id = ANY(doomed_ids);
  GET DIAGNOSTICS cnt = ROW_COUNT;  RAISE NOTICE '  well_meter_replacements:    -%', cnt;

  DELETE FROM public.well_pms_records
   WHERE plant_id = ANY(doomed_ids);
  GET DIAGNOSTICS cnt = ROW_COUNT;  RAISE NOTICE '  well_pms_records:           -%', cnt;

  DELETE FROM public.well_readings
   WHERE plant_id = ANY(doomed_ids);
  GET DIAGNOSTICS cnt = ROW_COUNT;  RAISE NOTICE '  well_readings:              -%', cnt;

  DELETE FROM public.locator_meter_replacements
   WHERE plant_id = ANY(doomed_ids);
  GET DIAGNOSTICS cnt = ROW_COUNT;  RAISE NOTICE '  locator_meter_replacements: -%', cnt;

  DELETE FROM public.locator_readings
   WHERE plant_id = ANY(doomed_ids);
  GET DIAGNOSTICS cnt = ROW_COUNT;  RAISE NOTICE '  locator_readings:           -%', cnt;

  -- ro_train_readings.plant_id is also NO ACTION
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='ro_train_readings') THEN
    DELETE FROM public.ro_train_readings
     WHERE plant_id = ANY(doomed_ids);
    GET DIAGNOSTICS cnt = ROW_COUNT;  RAISE NOTICE '  ro_train_readings:          -%', cnt;
  END IF;

  -- ro_train_replacements.plant_id may or may not cascade — clear to be safe.
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='ro_train_replacements') THEN
    DELETE FROM public.ro_train_replacements
     WHERE plant_id = ANY(doomed_ids);
    GET DIAGNOSTICS cnt = ROW_COUNT;  RAISE NOTICE '  ro_train_replacements:      -%', cnt;
  END IF;

  -- Incidents.plant_id is NOT NULL with no cascade — must clear first.
  DELETE FROM public.incidents
   WHERE plant_id = ANY(doomed_ids);
  GET DIAGNOSTICS cnt = ROW_COUNT;  RAISE NOTICE '  incidents:                  -%', cnt;

  -- checklist_executions.plant_id has no cascade either.
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='checklist_executions') THEN
    DELETE FROM public.checklist_executions
     WHERE plant_id = ANY(doomed_ids);
    GET DIAGNOSTICS cnt = ROW_COUNT;  RAISE NOTICE '  checklist_executions:       -%', cnt;
  END IF;

  -- 4. Detach plants from any user_profiles.plant_assignments arrays.
  UPDATE public.user_profiles
     SET plant_assignments = (
       SELECT COALESCE(array_agg(p), '{}')::uuid[]
       FROM unnest(plant_assignments) AS p
       WHERE p <> ALL(doomed_ids)
     )
  WHERE plant_assignments && doomed_ids;
  GET DIAGNOSTICS cnt = ROW_COUNT;  RAISE NOTICE '  user_profiles plant_assignments updated: %', cnt;

  -- 5. Finally, drop the plants. Cascade rules clear every remaining
  --    table (locators, wells, ro_trains, chemical_*, power_*,
  --    production_costs, daily_plant_summary, checklist_templates,
  --    electric_bills).
  DELETE FROM public.plants WHERE id = ANY(doomed_ids);
  GET DIAGNOSTICS cnt = ROW_COUNT;  RAISE NOTICE '  plants:                     -% (DONE)', cnt;
END
$$;
