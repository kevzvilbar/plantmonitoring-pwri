import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import {
  format, subDays, startOfDay, startOfWeek, startOfMonth,
} from 'date-fns';
import { Sun, Zap } from 'lucide-react';
import { fmtNum } from '@/lib/calculations';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

type PowerRow = {
  reading_datetime: string;
  daily_consumption_kwh: number | null;
  daily_solar_kwh: number | null;
  daily_grid_kwh: number | null;
};

type Timeframe = 'daily' | 'weekly' | 'monthly';
type Source = 'both' | 'solar' | 'grid';
type RangeDays = 7 | 14 | 30 | 90;

interface Props {
  plantIds: string[];
}

export function EnergyMixCard({ plantIds }: Props) {
  const [timeframe, setTimeframe] = useState<Timeframe>('daily');
  const [rangeDays, setRangeDays] = useState<RangeDays>(14);
  const [source, setSource] = useState<Source>('both');

  const since = useMemo(
    () => startOfDay(subDays(new Date(), rangeDays)).toISOString(),
    [rangeDays],
  );
  const todayStart = useMemo(() => startOfDay(new Date()).toISOString(), []);

  const { data } = useQuery({
    queryKey: ['energy-mix', plantIds, since],
    queryFn: async () => {
      if (!plantIds.length) return [];
      const { data } = await supabase
        .from('power_readings')
        // cast to any: daily_solar_kwh / daily_grid_kwh land after the
        // 20260427 migration runs; pre-migration they fall back to
        // daily_consumption_kwh in the chart logic below.
        .select('reading_datetime,daily_consumption_kwh,daily_solar_kwh,daily_grid_kwh' as any)
        .in('plant_id', plantIds)
        .gte('reading_datetime', since)
        .order('reading_datetime');
      return (data ?? []) as unknown as PowerRow[];
    },
    enabled: plantIds.length > 0,
  });

  // Wrap in useMemo so the array reference is stable when `data` is
  // unchanged — otherwise the `chartData` useMemo (line 116) re-runs on
  // every render, defeating its memoisation.
  const rows = useMemo<PowerRow[]>(() => data ?? [], [data]);

  // Today's KPIs (always plain daily, regardless of timeframe).
  const todaySolar = rows
    .filter((r) => r.reading_datetime >= todayStart)
    .reduce((s, r) => s + (+(r.daily_solar_kwh ?? 0)), 0);
  const todayGrid = rows
    .filter((r) => r.reading_datetime >= todayStart)
    .reduce((s, r) => {
      const splitTotal = (+(r.daily_solar_kwh ?? 0)) + (+(r.daily_grid_kwh ?? 0));
      const grid = +(r.daily_grid_kwh ?? 0);
      const fallback = +(r.daily_consumption_kwh ?? 0);
      return s + (splitTotal > 0 ? grid : fallback);
    }, 0);
  const todayTotal = todaySolar + todayGrid;
  const solarShare = todayTotal > 0 ? (todaySolar / todayTotal) * 100 : 0;

  // Group + label rows by selected timeframe.
  const chartData = useMemo(() => {
    const m = new Map<string, { sortKey: number; label: string; solar: number; grid: number }>();
    rows.forEach((r) => {
      const dt = new Date(r.reading_datetime);
      let bucketStart: Date;
      let label: string;
      if (timeframe === 'monthly') {
        bucketStart = startOfMonth(dt);
        label = format(bucketStart, 'MMM yyyy');
      } else if (timeframe === 'weekly') {
        bucketStart = startOfWeek(dt, { weekStartsOn: 1 });
        label = `${format(bucketStart, 'MMM d')}`;
      } else {
        bucketStart = startOfDay(dt);
        label = format(bucketStart, 'MMM d');
      }
      const key = bucketStart.toISOString();
      const splitTotal = (+(r.daily_solar_kwh ?? 0)) + (+(r.daily_grid_kwh ?? 0));
      const solar = +(r.daily_solar_kwh ?? 0);
      const grid = splitTotal > 0
        ? +(r.daily_grid_kwh ?? 0)
        : +(r.daily_consumption_kwh ?? 0);
      const cur = m.get(key) ?? {
        sortKey: bucketStart.getTime(),
        label,
        solar: 0,
        grid: 0,
      };
      cur.solar += solar;
      cur.grid += grid;
      m.set(key, cur);
    });
    return Array.from(m.values())
      .sort((a, b) => a.sortKey - b.sortKey)
      .map((v) => ({
        date: v.label,
        solar: +v.solar.toFixed(1),
        grid: +v.grid.toFixed(1),
      }));
  }, [rows, timeframe]);

  const showSolar = source !== 'grid';
  const showGrid = source !== 'solar';

  const rangeLabel =
    timeframe === 'monthly' ? 'monthly totals'
    : timeframe === 'weekly' ? 'weekly totals'
    : 'daily totals';

  return (
    <Card className="p-3" data-testid="energy-mix-card">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-1">
        <h2 className="text-sm font-semibold">
          Energy Mix · last {rangeDays}d <span className="text-muted-foreground font-normal">· {rangeLabel}</span>
        </h2>
        <span className="text-[10px] text-muted-foreground">Solar vs Grid (kWh)</span>
      </div>

      {/* Filter controls */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <FilterGroup label="View">
          <ToggleGroup
            type="single"
            size="sm"
            value={timeframe}
            onValueChange={(v) => v && setTimeframe(v as Timeframe)}
            data-testid="energy-timeframe"
          >
            <ToggleGroupItem value="daily" className="h-7 px-2 text-[11px]">Daily</ToggleGroupItem>
            <ToggleGroupItem value="weekly" className="h-7 px-2 text-[11px]">Weekly</ToggleGroupItem>
            <ToggleGroupItem value="monthly" className="h-7 px-2 text-[11px]">Monthly</ToggleGroupItem>
          </ToggleGroup>
        </FilterGroup>
        <FilterGroup label="Range">
          <ToggleGroup
            type="single"
            size="sm"
            value={String(rangeDays)}
            onValueChange={(v) => v && setRangeDays(Number(v) as RangeDays)}
            data-testid="energy-range"
          >
            <ToggleGroupItem value="7" className="h-7 px-2 text-[11px]">7d</ToggleGroupItem>
            <ToggleGroupItem value="14" className="h-7 px-2 text-[11px]">14d</ToggleGroupItem>
            <ToggleGroupItem value="30" className="h-7 px-2 text-[11px]">30d</ToggleGroupItem>
            <ToggleGroupItem value="90" className="h-7 px-2 text-[11px]">90d</ToggleGroupItem>
          </ToggleGroup>
        </FilterGroup>
        <FilterGroup label="Source">
          <ToggleGroup
            type="single"
            size="sm"
            value={source}
            onValueChange={(v) => v && setSource(v as Source)}
            data-testid="energy-source"
          >
            <ToggleGroupItem value="both" className="h-7 px-2 text-[11px]">Both</ToggleGroupItem>
            <ToggleGroupItem value="solar" className="h-7 px-2 text-[11px]">Solar</ToggleGroupItem>
            <ToggleGroupItem value="grid" className="h-7 px-2 text-[11px]">Grid</ToggleGroupItem>
          </ToggleGroup>
        </FilterGroup>
      </div>

      {/* Today KPI tiles */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        <KpiTile
          icon={Sun}
          label="Today Solar"
          value={fmtNum(todaySolar, 0)}
          accent="text-yellow-500"
          testId="energy-today-solar"
        />
        <KpiTile
          icon={Zap}
          label="Today Grid"
          value={fmtNum(todayGrid, 0)}
          accent="text-chart-6"
          testId="energy-today-grid"
        />
        <KpiTile
          icon={Zap}
          label={`Today Total${todayTotal > 0 ? ` · ${solarShare.toFixed(0)}% Solar` : ''}`}
          value={fmtNum(todayTotal, 0)}
          accent="text-foreground"
          testId="energy-today-total"
        />
      </div>

      <div className="h-44">
        {chartData.length === 0 ? (
          <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
            No power readings in the last {rangeDays} days
          </div>
        ) : (
          <ResponsiveContainer>
            <BarChart data={chartData} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
              <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
              <Tooltip
                contentStyle={{
                  background: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: 8,
                  fontSize: 11,
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {showSolar && (
                <Bar dataKey="solar" stackId="energy" fill="#facc15" name="Solar (kWh)" />
              )}
              {showGrid && (
                <Bar dataKey="grid" stackId="energy" fill="hsl(var(--chart-6))" name="Grid (kWh)" />
              )}
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function KpiTile({
  icon: Icon,
  label,
  value,
  accent,
  testId,
}: {
  icon: any;
  label: string;
  value: string;
  accent: string;
  testId: string;
}) {
  return (
    <div className="rounded-md border bg-card p-2" data-testid={testId}>
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        <Icon className={`h-3 w-3 ${accent}`} />
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1 font-mono-num text-base text-foreground">
        {value}
        <span className="text-[10px] font-sans text-muted-foreground ml-1">kWh</span>
      </div>
    </div>
  );
}
