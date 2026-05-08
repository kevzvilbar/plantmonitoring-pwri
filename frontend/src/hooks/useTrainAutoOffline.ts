import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Auto-flag RO trains as Offline when no readings have been logged in > 2 hours.
 * Returns the list of trains needing operator confirmation to remain Running.
 */
export interface TrainGap {
  train_id: string;
  train_number: number;
  plant_id: string;
  last_reading_at: string | null;
  hours_gap: number;
  current_status: string;
}

export function useTrainAutoOffline(plantIds: string[]) {
  const { data: gaps } = useQuery({
    queryKey: ['train-gaps', plantIds],
    queryFn: async (): Promise<TrainGap[]> => {
      if (!plantIds.length) return [];
      const { data: trains } = await supabase
        .from('ro_trains')
        .select('id,train_number,plant_id,status')
        .in('plant_id', plantIds);
      if (!trains?.length) return [];

      const since = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString();
      const { data: recent } = await supabase
        .from('ro_train_readings')
        .select('train_id,reading_datetime')
        .in('train_id', trains.map((t) => t.id))
        .gte('reading_datetime', since)
        .order('reading_datetime', { ascending: false });

      const lastBy = new Map<string, string>();
      (recent ?? []).forEach((r: any) => {
        if (!lastBy.has(r.train_id)) lastBy.set(r.train_id, r.reading_datetime);
      });

      const now = Date.now();
      return trains.map((t: any) => {
        const last = lastBy.get(t.id) ?? null;
        const hours = last ? (now - new Date(last).getTime()) / 1000 / 60 / 60 : Infinity;
        return {
          train_id: t.id, train_number: t.train_number, plant_id: t.plant_id,
          last_reading_at: last, hours_gap: hours, current_status: t.status,
        };
      }).filter((g) => g.hours_gap > 2 && g.current_status === 'Running');
    },
    enabled: plantIds.length > 0,
    refetchInterval: 5 * 60 * 1000,
  });

  // Auto-mark stale trains Offline (operator must confirm to bring back Running)
  useEffect(() => {
    if (!gaps?.length) return;
    (async () => {
      for (const g of gaps) {
        await supabase.from('ro_trains').update({ status: 'Offline' }).eq('id', g.train_id);
        await supabase.from('train_status_log').insert({
          train_id: g.train_id, plant_id: g.plant_id, status: 'Offline',
          reason: `Auto-flagged: no reading for ${g.hours_gap.toFixed(1)}h`,
        });
      }
    })();
  }, [gaps]);

  return gaps ?? [];
}
