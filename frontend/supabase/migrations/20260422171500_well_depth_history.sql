-- Allow logging historical changes of well drilling depth via well_pms_records
ALTER TABLE public.well_pms_records
  ADD COLUMN IF NOT EXISTS drilling_depth_m numeric;
