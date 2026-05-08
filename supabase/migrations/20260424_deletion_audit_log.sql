-- =====================================================================
-- Deletion Audit Log
-- Run this once in the Supabase SQL editor
-- (Dashboard → SQL Editor → New query → paste → Run)
-- =====================================================================

create table if not exists public.deletion_audit_log (
  id              uuid        primary key default gen_random_uuid(),
  kind            text        not null check (kind in ('user', 'plant')),
  entity_id       uuid        not null,
  entity_label    text,
  action          text        not null check (action in ('soft', 'hard')),
  actor_user_id   uuid        references auth.users(id) on delete set null,
  actor_label     text,
  reason          text,
  dependencies    jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists deletion_audit_log_kind_entity_idx
  on public.deletion_audit_log (kind, entity_id);

create index if not exists deletion_audit_log_created_idx
  on public.deletion_audit_log (created_at desc);

alter table public.deletion_audit_log enable row level security;

-- Admins and Managers may read the full log.
drop policy if exists "audit log readable by admin/manager"
  on public.deletion_audit_log;
create policy "audit log readable by admin/manager"
  on public.deletion_audit_log
  for select
  using (public.is_manager_or_admin(auth.uid()));

-- Admins and Managers may insert (actions are gated server-side anyway).
drop policy if exists "audit log insertable by admin/manager"
  on public.deletion_audit_log;
create policy "audit log insertable by admin/manager"
  on public.deletion_audit_log
  for insert
  with check (public.is_manager_or_admin(auth.uid()));

-- Log rows are immutable: no update / delete policies -> denied by default.
