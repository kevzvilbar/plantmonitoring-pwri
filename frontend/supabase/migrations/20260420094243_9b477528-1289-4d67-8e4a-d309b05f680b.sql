-- ============ chemical_deliveries ============
CREATE TABLE public.chemical_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id uuid NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  chemical_name text NOT NULL,
  quantity numeric NOT NULL CHECK (quantity > 0),
  unit text NOT NULL DEFAULT 'kg',
  unit_cost numeric,
  supplier text,
  delivery_date date NOT NULL DEFAULT CURRENT_DATE,
  remarks text,
  recorded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.chemical_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY chem_deliveries_read ON public.chemical_deliveries FOR SELECT TO authenticated USING (user_has_plant_access(plant_id));
CREATE POLICY chem_deliveries_write ON public.chemical_deliveries FOR ALL TO authenticated
  USING (is_manager_or_admin(auth.uid()) AND user_has_plant_access(plant_id))
  WITH CHECK (is_manager_or_admin(auth.uid()) AND user_has_plant_access(plant_id));
CREATE INDEX idx_chem_deliveries_plant_chem ON public.chemical_deliveries(plant_id, chemical_name, delivery_date DESC);

-- ============ ro_pretreatment_readings ============
CREATE TABLE public.ro_pretreatment_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id uuid NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  train_id uuid NOT NULL REFERENCES public.ro_trains(id) ON DELETE CASCADE,
  reading_datetime timestamptz NOT NULL DEFAULT now(),
  backwash_start timestamptz,
  backwash_end timestamptz,
  mmf_readings jsonb DEFAULT '[]'::jsonb,            -- [{unit:1, reading:123.4}, ...]
  booster_pumps jsonb DEFAULT '[]'::jsonb,           -- [{unit:1, target_pressure_psi:..., amperage:...}]
  afm_units jsonb DEFAULT '[]'::jsonb,               -- [{unit:1, inlet_psi:..., outlet_psi:...}]
  hpp_target_pressure_psi numeric,
  filter_housings jsonb DEFAULT '[]'::jsonb,         -- [{unit:1, in_psi:..., out_psi:...}]
  bag_filters_changed integer DEFAULT 0,
  remarks text,
  recorded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ro_pretreatment_readings ENABLE ROW LEVEL SECURITY;
CREATE POLICY ro_pretreatment_access ON public.ro_pretreatment_readings FOR ALL TO authenticated
  USING (user_has_plant_access(plant_id)) WITH CHECK (user_has_plant_access(plant_id));
CREATE INDEX idx_pretreatment_train_dt ON public.ro_pretreatment_readings(train_id, reading_datetime DESC);

-- ============ chemical_residual_samples ============
CREATE TABLE public.chemical_residual_samples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dosing_log_id uuid NOT NULL REFERENCES public.chemical_dosing_logs(id) ON DELETE CASCADE,
  plant_id uuid NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  sample_index integer NOT NULL,
  sampling_point text,
  residual_ppm numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.chemical_residual_samples ENABLE ROW LEVEL SECURITY;
CREATE POLICY residual_samples_access ON public.chemical_residual_samples FOR ALL TO authenticated
  USING (user_has_plant_access(plant_id)) WITH CHECK (user_has_plant_access(plant_id));
CREATE INDEX idx_residual_dosing ON public.chemical_residual_samples(dosing_log_id);

-- ============ chemical_inventory: standardize unit ============
ALTER TABLE public.chemical_inventory ADD COLUMN IF NOT EXISTS unit_type text;
UPDATE public.chemical_inventory SET unit_type = COALESCE(unit, 'kg') WHERE unit_type IS NULL;