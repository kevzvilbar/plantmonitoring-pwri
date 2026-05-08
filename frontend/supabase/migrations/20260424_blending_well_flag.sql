-- Optional Supabase migration: blending-well flag on `wells` table.
-- The app currently tracks blending wells in Mongo (collection
-- `blending_wells`) so this is NOT required to run. Apply this migration
-- when you want the flag stored alongside the wells row in Supabase.

alter table if exists public.wells
    add column if not exists is_blending_well boolean not null default false;

comment on column public.wells.is_blending_well is
    'True if this well injects directly into the Product Water line '
    '(bypasses RO). Volumes are still recorded but flagged in audit.';

create index if not exists wells_is_blending_idx
    on public.wells (plant_id, is_blending_well)
    where is_blending_well = true;
