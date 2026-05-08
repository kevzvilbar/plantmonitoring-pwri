-- =============================================================
-- PWRI Plant Monitoring — Render PostgreSQL Schema
-- Replaces Supabase: own users table, no RLS, no auth.uid()
-- Run once on a fresh Render PostgreSQL database.
-- =============================================================

-- ── Extensions ───────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Enums ────────────────────────────────────────────────────
CREATE TYPE public.app_role       AS ENUM ('Operator','Technician','Manager','Admin');
CREATE TYPE public.profile_status AS ENUM ('Pending','Active','Suspended');
CREATE TYPE public.plant_status   AS ENUM ('Active','Inactive');
CREATE TYPE public.train_status   AS ENUM ('Running','Offline','Maintenance');
CREATE TYPE public.severity_level AS ENUM ('Low','Medium','High','Critical');
CREATE TYPE public.incident_status AS ENUM ('Open','InProgress','Resolved','Closed');
CREATE TYPE public.frequency_type  AS ENUM ('Daily','Weekly','Monthly','Quarterly','Yearly');

-- ── updated_at helper trigger ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

-- =============================================================
-- AUTH: replaces Supabase auth.users
-- =============================================================
CREATE TABLE public.users (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT        NOT NULL UNIQUE,
  password_hash TEXT       NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Refresh tokens (server-side logout support)
CREATE TABLE public.refresh_tokens (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token_hash TEXT        NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_refresh_tokens_user ON public.refresh_tokens(user_id);

-- =============================================================
-- PLANTS
-- =============================================================
CREATE TABLE public.plants (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT        NOT NULL UNIQUE,
  status             public.plant_status NOT NULL DEFAULT 'Active',
  design_capacity_m3 NUMERIC,
  num_ro_trains      INTEGER     NOT NULL DEFAULT 0,
  address            TEXT,
  gps_lat            NUMERIC,
  gps_lng            NUMERIC,
  geofence_radius_m  INTEGER     NOT NULL DEFAULT 100,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_plants_updated BEFORE UPDATE ON public.plants
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================
-- USER PROFILES  (references our users table, not auth.users)
-- =============================================================
CREATE TABLE public.user_profiles (
  id                UUID        PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  username          TEXT        UNIQUE,
  first_name        TEXT,
  middle_name       TEXT,
  last_name         TEXT,
  suffix            TEXT,
  designation       TEXT,
  immediate_head_id UUID        REFERENCES public.user_profiles(id),
  plant_assignments UUID[]      NOT NULL DEFAULT '{}',
  status            public.profile_status NOT NULL DEFAULT 'Pending',
  profile_complete  BOOLEAN     NOT NULL DEFAULT FALSE,
  confirmed         BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_user_profiles_updated BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================
-- USER ROLES
-- =============================================================
CREATE TABLE public.user_roles (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role       public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, role)
);

-- =============================================================
-- LOCATORS
-- =============================================================
CREATE TABLE public.locators (
  id                   UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id             UUID  NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  name                 TEXT  NOT NULL,
  location_desc        TEXT,
  address              TEXT,
  gps_lat              NUMERIC, gps_lng NUMERIC,
  meter_brand          TEXT, meter_size TEXT, meter_serial TEXT,
  meter_installed_date DATE,
  status               public.plant_status NOT NULL DEFAULT 'Active',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_locators_plant ON public.locators(plant_id);
CREATE TRIGGER trg_locators_updated BEFORE UPDATE ON public.locators
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.locator_meter_replacements (
  id                       UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  locator_id               UUID  NOT NULL REFERENCES public.locators(id) ON DELETE CASCADE,
  plant_id                 UUID  NOT NULL REFERENCES public.plants(id),
  replacement_date         DATE  NOT NULL,
  old_meter_brand          TEXT, old_meter_size TEXT, old_meter_serial TEXT,
  old_meter_final_reading  NUMERIC,
  new_meter_brand          TEXT, new_meter_size TEXT, new_meter_serial TEXT,
  new_meter_initial_reading NUMERIC,
  new_meter_installed_date DATE,
  replaced_by              UUID  REFERENCES public.user_profiles(id),
  remarks                  TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_lmr_locator ON public.locator_meter_replacements(locator_id);

CREATE TABLE public.locator_readings (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  locator_id       UUID    NOT NULL REFERENCES public.locators(id) ON DELETE CASCADE,
  plant_id         UUID    NOT NULL REFERENCES public.plants(id),
  reading_datetime TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_reading  NUMERIC NOT NULL,
  previous_reading NUMERIC,
  daily_volume     NUMERIC GENERATED ALWAYS AS (current_reading - COALESCE(previous_reading,0)) STORED,
  gps_lat          NUMERIC, gps_lng NUMERIC,
  off_location_flag BOOLEAN NOT NULL DEFAULT FALSE,
  recorded_by      UUID    REFERENCES public.user_profiles(id),
  remarks          TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_lr_plant_dt   ON public.locator_readings(plant_id, reading_datetime DESC);
CREATE INDEX idx_lr_locator_dt ON public.locator_readings(locator_id, reading_datetime DESC);

-- =============================================================
-- WELLS
-- =============================================================
CREATE TABLE public.wells (
  id                   UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id             UUID  NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  name                 TEXT  NOT NULL,
  size                 TEXT,
  status               public.plant_status NOT NULL DEFAULT 'Active',
  diameter             TEXT,
  drilling_depth_m     NUMERIC,
  has_power_meter      BOOLEAN NOT NULL DEFAULT FALSE,
  meter_brand          TEXT, meter_size TEXT, meter_serial TEXT,
  meter_installed_date DATE,
  depth_m              NUMERIC,
  is_blending_well     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_wells_plant ON public.wells(plant_id);
CREATE TRIGGER trg_wells_updated BEFORE UPDATE ON public.wells
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.well_pms_records (
  id                   UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  well_id              UUID  NOT NULL REFERENCES public.wells(id) ON DELETE CASCADE,
  plant_id             UUID  NOT NULL REFERENCES public.plants(id),
  record_type          TEXT  NOT NULL DEFAULT 'PMS'
    CHECK (record_type IN ('PMS','Pump Replacement','Monthly PWL')),
  date_gathered        DATE  NOT NULL,
  static_water_level_m NUMERIC,
  pumping_water_level_m NUMERIC,
  pump_setting         TEXT, pump_installed TEXT,
  motor_hp             NUMERIC, tds_ppm NUMERIC, turbidity_ntu NUMERIC,
  recorded_by          UUID  REFERENCES public.user_profiles(id),
  remarks              TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_wpms_well ON public.well_pms_records(well_id);

CREATE TABLE public.well_meter_replacements (
  id               UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  well_id          UUID  NOT NULL REFERENCES public.wells(id) ON DELETE CASCADE,
  plant_id         UUID  NOT NULL REFERENCES public.plants(id),
  replacement_date DATE  NOT NULL,
  old_serial       TEXT, old_final_reading NUMERIC,
  new_serial       TEXT, new_initial_reading NUMERIC,
  new_installed_date DATE,
  replaced_by      UUID  REFERENCES public.user_profiles(id),
  remarks          TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_wmr_well ON public.well_meter_replacements(well_id);

CREATE TABLE public.well_readings (
  id                   UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  well_id              UUID    NOT NULL REFERENCES public.wells(id) ON DELETE CASCADE,
  plant_id             UUID    NOT NULL REFERENCES public.plants(id),
  reading_datetime     TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_reading      NUMERIC NOT NULL,
  previous_reading     NUMERIC,
  daily_volume         NUMERIC GENERATED ALWAYS AS (current_reading - COALESCE(previous_reading,0)) STORED,
  off_location_flag    BOOLEAN NOT NULL DEFAULT FALSE,
  power_meter_reading  NUMERIC,
  recorded_by          UUID    REFERENCES public.user_profiles(id),
  remarks              TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_wr_plant_dt ON public.well_readings(plant_id, reading_datetime DESC);
CREATE INDEX idx_wr_well_dt  ON public.well_readings(well_id, reading_datetime DESC);

-- =============================================================
-- RO TRAINS
-- =============================================================
CREATE TABLE public.ro_trains (
  id         UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id   UUID  NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  name       TEXT  NOT NULL,
  status     public.train_status NOT NULL DEFAULT 'Offline',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ro_trains_plant ON public.ro_trains(plant_id);
CREATE TRIGGER trg_ro_trains_updated BEFORE UPDATE ON public.ro_trains
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.train_status_log (
  id           UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  train_id     UUID  NOT NULL REFERENCES public.ro_trains(id) ON DELETE CASCADE,
  plant_id     UUID  NOT NULL REFERENCES public.plants(id),
  old_status   public.train_status,
  new_status   public.train_status NOT NULL,
  changed_by   UUID  REFERENCES public.user_profiles(id),
  confirmed_by UUID  REFERENCES public.user_profiles(id),
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_train_status_log_train ON public.train_status_log(train_id, confirmed_at DESC);

CREATE TABLE public.ro_train_readings (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  ro_train_id      UUID    NOT NULL REFERENCES public.ro_trains(id) ON DELETE CASCADE,
  plant_id         UUID    NOT NULL REFERENCES public.plants(id),
  reading_datetime TIMESTAMPTZ NOT NULL DEFAULT now(),
  permeate_tds     NUMERIC, permeate_ph NUMERIC,
  raw_turbidity    NUMERIC, dp_psi NUMERIC, recovery_pct NUMERIC,
  recorded_by      UUID    REFERENCES public.user_profiles(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_rtr_plant_dt ON public.ro_train_readings(plant_id, reading_datetime DESC);

CREATE TABLE public.ro_pretreatment_readings (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id         UUID    NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  reading_datetime TIMESTAMPTZ NOT NULL DEFAULT now(),
  backwash_mode    TEXT,
  bypass_active    BOOLEAN NOT NULL DEFAULT FALSE,
  recorded_by      UUID    REFERENCES public.user_profiles(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ropr_plant_dt ON public.ro_pretreatment_readings(plant_id, reading_datetime DESC);

-- =============================================================
-- AFM / PUMP / CARTRIDGE / CIP
-- =============================================================
CREATE TABLE public.afm_readings (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id         UUID    NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  reading_datetime TIMESTAMPTZ NOT NULL DEFAULT now(),
  turbidity_in     NUMERIC, turbidity_out NUMERIC,
  pressure_in      NUMERIC, pressure_out NUMERIC,
  recorded_by      UUID    REFERENCES public.user_profiles(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.pump_readings (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id         UUID    NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  reading_datetime TIMESTAMPTZ NOT NULL DEFAULT now(),
  pump_name        TEXT    NOT NULL,
  pressure         NUMERIC, flow_rate NUMERIC, hours_run NUMERIC,
  recorded_by      UUID    REFERENCES public.user_profiles(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.cartridge_readings (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id         UUID    NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  reading_datetime TIMESTAMPTZ NOT NULL DEFAULT now(),
  pressure_in      NUMERIC, pressure_out NUMERIC,
  recorded_by      UUID    REFERENCES public.user_profiles(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.cip_logs (
  id            UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id      UUID    NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  cip_date      DATE    NOT NULL,
  chemical_used TEXT,
  duration_hrs  NUMERIC,
  performed_by  UUID    REFERENCES public.user_profiles(id),
  remarks       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================
-- CHEMICALS
-- =============================================================
CREATE TABLE public.chemical_inventory (
  id            UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id      UUID    NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  chemical_name TEXT    NOT NULL,
  quantity      NUMERIC NOT NULL DEFAULT 0,
  unit          TEXT    NOT NULL DEFAULT 'kg',
  unit_type     TEXT,
  price_per_unit NUMERIC,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_chem_inv_plant ON public.chemical_inventory(plant_id);

CREATE TABLE public.chemical_prices (
  id            UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id      UUID    NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  chemical_name TEXT    NOT NULL,
  price_per_unit NUMERIC NOT NULL,
  unit          TEXT    NOT NULL,
  effective_date DATE   NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.chemical_dosing_logs (
  id            UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id      UUID    NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  dosing_date   DATE    NOT NULL,
  chemical_name TEXT    NOT NULL,
  amount_used   NUMERIC NOT NULL,
  unit          TEXT    NOT NULL DEFAULT 'kg',
  recorded_by   UUID    REFERENCES public.user_profiles(id),
  remarks       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_cdl_plant_date ON public.chemical_dosing_logs(plant_id, dosing_date DESC);

CREATE TABLE public.chemical_deliveries (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id        UUID    NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  delivery_date   DATE    NOT NULL,
  chemical_name   TEXT    NOT NULL,
  quantity        NUMERIC NOT NULL,
  unit            TEXT    NOT NULL DEFAULT 'kg',
  supplier        TEXT,
  unit_cost       NUMERIC,
  received_by     UUID    REFERENCES public.user_profiles(id),
  remarks         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_cd_plant_date ON public.chemical_deliveries(plant_id, delivery_date DESC);

CREATE TABLE public.chemical_residual_samples (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id        UUID    NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  sample_date     DATE    NOT NULL,
  sample_point    TEXT    NOT NULL,
  chlorine_mg_l   NUMERIC,
  recorded_by     UUID    REFERENCES public.user_profiles(id),
  remarks         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================
-- POWER
-- =============================================================
CREATE TABLE public.power_readings (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id         UUID    NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  reading_datetime TIMESTAMPTZ NOT NULL DEFAULT now(),
  kwh_reading      NUMERIC,
  kwh_consumed     NUMERIC,
  recorded_by      UUID    REFERENCES public.user_profiles(id),
  remarks          TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pr_plant_dt ON public.power_readings(plant_id, reading_datetime DESC);

CREATE TABLE public.power_tariffs (
  id             UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id       UUID    NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  effective_date DATE    NOT NULL,
  rate_per_kwh   NUMERIC NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_power_tariffs_plant_date ON public.power_tariffs(plant_id, effective_date DESC);

CREATE TABLE public.electric_bills (
  id             UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id       UUID    NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  billing_month  DATE    NOT NULL,
  kwh_consumed   NUMERIC,
  amount_due     NUMERIC,
  remarks        TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_electric_bills_plant_month ON public.electric_bills(plant_id, billing_month DESC);
CREATE TRIGGER trg_electric_bills_updated BEFORE UPDATE ON public.electric_bills
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.plant_power_config (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id         UUID    NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE UNIQUE,
  solar_capacity_kw NUMERIC,
  grid_connected   BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================
-- PRODUCTION COSTS
-- =============================================================
CREATE TABLE public.production_costs (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id        UUID    NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  cost_date       DATE    NOT NULL,
  chemical_cost   NUMERIC NOT NULL DEFAULT 0,
  energy_cost     NUMERIC NOT NULL DEFAULT 0,
  total_cost      NUMERIC GENERATED ALWAYS AS (chemical_cost + energy_cost) STORED,
  volume_m3       NUMERIC,
  cost_per_m3     NUMERIC,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(plant_id, cost_date)
);
CREATE INDEX idx_production_costs_plant_date ON public.production_costs(plant_id, cost_date DESC);
CREATE TRIGGER trg_production_costs_updated BEFORE UPDATE ON public.production_costs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.production_calc_log (
  id         UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id   UUID  NOT NULL REFERENCES public.plants(id),
  cost_date  DATE  NOT NULL,
  trigger    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================
-- PRODUCT METERS
-- =============================================================
CREATE TABLE public.product_meters (
  id                   UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id             UUID  NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  name                 TEXT  NOT NULL,
  meter_serial         TEXT,
  meter_brand          TEXT,
  meter_installed_date DATE,
  status               public.plant_status NOT NULL DEFAULT 'Active',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_product_meters_plant ON public.product_meters(plant_id);

CREATE TABLE public.product_meter_readings (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  product_meter_id UUID    NOT NULL REFERENCES public.product_meters(id) ON DELETE CASCADE,
  plant_id         UUID    NOT NULL REFERENCES public.plants(id),
  reading_datetime TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_reading  NUMERIC NOT NULL,
  previous_reading NUMERIC,
  daily_volume     NUMERIC GENERATED ALWAYS AS (current_reading - COALESCE(previous_reading,0)) STORED,
  recorded_by      UUID    REFERENCES public.user_profiles(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.product_meter_audit_log (
  id         UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id   UUID  NOT NULL REFERENCES public.plants(id),
  meter_id   UUID,
  action     TEXT  NOT NULL,
  details    JSONB,
  actor_id   UUID  REFERENCES public.user_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================
-- CHECKLIST / PMS
-- =============================================================
CREATE TABLE public.checklist_templates (
  id                  UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id            UUID  NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  equipment_name      TEXT  NOT NULL,
  category            TEXT  NOT NULL,
  frequency           public.frequency_type NOT NULL DEFAULT 'Monthly',
  schedule_start_date DATE,
  steps               JSONB NOT NULL DEFAULT '[]',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ct_plant ON public.checklist_templates(plant_id);

CREATE TABLE public.checklist_executions (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id     UUID    NOT NULL REFERENCES public.checklist_templates(id) ON DELETE CASCADE,
  plant_id        UUID    NOT NULL REFERENCES public.plants(id),
  execution_date  DATE    NOT NULL,
  completed       BOOLEAN NOT NULL DEFAULT FALSE,
  findings        TEXT,
  completed_by    UUID    REFERENCES public.user_profiles(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ce_template ON public.checklist_executions(template_id, execution_date DESC);

CREATE TABLE public.checklist_step_executions (
  id            UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id  UUID    NOT NULL REFERENCES public.checklist_executions(id) ON DELETE CASCADE,
  step_index    INTEGER NOT NULL,
  completed     BOOLEAN NOT NULL DEFAULT FALSE,
  completed_by  UUID    REFERENCES public.user_profiles(id),
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================
-- INCIDENTS
-- =============================================================
CREATE TABLE public.incidents (
  id          UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id    UUID  NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  ref         TEXT  UNIQUE,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  severity    public.severity_level  NOT NULL DEFAULT 'Low',
  category    TEXT  NOT NULL,
  description TEXT  NOT NULL,
  status      public.incident_status NOT NULL DEFAULT 'Open',
  resolved_at TIMESTAMPTZ,
  resolved_by UUID  REFERENCES public.user_profiles(id),
  reported_by UUID  REFERENCES public.user_profiles(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_incidents_plant ON public.incidents(plant_id, occurred_at DESC);
CREATE TRIGGER trg_incidents_updated BEFORE UPDATE ON public.incidents
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================
-- NOTIFICATIONS
-- =============================================================
CREATE TABLE public.notifications (
  id         UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID    NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  plant_id   UUID    REFERENCES public.plants(id),
  type       TEXT    NOT NULL,
  severity   public.severity_level NOT NULL DEFAULT 'Low',
  message    TEXT    NOT NULL,
  read       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notif_user ON public.notifications(user_id, created_at DESC);

-- =============================================================
-- DAILY PLANT SUMMARY
-- =============================================================
CREATE TABLE public.daily_plant_summary (
  id                  UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id            UUID    NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  summary_date        DATE    NOT NULL,
  total_production_m3 NUMERIC,
  total_consumption_m3 NUMERIC,
  nrw_pct             NUMERIC,
  downtime_hrs        NUMERIC,
  permeate_tds        NUMERIC,
  permeate_ph         NUMERIC,
  raw_turbidity       NUMERIC,
  dp_psi              NUMERIC,
  recovery_pct        NUMERIC,
  pv_ratio            NUMERIC,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(plant_id, summary_date)
);
CREATE INDEX idx_dps_plant_date ON public.daily_plant_summary(plant_id, summary_date DESC);

-- =============================================================
-- BLENDING
-- =============================================================
CREATE TABLE public.blending_events (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id        UUID    NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  event_date      DATE    NOT NULL,
  well_id         UUID    REFERENCES public.wells(id),
  volume_blended  NUMERIC,
  recorded_by     UUID    REFERENCES public.user_profiles(id),
  remarks         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_blending_plant_date ON public.blending_events(plant_id, event_date DESC);

-- =============================================================
-- AUDIT / ADMIN TABLES
-- =============================================================
CREATE TABLE public.deletion_audit_log (
  id            UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type   TEXT    NOT NULL,
  entity_id     TEXT    NOT NULL,
  entity_name   TEXT,
  action        TEXT    NOT NULL DEFAULT 'soft_delete',
  reason        TEXT,
  actor_id      UUID    REFERENCES public.users(id),
  actor_email   TEXT,
  metadata      JSONB,
  deleted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_dal_entity ON public.deletion_audit_log(entity_type, entity_id);

CREATE TABLE public.import_audit_log (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id     UUID    REFERENCES public.plants(id),
  action       TEXT    NOT NULL,
  table_name   TEXT,
  row_count    INTEGER,
  actor_id     UUID    REFERENCES public.users(id),
  details      JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.plant_edit_audit_log (
  id          UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id    UUID  NOT NULL REFERENCES public.plants(id),
  field_name  TEXT  NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  actor_id    UUID  REFERENCES public.users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.entity_status_audit_log (
  id           UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  TEXT  NOT NULL,
  entity_id    UUID  NOT NULL,
  old_status   TEXT,
  new_status   TEXT  NOT NULL,
  actor_id     UUID  REFERENCES public.users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.plant_assignment_audit (
  id         UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID  NOT NULL REFERENCES public.users(id),
  plant_id   UUID  NOT NULL REFERENCES public.plants(id),
  action     TEXT  NOT NULL, -- 'assigned' | 'removed'
  actor_id   UUID  REFERENCES public.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.login_attempts (
  id           UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT,
  user_id      UUID  REFERENCES public.users(id),
  username     TEXT,
  plant_id     UUID  REFERENCES public.plants(id),
  success      BOOLEAN NOT NULL,
  error_reason TEXT,
  device_id    TEXT,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.signup_audit (
  id             UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  email          TEXT,
  designation    TEXT,
  operator_count INTEGER,
  plant_ids      UUID[],
  device_id      TEXT,
  user_agent     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================
-- ARCHIVED PLANT DATA
-- =============================================================
CREATE TABLE public.archived_plant_data (
  id          UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id    UUID  NOT NULL REFERENCES public.plants(id),
  table_name  TEXT  NOT NULL,
  snapshot    JSONB NOT NULL,
  label       TEXT,
  archived_by UUID  REFERENCES public.users(id),
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================
-- IMPORT ANALYSIS (AI import)
-- =============================================================
CREATE TABLE public.import_analyses (
  id           UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id     UUID  REFERENCES public.plants(id),
  filename     TEXT,
  status       TEXT  NOT NULL DEFAULT 'pending',
  mappings     JSONB,
  actor_id     UUID  REFERENCES public.users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_import_analyses_updated BEFORE UPDATE ON public.import_analyses
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================
-- INCIDENT REF SEQUENCE
-- =============================================================
CREATE SEQUENCE IF NOT EXISTS public.incident_ref_seq START 1000;
CREATE OR REPLACE FUNCTION public.generate_incident_ref()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ref IS NULL THEN
    NEW.ref := 'INC-' || LPAD(nextval('public.incident_ref_seq')::TEXT, 5, '0');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_incident_ref BEFORE INSERT ON public.incidents
  FOR EACH ROW EXECUTE FUNCTION public.generate_incident_ref();

-- =============================================================
-- RECOMPUTE PRODUCTION COST
-- =============================================================
CREATE OR REPLACE FUNCTION public.recompute_production_cost(_plant_id uuid, _date date)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_chem  NUMERIC := 0;
  v_power NUMERIC := 0;
  v_vol   NUMERIC := 0;
BEGIN
  SELECT COALESCE(SUM(d.amount_used * COALESCE(p.price_per_unit, 0)), 0)
    INTO v_chem
    FROM public.chemical_dosing_logs d
    LEFT JOIN public.chemical_prices p
      ON p.plant_id = d.plant_id AND p.chemical_name = d.chemical_name
         AND p.effective_date <= _date
    WHERE d.plant_id = _plant_id AND d.dosing_date = _date;

  SELECT COALESCE(SUM(pr.kwh_consumed * COALESCE(t.rate_per_kwh, 0)), 0)
    INTO v_power
    FROM public.power_readings pr
    LEFT JOIN public.power_tariffs t
      ON t.plant_id = pr.plant_id AND t.effective_date <= _date::date
    WHERE pr.plant_id = _plant_id AND pr.reading_datetime::date = _date;

  SELECT COALESCE(SUM(daily_volume), 0) INTO v_vol
    FROM public.well_readings
    WHERE plant_id = _plant_id AND reading_datetime::date = _date;

  INSERT INTO public.production_costs(plant_id, cost_date, chemical_cost, energy_cost, volume_m3, cost_per_m3)
    VALUES (_plant_id, _date, v_chem, v_power, v_vol,
            CASE WHEN v_vol > 0 THEN (v_chem + v_power) / v_vol ELSE NULL END)
  ON CONFLICT (plant_id, cost_date)
  DO UPDATE SET
    chemical_cost = EXCLUDED.chemical_cost,
    energy_cost   = EXCLUDED.energy_cost,
    volume_m3     = EXCLUDED.volume_m3,
    cost_per_m3   = EXCLUDED.cost_per_m3,
    updated_at    = now();

  INSERT INTO public.production_calc_log(plant_id, cost_date, trigger)
    VALUES (_plant_id, _date, 'trigger');
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_recompute_cost()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE _pid uuid; _dt date;
BEGIN
  _pid := COALESCE(NEW.plant_id, OLD.plant_id);
  IF TG_TABLE_NAME = 'chemical_dosing_logs' THEN
    _dt := COALESCE(NEW.dosing_date, OLD.dosing_date);
  ELSIF TG_TABLE_NAME = 'power_readings' THEN
    _dt := COALESCE(NEW.reading_datetime, OLD.reading_datetime)::date;
  ELSE
    _dt := COALESCE(NEW.reading_datetime, OLD.reading_datetime)::date;
  END IF;
  PERFORM public.recompute_production_cost(_pid, _dt);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_chem_cost  AFTER INSERT OR UPDATE OR DELETE ON public.chemical_dosing_logs
  FOR EACH ROW EXECUTE FUNCTION public.trg_recompute_cost();
CREATE TRIGGER trg_power_cost AFTER INSERT OR UPDATE OR DELETE ON public.power_readings
  FOR EACH ROW EXECUTE FUNCTION public.trg_recompute_cost();
CREATE TRIGGER trg_well_cost  AFTER INSERT OR UPDATE OR DELETE ON public.well_readings
  FOR EACH ROW EXECUTE FUNCTION public.trg_recompute_cost();
