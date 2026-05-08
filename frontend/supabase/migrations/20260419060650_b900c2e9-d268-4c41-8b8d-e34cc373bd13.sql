
-- =========================================================
-- ENUMS
-- =========================================================
CREATE TYPE public.app_role AS ENUM ('Operator','Technician','Manager','Admin');
CREATE TYPE public.profile_status AS ENUM ('Pending','Active','Suspended');
CREATE TYPE public.plant_status AS ENUM ('Active','Inactive');
CREATE TYPE public.train_status AS ENUM ('Running','Offline','Maintenance');
CREATE TYPE public.severity_level AS ENUM ('Low','Medium','High','Critical');
CREATE TYPE public.incident_status AS ENUM ('Open','InProgress','Resolved','Closed');
CREATE TYPE public.frequency_type AS ENUM ('Daily','Weekly','Monthly','Quarterly','Yearly');

-- =========================================================
-- HELPER: updated_at trigger
-- =========================================================
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

-- =========================================================
-- PLANTS
-- =========================================================
CREATE TABLE public.plants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  status public.plant_status NOT NULL DEFAULT 'Active',
  design_capacity_m3 NUMERIC,
  num_ro_trains INTEGER NOT NULL DEFAULT 0,
  address TEXT,
  gps_lat NUMERIC,
  gps_lng NUMERIC,
  geofence_radius_m INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_plants_updated BEFORE UPDATE ON public.plants
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =========================================================
-- USER PROFILES (no role column!)
-- =========================================================
CREATE TABLE public.user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT UNIQUE,
  first_name TEXT,
  middle_name TEXT,
  last_name TEXT,
  suffix TEXT,
  designation TEXT,
  immediate_head_id UUID REFERENCES public.user_profiles(id),
  plant_assignments UUID[] NOT NULL DEFAULT '{}',
  status public.profile_status NOT NULL DEFAULT 'Pending',
  profile_complete BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_user_profiles_updated BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =========================================================
-- USER ROLES (separate for security)
-- =========================================================
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, role)
);

-- =========================================================
-- SECURITY DEFINER HELPERS
-- =========================================================
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role);
$$;

CREATE OR REPLACE FUNCTION public.is_admin(_user_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = 'Admin');
$$;

CREATE OR REPLACE FUNCTION public.is_manager_or_admin(_user_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role IN ('Admin','Manager'));
$$;

CREATE OR REPLACE FUNCTION public.user_has_plant_access(_plant_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.is_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid() AND _plant_id = ANY(plant_assignments)
    );
$$;

-- =========================================================
-- LOCATORS
-- =========================================================
CREATE TABLE public.locators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id UUID NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  location_desc TEXT,
  address TEXT,
  gps_lat NUMERIC,
  gps_lng NUMERIC,
  meter_brand TEXT,
  meter_size TEXT,
  meter_serial TEXT,
  meter_installed_date DATE,
  status public.plant_status NOT NULL DEFAULT 'Active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_locators_plant ON public.locators(plant_id);
CREATE TRIGGER trg_locators_updated BEFORE UPDATE ON public.locators
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.locator_meter_replacements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  locator_id UUID NOT NULL REFERENCES public.locators(id) ON DELETE CASCADE,
  plant_id UUID NOT NULL REFERENCES public.plants(id),
  replacement_date DATE NOT NULL,
  old_meter_brand TEXT, old_meter_size TEXT, old_meter_serial TEXT,
  old_meter_final_reading NUMERIC,
  new_meter_brand TEXT, new_meter_size TEXT, new_meter_serial TEXT,
  new_meter_initial_reading NUMERIC,
  new_meter_installed_date DATE,
  replaced_by UUID REFERENCES public.user_profiles(id),
  remarks TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_lmr_locator ON public.locator_meter_replacements(locator_id);

CREATE TABLE public.locator_readings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  locator_id UUID NOT NULL REFERENCES public.locators(id) ON DELETE CASCADE,
  plant_id UUID NOT NULL REFERENCES public.plants(id),
  reading_datetime TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_reading NUMERIC NOT NULL,
  previous_reading NUMERIC,
  daily_volume NUMERIC GENERATED ALWAYS AS (current_reading - COALESCE(previous_reading,0)) STORED,
  gps_lat NUMERIC, gps_lng NUMERIC,
  off_location_flag BOOLEAN NOT NULL DEFAULT FALSE,
  recorded_by UUID REFERENCES public.user_profiles(id),
  remarks TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_lr_plant_dt ON public.locator_readings(plant_id, reading_datetime DESC);
CREATE INDEX idx_lr_locator_dt ON public.locator_readings(locator_id, reading_datetime DESC);

-- =========================================================
-- WELLS
-- =========================================================
CREATE TABLE public.wells (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id UUID NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  size TEXT,
  status public.plant_status NOT NULL DEFAULT 'Active',
  diameter TEXT,
  drilling_depth_m NUMERIC,
  has_power_meter BOOLEAN NOT NULL DEFAULT FALSE,
  meter_brand TEXT, meter_size TEXT, meter_serial TEXT,
  meter_installed_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_wells_plant ON public.wells(plant_id);
CREATE TRIGGER trg_wells_updated BEFORE UPDATE ON public.wells
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.well_pms_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  well_id UUID NOT NULL REFERENCES public.wells(id) ON DELETE CASCADE,
  plant_id UUID NOT NULL REFERENCES public.plants(id),
  record_type TEXT NOT NULL DEFAULT 'PMS' CHECK (record_type IN ('PMS','Pump Replacement','Monthly PWL')),
  date_gathered DATE NOT NULL,
  static_water_level_m NUMERIC,
  pumping_water_level_m NUMERIC,
  pump_setting TEXT,
  pump_installed TEXT,
  motor_hp NUMERIC,
  tds_ppm NUMERIC,
  turbidity_ntu NUMERIC,
  recorded_by UUID REFERENCES public.user_profiles(id),
  remarks TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_wpms_well ON public.well_pms_records(well_id);

CREATE TABLE public.well_meter_replacements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  well_id UUID NOT NULL REFERENCES public.wells(id) ON DELETE CASCADE,
  plant_id UUID NOT NULL REFERENCES public.plants(id),
  replacement_date DATE NOT NULL,
  old_serial TEXT, old_final_reading NUMERIC,
  new_brand TEXT, new_size TEXT, new_serial TEXT,
  new_initial_reading NUMERIC, new_installed_date DATE,
  replaced_by UUID REFERENCES public.user_profiles(id),
  remarks TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.well_readings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  well_id UUID NOT NULL REFERENCES public.wells(id) ON DELETE CASCADE,
  plant_id UUID NOT NULL REFERENCES public.plants(id),
  reading_datetime TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_reading NUMERIC,
  previous_reading NUMERIC,
  daily_volume NUMERIC,
  power_meter_reading NUMERIC,
  gps_lat NUMERIC, gps_lng NUMERIC,
  off_location_flag BOOLEAN NOT NULL DEFAULT FALSE,
  recorded_by UUID REFERENCES public.user_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_wr_plant_dt ON public.well_readings(plant_id, reading_datetime DESC);

-- =========================================================
-- RO TRAINS
-- =========================================================
CREATE TABLE public.ro_trains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id UUID NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  train_number INTEGER NOT NULL,
  name TEXT,
  status public.train_status NOT NULL DEFAULT 'Running',
  num_afm INTEGER NOT NULL DEFAULT 0,
  num_booster_pumps INTEGER NOT NULL DEFAULT 0,
  num_hp_pumps INTEGER NOT NULL DEFAULT 0,
  num_cartridge_filters INTEGER NOT NULL DEFAULT 0,
  num_filter_housings INTEGER NOT NULL DEFAULT 0,
  num_controllers INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(plant_id, train_number)
);
CREATE TRIGGER trg_ro_trains_updated BEFORE UPDATE ON public.ro_trains
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.ro_train_readings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  train_id UUID NOT NULL REFERENCES public.ro_trains(id) ON DELETE CASCADE,
  plant_id UUID NOT NULL REFERENCES public.plants(id),
  reading_datetime TIMESTAMPTZ NOT NULL DEFAULT now(),
  feed_meter NUMERIC, permeate_meter NUMERIC, reject_meter NUMERIC,
  feed_flow NUMERIC, permeate_flow NUMERIC, reject_flow NUMERIC,
  suction_pressure_psi NUMERIC,
  feed_pressure_psi NUMERIC,
  reject_pressure_psi NUMERIC,
  dp_psi NUMERIC,
  recovery_pct NUMERIC,
  rejection_pct NUMERIC,
  salt_passage_pct NUMERIC,
  feed_tds NUMERIC, permeate_tds NUMERIC, reject_tds NUMERIC,
  feed_ph NUMERIC, permeate_ph NUMERIC, reject_ph NUMERIC,
  turbidity_ntu NUMERIC, temperature_c NUMERIC,
  recorded_by UUID REFERENCES public.user_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_rtr_train_dt ON public.ro_train_readings(train_id, reading_datetime DESC);
CREATE INDEX idx_rtr_plant_dt ON public.ro_train_readings(plant_id, reading_datetime DESC);

CREATE TABLE public.afm_readings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  train_id UUID NOT NULL REFERENCES public.ro_trains(id) ON DELETE CASCADE,
  plant_id UUID NOT NULL REFERENCES public.plants(id),
  afm_unit_number INTEGER NOT NULL,
  reading_datetime TIMESTAMPTZ NOT NULL DEFAULT now(),
  mode TEXT NOT NULL DEFAULT 'Running' CHECK (mode IN ('Running','Backwash')),
  inlet_pressure_psi NUMERIC, outlet_pressure_psi NUMERIC,
  dp_psi NUMERIC,
  backwash_start TIMESTAMPTZ, backwash_end TIMESTAMPTZ,
  meter_initial NUMERIC, meter_final NUMERIC,
  backwash_volume NUMERIC,
  recorded_by UUID REFERENCES public.user_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.pump_readings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  train_id UUID NOT NULL REFERENCES public.ro_trains(id) ON DELETE CASCADE,
  plant_id UUID NOT NULL REFERENCES public.plants(id),
  pump_type TEXT NOT NULL CHECK (pump_type IN ('Booster','HighPressure')),
  pump_number INTEGER NOT NULL,
  reading_datetime TIMESTAMPTZ NOT NULL DEFAULT now(),
  target_pressure_psi NUMERIC,
  l1_amp NUMERIC, l2_amp NUMERIC, l3_amp NUMERIC,
  voltage NUMERIC,
  recorded_by UUID REFERENCES public.user_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.cartridge_readings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  train_id UUID NOT NULL REFERENCES public.ro_trains(id) ON DELETE CASCADE,
  plant_id UUID NOT NULL REFERENCES public.plants(id),
  cartridge_number INTEGER NOT NULL,
  reading_datetime TIMESTAMPTZ NOT NULL DEFAULT now(),
  inlet_pressure_psi NUMERIC, outlet_pressure_psi NUMERIC,
  dp_psi NUMERIC,
  bag_replaced BOOLEAN NOT NULL DEFAULT FALSE,
  pieces_replaced INTEGER,
  recorded_by UUID REFERENCES public.user_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.cip_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  train_id UUID NOT NULL REFERENCES public.ro_trains(id) ON DELETE CASCADE,
  plant_id UUID NOT NULL REFERENCES public.plants(id),
  start_datetime TIMESTAMPTZ,
  end_datetime TIMESTAMPTZ,
  sls_g NUMERIC,
  hcl_l NUMERIC,
  caustic_soda_kg NUMERIC,
  conducted_by UUID REFERENCES public.user_profiles(id),
  remarks TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================================================
-- CHEMICALS
-- =========================================================
CREATE TABLE public.chemical_inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id UUID NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  chemical_name TEXT NOT NULL,
  unit TEXT,
  current_stock NUMERIC NOT NULL DEFAULT 0,
  low_stock_threshold NUMERIC NOT NULL DEFAULT 10,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(plant_id, chemical_name)
);
CREATE TRIGGER trg_chem_inv_updated BEFORE UPDATE ON public.chemical_inventory
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.chemical_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chemical_name TEXT NOT NULL,
  unit_price NUMERIC NOT NULL,
  effective_date DATE NOT NULL,
  updated_by UUID REFERENCES public.user_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_cp_chem_date ON public.chemical_prices(chemical_name, effective_date DESC);

CREATE TABLE public.chemical_dosing_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id UUID NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  log_datetime TIMESTAMPTZ NOT NULL DEFAULT now(),
  chlorine_kg NUMERIC NOT NULL DEFAULT 0,
  smbs_kg NUMERIC NOT NULL DEFAULT 0,
  anti_scalant_l NUMERIC NOT NULL DEFAULT 0,
  soda_ash_kg NUMERIC NOT NULL DEFAULT 0,
  free_chlorine_reagent_pcs INTEGER NOT NULL DEFAULT 0,
  product_water_free_cl_ppm NUMERIC,
  calculated_cost NUMERIC,
  recorded_by UUID REFERENCES public.user_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_cdl_plant_dt ON public.chemical_dosing_logs(plant_id, log_datetime DESC);

CREATE TABLE public.power_readings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id UUID NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  reading_datetime TIMESTAMPTZ NOT NULL DEFAULT now(),
  meter_reading_kwh NUMERIC NOT NULL,
  daily_consumption_kwh NUMERIC,
  recorded_by UUID REFERENCES public.user_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pr_plant_dt ON public.power_readings(plant_id, reading_datetime DESC);

-- =========================================================
-- MAINTENANCE
-- =========================================================
CREATE TABLE public.checklist_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id UUID REFERENCES public.plants(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  equipment_name TEXT NOT NULL,
  frequency public.frequency_type NOT NULL,
  checklist_steps TEXT[],
  schedule_start_date DATE,
  created_by UUID REFERENCES public.user_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.checklist_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES public.checklist_templates(id) ON DELETE CASCADE,
  plant_id UUID REFERENCES public.plants(id),
  execution_date DATE NOT NULL DEFAULT CURRENT_DATE,
  frequency public.frequency_type,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  completed_by UUID REFERENCES public.user_profiles(id),
  completed_at TIMESTAMPTZ,
  findings TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ce_template ON public.checklist_executions(template_id);

-- =========================================================
-- INCIDENTS
-- =========================================================
CREATE TABLE public.incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id UUID NOT NULL REFERENCES public.plants(id),
  incident_ref TEXT UNIQUE,
  incident_type TEXT,
  severity public.severity_level,
  status public.incident_status NOT NULL DEFAULT 'Open',
  what_description TEXT,
  where_location TEXT,
  gps_lat NUMERIC, gps_lng NUMERIC,
  when_datetime TIMESTAMPTZ,
  who_reporter UUID REFERENCES public.user_profiles(id),
  witness TEXT,
  weather TEXT,
  temperature_c NUMERIC,
  immediate_action TEXT,
  photo_url TEXT,
  root_cause TEXT,
  corrective_action TEXT,
  preventive_measures TEXT,
  resolved_by UUID REFERENCES public.user_profiles(id),
  resolved_at TIMESTAMPTZ,
  closed_by UUID REFERENCES public.user_profiles(id),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_incidents_updated BEFORE UPDATE ON public.incidents
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Auto-generate incident_ref like INC-2026-001
CREATE OR REPLACE FUNCTION public.generate_incident_ref()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  yr TEXT := to_char(now(), 'YYYY');
  cnt INTEGER;
BEGIN
  IF NEW.incident_ref IS NULL THEN
    SELECT COUNT(*)+1 INTO cnt FROM public.incidents WHERE incident_ref LIKE 'INC-'||yr||'-%';
    NEW.incident_ref := 'INC-'||yr||'-'||lpad(cnt::text, 3, '0');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_incident_ref BEFORE INSERT ON public.incidents
  FOR EACH ROW EXECUTE FUNCTION public.generate_incident_ref();

-- =========================================================
-- NOTIFICATIONS
-- =========================================================
CREATE TABLE public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plant_id UUID REFERENCES public.plants(id),
  alert_type TEXT NOT NULL,
  severity public.severity_level NOT NULL DEFAULT 'Medium',
  title TEXT NOT NULL,
  message TEXT,
  link_path TEXT,
  read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notif_user_read ON public.notifications(user_id, read, created_at DESC);

-- =========================================================
-- PROFILE AUTO-CREATE on auth signup
-- =========================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.user_profiles (id, status, profile_complete)
  VALUES (NEW.id, 'Pending', FALSE)
  ON CONFLICT (id) DO NOTHING;
  -- default role: Operator (Pending status keeps them locked out of writes)
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'Operator')
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- =========================================================
-- ENABLE RLS ON ALL TABLES
-- =========================================================
ALTER TABLE public.plants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.locators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.locator_meter_replacements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.locator_readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wells ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.well_pms_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.well_meter_replacements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.well_readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ro_trains ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ro_train_readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.afm_readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pump_readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cartridge_readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cip_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chemical_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chemical_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chemical_dosing_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.power_readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checklist_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checklist_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- =========================================================
-- RLS POLICIES
-- =========================================================

-- PLANTS: any authenticated user can read; only admin/manager can write
CREATE POLICY "plants_select_authenticated" ON public.plants
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "plants_write_admin_manager" ON public.plants
  FOR ALL TO authenticated
  USING (public.is_manager_or_admin(auth.uid()))
  WITH CHECK (public.is_manager_or_admin(auth.uid()));

-- USER_PROFILES: read all (for dropdowns); user updates own; admin updates anyone
CREATE POLICY "profiles_select_authenticated" ON public.user_profiles
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "profiles_insert_self" ON public.user_profiles
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);
CREATE POLICY "profiles_update_self" ON public.user_profiles
  FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
CREATE POLICY "profiles_admin_all" ON public.user_profiles
  FOR ALL TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

-- USER_ROLES: only admins manage; users can see their own
CREATE POLICY "roles_select_self" ON public.user_roles
  FOR SELECT TO authenticated USING (auth.uid() = user_id OR public.is_admin(auth.uid()));
CREATE POLICY "roles_admin_all" ON public.user_roles
  FOR ALL TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

-- LOCATORS / WELLS / RO_TRAINS: read by plant access; write by manager/admin with plant access
CREATE POLICY "locators_read" ON public.locators
  FOR SELECT TO authenticated USING (public.user_has_plant_access(plant_id));
CREATE POLICY "locators_write" ON public.locators
  FOR ALL TO authenticated
  USING (public.is_manager_or_admin(auth.uid()) AND public.user_has_plant_access(plant_id))
  WITH CHECK (public.is_manager_or_admin(auth.uid()) AND public.user_has_plant_access(plant_id));

CREATE POLICY "wells_read" ON public.wells
  FOR SELECT TO authenticated USING (public.user_has_plant_access(plant_id));
CREATE POLICY "wells_write" ON public.wells
  FOR ALL TO authenticated
  USING (public.is_manager_or_admin(auth.uid()) AND public.user_has_plant_access(plant_id))
  WITH CHECK (public.is_manager_or_admin(auth.uid()) AND public.user_has_plant_access(plant_id));

CREATE POLICY "ro_trains_read" ON public.ro_trains
  FOR SELECT TO authenticated USING (public.user_has_plant_access(plant_id));
CREATE POLICY "ro_trains_write" ON public.ro_trains
  FOR ALL TO authenticated
  USING (public.is_manager_or_admin(auth.uid()) AND public.user_has_plant_access(plant_id))
  WITH CHECK (public.is_manager_or_admin(auth.uid()) AND public.user_has_plant_access(plant_id));

-- READINGS / OPERATIONAL DATA: full access for assigned plant users (operators write data)
DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'locator_meter_replacements','locator_readings',
    'well_pms_records','well_meter_replacements','well_readings',
    'ro_train_readings','afm_readings','pump_readings','cartridge_readings','cip_logs',
    'chemical_inventory','chemical_dosing_logs','power_readings',
    'checklist_executions','incidents'
  ])
  LOOP
    EXECUTE format('CREATE POLICY "%s_plant_access" ON public.%I FOR ALL TO authenticated USING (public.user_has_plant_access(plant_id)) WITH CHECK (public.user_has_plant_access(plant_id));', t, t);
  END LOOP;
END $$;

-- CHEMICAL PRICES: any auth read; manager/admin write
CREATE POLICY "chem_prices_read" ON public.chemical_prices
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "chem_prices_write" ON public.chemical_prices
  FOR ALL TO authenticated
  USING (public.is_manager_or_admin(auth.uid()))
  WITH CHECK (public.is_manager_or_admin(auth.uid()));

-- CHECKLIST TEMPLATES: any auth read; manager/admin write
CREATE POLICY "checklist_templates_read" ON public.checklist_templates
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "checklist_templates_write" ON public.checklist_templates
  FOR ALL TO authenticated
  USING (public.is_manager_or_admin(auth.uid()))
  WITH CHECK (public.is_manager_or_admin(auth.uid()));

-- NOTIFICATIONS: own only
CREATE POLICY "notifications_own_select" ON public.notifications
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "notifications_own_update" ON public.notifications
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "notifications_insert_authenticated" ON public.notifications
  FOR INSERT TO authenticated WITH CHECK (true);

-- =========================================================
-- SEED PLANTS
-- =========================================================
INSERT INTO public.plants (name, status, design_capacity_m3, num_ro_trains, address, gps_lat, gps_lng) VALUES
  ('Mambaling','Active', 5000, 10, 'Brgy. Mambaling, Cebu City', 10.2931, 123.8766),
  ('SRP','Active', 4200, 7, 'South Road Properties, Cebu City', 10.2711, 123.8724),
  ('Guizo','Active', 1800, 2, 'Guizo, Mandaue City', 10.3311, 123.9222),
  ('Umapad','Active', 6000, 11, 'Umapad, Mandaue City', 10.3488, 123.9388);
