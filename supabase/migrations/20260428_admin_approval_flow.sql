-- =====================================================================
-- 20260428 Admin Approval Flow (replaces Supabase email confirmation)
-- =====================================================================
-- Pre-requisite (manual, you):
--   Supabase Studio → Authentication → Providers → Email →
--   turn OFF "Confirm email". This lets sign-ups create an
--   auth.users row immediately. Approval is then gated by the
--   `confirmed` flag below.
--
-- This migration:
--   1. Adds `confirmed BOOLEAN NOT NULL DEFAULT FALSE` to user_profiles.
--   2. Backfills `confirmed=TRUE` for users already `Active` so the
--      flow is non-disruptive for the existing org.
--   3. Updates handle_new_user() so new sign-ups land at confirmed=false.
--   4. Adds RPC `approve_user(_user_id, _approve)` callable only by
--      Admins (Manager+) — sets confirmed and (when approving) status.
--   5. Adds an RLS UPDATE policy on user_profiles allowing Admins to
--      flip the `confirmed` flag directly via a regular UPDATE (the RPC
--      is the recommended path; this is a belt-and-braces fallback).
-- =====================================================================

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS confirmed BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.user_profiles.confirmed
  IS 'Admin approval flag. New signups land at FALSE; Admin must call '
     'approve_user() (or set the column directly) to unlock the app.';

-- 1. Non-disruptive backfill: anyone already Active is implicitly approved.
UPDATE public.user_profiles
   SET confirmed = TRUE
 WHERE status = 'Active' AND confirmed = FALSE;

-- 2. Update auto-profile trigger so future sign-ups land confirmed=false.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.user_profiles (id, status, profile_complete, confirmed)
  VALUES (NEW.id, 'Pending', FALSE, FALSE)
  ON CONFLICT (id) DO NOTHING;
  -- default role: Operator (Pending status + confirmed=false keep them out
  -- of the app until Admin approves and assigns a designation/role).
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'Operator')
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

-- 3. RPC: only Admins can approve / un-approve. Returns the updated row.
CREATE OR REPLACE FUNCTION public.approve_user(
  _user_id UUID,
  _approve BOOLEAN DEFAULT TRUE
)
RETURNS public.user_profiles
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  result public.user_profiles;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Only Admins may approve user accounts.'
      USING ERRCODE = '42501';  -- insufficient_privilege
  END IF;
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required';
  END IF;

  UPDATE public.user_profiles
     SET confirmed = _approve,
         status    = CASE
                       WHEN _approve THEN 'Active'::public.profile_status
                       ELSE status
                     END,
         updated_at = now()
   WHERE id = _user_id
   RETURNING * INTO result;

  IF result.id IS NULL THEN
    RAISE EXCEPTION 'No user_profiles row found for %', _user_id;
  END IF;

  RETURN result;
END;
$$;

-- 4. Belt-and-braces RLS: Admin can UPDATE user_profiles.confirmed
-- (and other fields) for any user. The existing self-service UPDATE
-- policy is unchanged — users still only mutate their own non-admin
-- fields via the RPC `update_own_profile`.
DROP POLICY IF EXISTS "user_profiles admin full update" ON public.user_profiles;
CREATE POLICY "user_profiles admin full update"
  ON public.user_profiles
  FOR UPDATE
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

-- Admins also need broad read on user_profiles to power the approval queue
-- (the existing read policies in the original migration already cover this
--  for Manager+; if your project locked it down further, uncomment below):
-- DROP POLICY IF EXISTS "user_profiles admin read" ON public.user_profiles;
-- CREATE POLICY "user_profiles admin read"
--   ON public.user_profiles FOR SELECT
--   USING (public.is_manager_or_admin(auth.uid()));

-- 5. Grant execute on the RPC to authenticated users — the RPC itself
-- enforces the Admin check.
GRANT EXECUTE ON FUNCTION public.approve_user(UUID, BOOLEAN) TO authenticated;
