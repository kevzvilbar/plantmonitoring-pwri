-- 1) Plants: add backwash mode flag
ALTER TABLE public.plants
  ADD COLUMN IF NOT EXISTS backwash_mode text NOT NULL DEFAULT 'independent'
    CHECK (backwash_mode IN ('independent','synchronized'));

-- 2) Daily plant summary table (per plant per day)
CREATE TABLE IF NOT EXISTS public.daily_plant_summary (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id uuid NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  summary_date date NOT NULL,
  production_m3 numeric,
  locator_consumption_m3 numeric,
  blending_m3 numeric,
  raw_water_consumption_m3 numeric,
  power_kwh numeric,
  pv_ratio numeric,
  feed_tds numeric,
  permeate_tds numeric,
  reject_tds numeric,
  product_tds numeric,
  raw_turbidity_ntu numeric,
  recovery_pct numeric,
  rejection_pct numeric,
  downtime_hrs numeric,
  feed_pressure_psi numeric,
  reject_pressure_psi numeric,
  notes text,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plant_id, summary_date)
);

CREATE INDEX IF NOT EXISTS idx_dps_plant_date ON public.daily_plant_summary(plant_id, summary_date DESC);

ALTER TABLE public.daily_plant_summary ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dps_access ON public.daily_plant_summary;
CREATE POLICY dps_access ON public.daily_plant_summary
  FOR ALL TO authenticated
  USING (public.user_has_plant_access(plant_id))
  WITH CHECK (public.user_has_plant_access(plant_id));

DROP TRIGGER IF EXISTS trg_dps_updated ON public.daily_plant_summary;
CREATE TRIGGER trg_dps_updated
  BEFORE UPDATE ON public.daily_plant_summary
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3) Remove previously seeded RO trains (user asked to omit prior seed)
-- Only delete trains that have no readings yet to avoid breaking real data
DELETE FROM public.ro_trains t
WHERE NOT EXISTS (SELECT 1 FROM public.ro_train_readings r WHERE r.train_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM public.ro_pretreatment_readings p WHERE p.train_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM public.afm_readings a WHERE a.train_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM public.cartridge_readings c WHERE c.train_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM public.cip_logs cl WHERE cl.train_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM public.pump_readings pr WHERE pr.train_id = t.id);