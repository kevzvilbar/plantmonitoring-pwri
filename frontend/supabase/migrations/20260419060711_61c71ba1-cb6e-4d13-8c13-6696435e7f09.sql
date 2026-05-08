
DROP POLICY IF EXISTS "notifications_insert_authenticated" ON public.notifications;
CREATE POLICY "notifications_insert_self" ON public.notifications
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
