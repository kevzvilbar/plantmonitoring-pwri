-- power_tariffs
CREATE TABLE public.power_tariffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id uuid NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  effective_date date NOT NULL,
  rate_per_kwh numeric NOT NULL,
  multiplier numeric NOT NULL DEFAULT 1,
  provider text,
  remarks text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_power_tariffs_plant_date ON public.power_tariffs(plant_id, effective_date DESC);
ALTER TABLE public.power_tariffs ENABLE ROW LEVEL SECURITY;
CREATE POLICY power_tariffs_read ON public.power_tariffs FOR SELECT TO authenticated USING (true);
CREATE POLICY power_tariffs_write ON public.power_tariffs FOR ALL TO authenticated
  USING (public.is_manager_or_admin(auth.uid())) WITH CHECK (public.is_manager_or_admin(auth.uid()));

-- electric_bills
CREATE TABLE public.electric_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id uuid NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  billing_month date NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  previous_reading numeric NOT NULL,
  current_reading numeric NOT NULL,
  multiplier numeric NOT NULL DEFAULT 1,
  total_kwh numeric GENERATED ALWAYS AS ((current_reading - previous_reading) * multiplier) STORED,
  total_amount numeric NOT NULL,
  generation_charge numeric,
  distribution_charge numeric,
  other_charges numeric,
  remarks text,
  recorded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_electric_bills_plant_month ON public.electric_bills(plant_id, billing_month DESC);
ALTER TABLE public.electric_bills ENABLE ROW LEVEL SECURITY;
CREATE POLICY electric_bills_access ON public.electric_bills FOR ALL TO authenticated
  USING (public.user_has_plant_access(plant_id)) WITH CHECK (public.user_has_plant_access(plant_id));
CREATE TRIGGER trg_electric_bills_updated BEFORE UPDATE ON public.electric_bills
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- production_costs
CREATE TABLE public.production_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id uuid NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  cost_date date NOT NULL,
  chem_cost numeric NOT NULL DEFAULT 0,
  power_cost numeric NOT NULL DEFAULT 0,
  production_m3 numeric NOT NULL DEFAULT 0,
  total_cost numeric GENERATED ALWAYS AS (chem_cost + power_cost) STORED,
  cost_per_m3 numeric,
  driver_notes text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(plant_id, cost_date)
);
CREATE INDEX idx_production_costs_plant_date ON public.production_costs(plant_id, cost_date DESC);
ALTER TABLE public.production_costs ENABLE ROW LEVEL SECURITY;
CREATE POLICY production_costs_access ON public.production_costs FOR ALL TO authenticated
  USING (public.user_has_plant_access(plant_id)) WITH CHECK (public.user_has_plant_access(plant_id));
CREATE TRIGGER trg_production_costs_updated BEFORE UPDATE ON public.production_costs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- train_status_log
CREATE TABLE public.train_status_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  train_id uuid NOT NULL REFERENCES public.ro_trains(id) ON DELETE CASCADE,
  plant_id uuid NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  status text NOT NULL,
  reason text,
  confirmed_by uuid,
  confirmed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_train_status_log_train ON public.train_status_log(train_id, confirmed_at DESC);
ALTER TABLE public.train_status_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY train_status_log_access ON public.train_status_log FOR ALL TO authenticated
  USING (public.user_has_plant_access(plant_id)) WITH CHECK (public.user_has_plant_access(plant_id));

-- Add price_per_unit to chemical_inventory
ALTER TABLE public.chemical_inventory ADD COLUMN IF NOT EXISTS price_per_unit numeric;

-- Helper: upsert daily production_cost rollup
CREATE OR REPLACE FUNCTION public.recompute_production_cost(_plant_id uuid, _date date)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_chem numeric := 0;
  v_kwh numeric := 0;
  v_prod numeric := 0;
  v_rate numeric := 0;
  v_mult numeric := 1;
  v_power_cost numeric := 0;
BEGIN
  SELECT COALESCE(SUM(calculated_cost),0) INTO v_chem
  FROM public.chemical_dosing_logs
  WHERE plant_id = _plant_id AND log_datetime::date = _date;

  SELECT COALESCE(SUM(daily_consumption_kwh),0) INTO v_kwh
  FROM public.power_readings
  WHERE plant_id = _plant_id AND reading_datetime::date = _date;

  SELECT COALESCE(SUM(daily_volume),0) INTO v_prod
  FROM public.well_readings
  WHERE plant_id = _plant_id AND reading_datetime::date = _date;

  SELECT rate_per_kwh, multiplier INTO v_rate, v_mult
  FROM public.power_tariffs
  WHERE plant_id = _plant_id AND effective_date <= _date
  ORDER BY effective_date DESC LIMIT 1;

  v_power_cost := v_kwh * COALESCE(v_rate,0) * COALESCE(v_mult,1);

  INSERT INTO public.production_costs(plant_id, cost_date, chem_cost, power_cost, production_m3, cost_per_m3)
  VALUES (_plant_id, _date, v_chem, v_power_cost, v_prod,
          CASE WHEN v_prod > 0 THEN (v_chem + v_power_cost) / v_prod ELSE NULL END)
  ON CONFLICT (plant_id, cost_date) DO UPDATE
  SET chem_cost = EXCLUDED.chem_cost,
      power_cost = EXCLUDED.power_cost,
      production_m3 = EXCLUDED.production_m3,
      cost_per_m3 = EXCLUDED.cost_per_m3,
      updated_at = now();
END;
$$;

-- Trigger fn to recompute on changes
CREATE OR REPLACE FUNCTION public.trg_recompute_cost()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plant uuid;
  v_date date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_plant := OLD.plant_id;
    v_date := COALESCE(OLD.log_datetime, OLD.reading_datetime)::date;
  ELSE
    v_plant := NEW.plant_id;
    v_date := COALESCE(NEW.log_datetime, NEW.reading_datetime)::date;
  END IF;
  PERFORM public.recompute_production_cost(v_plant, v_date);
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_chem_cost AFTER INSERT OR UPDATE OR DELETE ON public.chemical_dosing_logs
  FOR EACH ROW EXECUTE FUNCTION public.trg_recompute_cost();
CREATE TRIGGER trg_power_cost AFTER INSERT OR UPDATE OR DELETE ON public.power_readings
  FOR EACH ROW EXECUTE FUNCTION public.trg_recompute_cost();
CREATE TRIGGER trg_well_cost AFTER INSERT OR UPDATE OR DELETE ON public.well_readings
  FOR EACH ROW EXECUTE FUNCTION public.trg_recompute_cost();