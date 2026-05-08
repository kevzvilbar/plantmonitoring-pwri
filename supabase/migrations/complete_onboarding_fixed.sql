-- 1) Tighten plant access: require Active status (suspension now enforced at DB layer)
CREATE OR REPLACE FUNCTION public.user_has_plant_access(_plant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT public.is_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid()
        AND status = 'Active'
        AND _plant_id = ANY(plant_assignments)
    );
$function$;

-- 2) Lock down user_profiles SELECT — drop the open "everyone can read all" policy.
DROP POLICY IF EXISTS profiles_select_authenticated ON public.user_profiles;

-- Self can read own full profile
DROP POLICY IF EXISTS profiles_select_self ON public.user_profiles;
CREATE POLICY profiles_select_self
  ON public.user_profiles
  FOR SELECT TO authenticated
  USING (auth.uid() = id);

-- Admins can read all profiles (already covered by profiles_admin_all but explicit SELECT helps)
-- (profiles_admin_all already grants ALL to admins so we don't add a duplicate.)

-- Managers may read profiles of users assigned to plants they administer (needed for Employees screen).
-- Simpler approach: any manager/admin can read all profiles.
DROP POLICY IF EXISTS profiles_select_manager ON public.user_profiles;
CREATE POLICY profiles_select_manager
  ON public.user_profiles
  FOR SELECT TO authenticated
  USING (public.is_manager_or_admin(auth.uid()));

-- 3) Replace blanket profiles_update_self with a column-restricted update via SECURITY DEFINER RPC.
DROP POLICY IF EXISTS profiles_update_self ON public.user_profiles;

-- RPC: update only safe profile fields (never status, plant_assignments, profile_complete, immediate_head_id)
CREATE OR REPLACE FUNCTION public.update_own_profile(
  _username text,
  _first_name text,
  _middle_name text,
  _last_name text,
  _suffix text,
  _designation text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  UPDATE public.user_profiles SET
    username = COALESCE(_username, username),
    first_name = COALESCE(_first_name, first_name),
    middle_name = _middle_name,
    last_name = COALESCE(_last_name, last_name),
    suffix = _suffix,
    designation = _designation,
    updated_at = now()
  WHERE id = auth.uid();
END;
$$;

REVOKE ALL ON FUNCTION public.update_own_profile(text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_own_profile(text,text,text,text,text,text) TO authenticated;

-- RPC: complete onboarding — sets safe fields + plant_assignments + activates account.
-- Only allowed when profile_complete is still false (one-time use).
CREATE OR REPLACE FUNCTION public.complete_onboarding(
  _username text,
  _first_name text,
  _middle_name text,
  _last_name text,
  _suffix text,
  _designation text,
  _plant_assignments uuid[]
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_complete boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF _plant_assignments IS NULL OR array_length(_plant_assignments, 1) IS NULL THEN
    RAISE EXCEPTION 'At least one plant assignment is required';
  END IF;

  SELECT profile_complete INTO v_complete FROM public.user_profiles WHERE id = auth.uid();
  IF v_complete THEN
    RAISE EXCEPTION 'Profile already complete; ask an Admin to change plant assignments';
  END IF;

  UPDATE public.user_profiles SET
    username = _username,
    first_name = _first_name,
    middle_name = _middle_name,
    last_name = _last_name,
    suffix = _suffix,
    designation = _designation,
    plant_assignments = _plant_assignments,
    profile_complete = true,
    status = 'Active',
    updated_at = now()
  WHERE id = auth.uid();
END;
$$;

REVOKE ALL ON FUNCTION public.complete_onboarding(text,text,text,text,text,text,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_onboarding(text,text,text,text,text,text,uuid[]) TO authenticated;