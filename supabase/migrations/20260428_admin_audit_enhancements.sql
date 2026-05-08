-- =====================================================================
-- 20260428 Admin RBAC + Audit Enhancements
-- Run this in the Supabase SQL editor BEFORE 20260428_promote_admin_kevin.sql
-- =====================================================================
-- 1. Extend deletion_audit_log to accept kind = 'well'
-- 2. Create login_attempts table for sign-in audit
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. deletion_audit_log: allow kind='well' (iter 6 wells bulk delete)
-- ---------------------------------------------------------------------
ALTER TABLE public.deletion_audit_log
  DROP CONSTRAINT IF EXISTS deletion_audit_log_kind_check;

ALTER TABLE public.deletion_audit_log
  ADD CONSTRAINT deletion_audit_log_kind_check
  CHECK (kind IN ('user', 'plant', 'well'));

-- ---------------------------------------------------------------------
-- 2. login_attempts: every sign-in click (success or failure)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.login_attempts (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT        NOT NULL,
  user_id       UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  success       BOOLEAN     NOT NULL,
  error_reason  TEXT,
  user_agent    TEXT,
  attempted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS login_attempts_email_idx
  ON public.login_attempts (lower(email), attempted_at DESC);

CREATE INDEX IF NOT EXISTS login_attempts_attempted_idx
  ON public.login_attempts (attempted_at DESC);

ALTER TABLE public.login_attempts ENABLE ROW LEVEL SECURITY;

-- Anyone (anon role included) may insert a login attempt — the row only
-- contains an email + success flag; the actual credentials are never stored.
DROP POLICY IF EXISTS "login_attempts insertable by anyone" ON public.login_attempts;
CREATE POLICY "login_attempts insertable by anyone"
  ON public.login_attempts
  FOR INSERT
  WITH CHECK (true);

-- Only Admins may read the audit trail.
DROP POLICY IF EXISTS "login_attempts readable by admin" ON public.login_attempts;
CREATE POLICY "login_attempts readable by admin"
  ON public.login_attempts
  FOR SELECT
  USING (public.is_admin(auth.uid()));

-- Rows are immutable: no UPDATE / DELETE policies → denied by default.
