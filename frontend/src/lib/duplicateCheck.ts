import { supabase } from '@/integrations/supabase/client';

/**
 * Check if a reading already exists for the given entity within a time window.
 * Returns the existing row id if a duplicate exists, otherwise null.
 */
export async function findExistingReading(opts: {
  table: string;
  entityCol: string;
  entityId: string;
  datetime: Date;
  windowKind: 'hour' | 'day';
  extraEqual?: Record<string, string | number>;
}): Promise<string | null> {
  const { table, entityCol, entityId, datetime, windowKind, extraEqual } = opts;
  let start: Date, end: Date;
  if (windowKind === 'hour') {
    start = new Date(datetime); start.setMinutes(0, 0, 0);
    end = new Date(start); end.setHours(end.getHours() + 1);
  } else {
    start = new Date(datetime); start.setHours(0, 0, 0, 0);
    end = new Date(start); end.setDate(end.getDate() + 1);
  }
  let q: any = (supabase.from(table as any) as any).select('id').eq(entityCol, entityId)
    .gte('reading_datetime', start.toISOString())
    .lt('reading_datetime', end.toISOString())
    .limit(1);
  if (extraEqual) {
    for (const [k, v] of Object.entries(extraEqual)) q = q.eq(k, v);
  }
  const { data } = await q;
  return (data?.[0] as any)?.id ?? null;
}

/**
 * Per-day reading-count check (e.g. some wells allow up to N readings per day).
 */
export async function countReadingsToday(opts: {
  table: string;
  entityCol: string;
  entityId: string;
  date: Date;
}): Promise<number> {
  const start = new Date(opts.date); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  const { count } = await (supabase.from(opts.table as any) as any)
    .select('*', { count: 'exact', head: true })
    .eq(opts.entityCol, opts.entityId)
    .gte('reading_datetime', start.toISOString())
    .lt('reading_datetime', end.toISOString());
  return count ?? 0;
}
