-- Per-step checklist execution tracking for PM checklists
CREATE TABLE IF NOT EXISTS public.checklist_step_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL REFERENCES public.checklist_executions(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES public.checklist_templates(id) ON DELETE CASCADE,
  plant_id uuid REFERENCES public.plants(id) ON DELETE CASCADE,
  step_index integer NOT NULL,
  step_text text NOT NULL,
  completed boolean NOT NULL DEFAULT false,
  value text,
  notes text,
  completed_by uuid REFERENCES public.user_profiles(id),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (execution_id, step_index)
);

CREATE INDEX IF NOT EXISTS idx_cse_execution ON public.checklist_step_executions(execution_id);
CREATE INDEX IF NOT EXISTS idx_cse_template ON public.checklist_step_executions(template_id);
CREATE INDEX IF NOT EXISTS idx_cse_plant ON public.checklist_step_executions(plant_id);

ALTER TABLE public.checklist_step_executions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "checklist_step_executions_plant_access"
  ON public.checklist_step_executions
  FOR ALL TO authenticated
  USING (plant_id IS NULL OR public.user_has_plant_access(plant_id))
  WITH CHECK (plant_id IS NULL OR public.user_has_plant_access(plant_id));