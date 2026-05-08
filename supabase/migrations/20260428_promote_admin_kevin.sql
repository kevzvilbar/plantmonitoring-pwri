-- =====================================================================
-- 20260428 Promote Kevin Vilbar to Admin
-- =====================================================================
-- Pre-requisites:
--   1. Run 20260428_admin_audit_enhancements.sql first.
--   2. Kevin must have already signed up at /auth using:
--        Email:    kevzvilbar@gmail.com
--        Password: BPWI2025!
-- This script does NOT create an auth.users row — Supabase only allows
-- that via the dashboard or the service-role key. Once the auth row
-- exists, this script attaches a complete `user_profiles` record and
-- assigns the Admin role.
-- =====================================================================

DO $$
DECLARE
  kevin_id UUID;
BEGIN
  SELECT id INTO kevin_id
  FROM auth.users
  WHERE lower(email) = lower('kevzvilbar@gmail.com')
  LIMIT 1;

  IF kevin_id IS NULL THEN
    RAISE EXCEPTION
      'No auth.users row for kevzvilbar@gmail.com. Sign up at /auth first, then re-run this script.';
  END IF;

  -- Upsert profile
  INSERT INTO public.user_profiles
    (id, username, first_name, last_name, designation, status, profile_complete, confirmed)
  VALUES
    (kevin_id, 'Kevz', 'Kevin', 'Vilbar', 'Admin', 'Active', TRUE, TRUE)
  ON CONFLICT (id) DO UPDATE
  SET first_name       = EXCLUDED.first_name,
      last_name        = EXCLUDED.last_name,
      username         = EXCLUDED.username,
      designation      = EXCLUDED.designation,
      status           = EXCLUDED.status,
      profile_complete = TRUE,
      confirmed        = TRUE,
      updated_at       = now();

  -- Grant Admin role (idempotent thanks to the (user_id, role) unique key)
  INSERT INTO public.user_roles (user_id, role)
  VALUES (kevin_id, 'Admin')
  ON CONFLICT (user_id, role) DO NOTHING;

  RAISE NOTICE 'Kevin Vilbar (%) promoted to Admin.', kevin_id;
END
$$;
