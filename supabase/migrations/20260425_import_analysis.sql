-- =====================================================================
-- AI Universal Import — analysis & decision log
-- Run this once in the Supabase SQL editor
-- (Dashboard → SQL Editor → New query → paste → Run)
-- =====================================================================

create table if not exists public.import_analysis (
  id                  uuid        primary key default gen_random_uuid(),
  actor_user_id       uuid        references auth.users(id) on delete set null,
  actor_label         text,
  plant_id            uuid        references public.plants(id) on delete set null,
  filename            text        not null,
  file_kind           text,                          -- xlsx | xlsm | txt | csv | docx | ...
  file_size           integer,
  ai_provider         text,                          -- openai | rule-based
  ai_model            text,
  status              text        not null default 'pending'
                                  check (status in ('pending', 'synced', 'rejected', 'partial')),
  wellmeter_detected  boolean     not null default false,
  tables              jsonb       not null,          -- per-table classification + sample rows
  decisions           jsonb,                         -- per-table approve/reject + edits made by admin
  reason              text,
  decided_by          uuid        references auth.users(id) on delete set null,
  decided_at          timestamptz,
  sync_summary        jsonb,                         -- {created: {wells: N, ...}, inserted: {well_readings: N, ...}, skipped: [...]}
  created_at          timestamptz not null default now()
);

create index if not exists import_analysis_actor_idx
  on public.import_analysis (actor_user_id);

create index if not exists import_analysis_status_idx
  on public.import_analysis (status, created_at desc);

create index if not exists import_analysis_created_idx
  on public.import_analysis (created_at desc);

alter table public.import_analysis enable row level security;

-- Admin / Manager may read every analysis row.
drop policy if exists "import_analysis readable by admin/manager"
  on public.import_analysis;
create policy "import_analysis readable by admin/manager"
  on public.import_analysis
  for select
  using (public.is_manager_or_admin(auth.uid()));

-- Admin / Manager may insert their own analysis runs.
drop policy if exists "import_analysis insertable by admin/manager"
  on public.import_analysis;
create policy "import_analysis insertable by admin/manager"
  on public.import_analysis
  for insert
  with check (public.is_manager_or_admin(auth.uid()));

-- Updates are Admin-only — and only via the /api/import/ai-sync endpoint
-- which performs strict validation, audit logging, and status transitions.
-- Manager can read + create analyses but cannot mutate decisions/status
-- directly through the Supabase API, matching the server-side
-- _require_roles({"Admin"}) check on the sync endpoint.
drop policy if exists "import_analysis updatable by admin/manager"
  on public.import_analysis;
drop policy if exists "import_analysis updatable by admin"
  on public.import_analysis;
create policy "import_analysis updatable by admin"
  on public.import_analysis
  for update
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- No delete policy — analysis rows are kept for audit history.

-- Recommended (but not strictly required) uniqueness — prevents the
-- get-or-create race in _ensure_entity from creating duplicate wells /
-- locators / ro_trains under the same plant when two admins approve
-- overlapping analyses at the same time. Wrapped in DO blocks so the
-- migration is idempotent and tolerates pre-existing data with dups.
do $$
begin
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'wells_plant_name_uq'
  ) then
    begin
      execute 'create unique index wells_plant_name_uq on public.wells (plant_id, lower(name))';
    exception when others then
      raise notice 'wells_plant_name_uq skipped: %', sqlerrm;
    end;
  end if;
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'locators_plant_name_uq'
  ) then
    begin
      execute 'create unique index locators_plant_name_uq on public.locators (plant_id, lower(name))';
    exception when others then
      raise notice 'locators_plant_name_uq skipped: %', sqlerrm;
    end;
  end if;
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'ro_trains_plant_name_uq'
  ) then
    begin
      execute 'create unique index ro_trains_plant_name_uq on public.ro_trains (plant_id, lower(name))';
    exception when others then
      raise notice 'ro_trains_plant_name_uq skipped: %', sqlerrm;
    end;
  end if;
end $$;
