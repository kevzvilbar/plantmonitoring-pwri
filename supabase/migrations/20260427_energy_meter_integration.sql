-- 20260427 Energy & Meter Integration
-- ------------------------------------------------------------------
-- Adds:
-- 1. Dedicated electric-meter columns on `wells`
--    (water meter columns already exist; this is the second meter).
-- 2. Solar / grid configuration on `plants`.
-- 3. Per-reading solar/grid kWh split on `power_readings` so the
--    Dashboard EnergyMixCard can show stacked bars + today KPIs.
-- ------------------------------------------------------------------

-- 1. WELLS — dedicated electric meter
ALTER TABLE public.wells
  ADD COLUMN IF NOT EXISTS electric_meter_brand          TEXT,
  ADD COLUMN IF NOT EXISTS electric_meter_size           TEXT,
  ADD COLUMN IF NOT EXISTS electric_meter_serial         TEXT,
  ADD COLUMN IF NOT EXISTS electric_meter_installed_date DATE;

COMMENT ON COLUMN public.wells.electric_meter_brand
  IS 'Brand of the dedicated kWh meter on this well (separate from water meter)';

-- 2. PLANTS — energy source flags
ALTER TABLE public.plants
  ADD COLUMN IF NOT EXISTS has_solar         BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS has_grid          BOOLEAN     NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS solar_capacity_kw NUMERIC(12,2);

COMMENT ON COLUMN public.plants.has_solar IS 'Plant has rooftop / hybrid solar generation';
COMMENT ON COLUMN public.plants.has_grid  IS 'Plant draws power from utility grid';

-- 3. POWER_READINGS — solar / grid daily kWh (operator-entered)
ALTER TABLE public.power_readings
  ADD COLUMN IF NOT EXISTS daily_solar_kwh NUMERIC(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS daily_grid_kwh  NUMERIC(14,2) DEFAULT 0;

COMMENT ON COLUMN public.power_readings.daily_solar_kwh
  IS 'kWh produced from solar on this reading''s day (0 if plant has no solar)';
COMMENT ON COLUMN public.power_readings.daily_grid_kwh
  IS 'kWh drawn from grid on this reading''s day (0 if plant is off-grid)';

-- Backfill: for legacy rows where solar/grid not split, treat the existing
-- daily_consumption_kwh as 100% grid so charts don't show empty bars.
UPDATE public.power_readings
SET daily_grid_kwh = COALESCE(daily_consumption_kwh, 0)
WHERE daily_grid_kwh = 0
  AND daily_solar_kwh = 0
  AND COALESCE(daily_consumption_kwh, 0) > 0;
