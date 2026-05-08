import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import { format, subDays } from 'date-fns';

// Power-consumption bar chart shown beneath the alerts feed. Always
// renders the last 14 days regardless of the page-level view-mode
// toggle — this card existed before the 3-mode toggle was introduced
// and is unrelated to the per-cluster trend graphs.
export function PowerChart({ plantIds }: { plantIds: string[] }) {
  const { data } = useQuery({
    queryKey: ['dash-power-chart', plantIds],
    queryFn: async () => {
      if (!plantIds.length) return [];
      const since = subDays(new Date(), 14).toISOString();
      const { data } = await supabase.from('power_readings')
        .select('reading_datetime,daily_consumption_kwh').in('plant_id', plantIds)
        .gte('reading_datetime', since).order('reading_datetime');
      return data ?? [];
    },
    enabled: plantIds.length > 0,
  });
  const chartData = useMemo(() => {
    const m = new Map<string, { sortKey: number; kwh: number }>();
    (data ?? []).forEach((r: any) => {
      const dt = new Date(r.reading_datetime);
      const d = format(dt, 'MMM d');
      const cur = m.get(d) ?? { sortKey: dt.getTime(), kwh: 0 };
      cur.kwh += +r.daily_consumption_kwh || 0;
      m.set(d, cur);
    });
    return Array.from(m.entries())
      .sort((a, b) => a[1].sortKey - b[1].sortKey)
      .map(([date, v]) => ({ date, kwh: v.kwh }));
  }, [data]);
  return (
    <Card className="p-3">
      <h2 className="text-sm font-semibold mb-2">Power consumption · last 14d</h2>
      <div className="h-44">
        <ResponsiveContainer>
          <BarChart data={chartData} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
            <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
            <Tooltip contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }} />
            <Bar dataKey="kwh" fill="hsl(var(--chart-6))" name="kWh" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
