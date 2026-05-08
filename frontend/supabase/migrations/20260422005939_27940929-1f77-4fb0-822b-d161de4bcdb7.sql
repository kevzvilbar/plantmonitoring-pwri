CREATE OR REPLACE FUNCTION public.trg_recompute_cost()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_plant uuid;
  v_date date;
  v_ts timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_plant := OLD.plant_id;
    -- Try log_datetime (chem_dosing) first, then reading_datetime (well/power)
    BEGIN v_ts := OLD.log_datetime; EXCEPTION WHEN undefined_column THEN v_ts := NULL; END;
    IF v_ts IS NULL THEN
      BEGIN v_ts := OLD.reading_datetime; EXCEPTION WHEN undefined_column THEN v_ts := NULL; END;
    END IF;
  ELSE
    v_plant := NEW.plant_id;
    BEGIN v_ts := NEW.log_datetime; EXCEPTION WHEN undefined_column THEN v_ts := NULL; END;
    IF v_ts IS NULL THEN
      BEGIN v_ts := NEW.reading_datetime; EXCEPTION WHEN undefined_column THEN v_ts := NULL; END;
    END IF;
  END IF;
  IF v_ts IS NOT NULL THEN
    v_date := v_ts::date;
    PERFORM public.recompute_production_cost(v_plant, v_date);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;