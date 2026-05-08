import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAppStore } from '@/store/appStore';
import { usePlants } from '@/hooks/usePlants';
import { fmtNum, nrwColor } from '@/lib/calculations';
import { StatusPill } from '@/components/StatusPill';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { format, subDays, startOfDay } from 'date-fns';
import {
  Droplet, Activity, Zap, FlaskConical, AlertTriangle, Gauge, Thermometer,
  Waves, Cloud, Receipt, Banknote, LayoutGrid, ListCollapse, ExternalLink,
  ArrowUpRight, ArrowDownRight, Minus, CalendarDays,
} from 'lucide-react';
import { useTrainAutoOffline } from '@/hooks/useTrainAutoOffline';
import { DowntimeEventsModal } from '@/components/DowntimeEventsModal';
import { EnergyMixCard } from '@/components/EnergyMixCard';
import { BlendingVolumeCard } from '@/components/BlendingVolumeCard';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { calc } from '@/lib/calculations';
import {
  StatCard, PerWellSourceCard, ClusterHeader,
} from '@/components/dashboard/StatCard';
import {
  ClusterCharts, TrendModal,
} from '@/components/dashboard/TrendChart';
import { PowerChart } from '@/components/dashboard/PowerChart';
import {
  DashboardViewMode, VIEW_MODE_KEY, readSavedViewMode, pctDelta,
  OVERVIEW_CHART_METRICS, QUALITY_CHART_METRICS, COST_CHART_METRICS,
} from '@/components/dashboard/types';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

// ─── DataSummaryModal ─────────────────────────────────────────────────────────
// Full-screen pivot-table popup. Rows = dates, columns = individual
// locators (consumption) or product meters (production). Non-retractable —
// closes only via the ✕ button or clicking outside the dialog.

type SummaryTab = 'consumption' | 'production';

/**
 * Replacement-aware delta pivot — mirrors TrendChart.tsx `computeEntityDeltas`.
 * Groups readings by entityKeyField, walks them chronologically per entity and:
 *   • is_meter_replacement row     → delta 0, set afterRepl flag
 *   • first row after replacement  → delta 0, clear flag
 *   • normal row w/ dailyVolumeField → use that value (clamped ≥ 0)
 *   • normal row w/o dailyVolumeField → current − last (clamped ≥ 0)
 *   • no predecessor yet           → current − previous_reading if available
 * Returns Map<dateKey yyyy-MM-dd, Map<entityKey, summed volume>>.
 */
function computePivotFromReadings(
  readings: any[],
  entityKeyField: string,
  dailyVolumeField: string | null,
): Map<string, Map<string, number>> {
  const byEntity = new Map<string, any[]>();
  readings.forEach((r) => {
    const k = r[entityKeyField] ?? '__';
    if (!byEntity.has(k)) byEntity.set(k, []);
    byEntity.get(k)!.push(r);
  });
  const pivot = new Map<string, Map<string, number>>();
  byEntity.forEach((rows, entityKey) => {
    const sorted = [...rows].sort(
      (a, b) => new Date(a.reading_datetime).getTime() - new Date(b.reading_datetime).getTime(),
    );
    const lastReading = new Map<string, number>();
    const afterRepl   = new Set<string>();
    sorted.forEach((r) => {
      const isMR    = !!r.is_meter_replacement;
      const dateKey = format(new Date(r.reading_datetime), 'yyyy-MM-dd');
      if (!pivot.has(dateKey)) pivot.set(dateKey, new Map());
      if (isMR) {
        lastReading.set(entityKey, +r.current_reading);
        afterRepl.add(entityKey);
        return;
      }
      if (afterRepl.has(entityKey)) {
        lastReading.set(entityKey, +r.current_reading);
        afterRepl.delete(entityKey);
        return;
      }
      let delta = 0;
      if (dailyVolumeField && r[dailyVolumeField] != null) {
        delta = Math.max(0, +r[dailyVolumeField]);
        lastReading.set(entityKey, +r.current_reading);
      } else if (!lastReading.has(entityKey)) {
        if (r.previous_reading != null && r.current_reading != null)
          delta = Math.max(0, +r.current_reading - +r.previous_reading);
        lastReading.set(entityKey, +r.current_reading);
      } else {
        delta = Math.max(0, +r.current_reading - lastReading.get(entityKey)!);
        lastReading.set(entityKey, +r.current_reading);
      }
      pivot.get(dateKey)!.set(entityKey, (pivot.get(dateKey)!.get(entityKey) ?? 0) + delta);
    });
  });
  return pivot;
}

/** Sum all entity values in a pivot for one date key. */
function pivotDayTotal(pivot: Map<string, Map<string, number>>, dateKey: string): number {
  let total = 0;
  pivot.get(dateKey)?.forEach((v) => { total += v; });
  return total;
}

function summaryPctDelta(today: number, yesterday: number): number | null {
  if (!yesterday) return null;
  return +((((today - yesterday) / yesterday) * 100).toFixed(1));
}

function DeltaIcon({ pct }: { pct: number | null }) {
  if (pct == null) return <Minus className="h-3 w-3 text-muted-foreground" />;
  if (pct > 0) return <ArrowUpRight className="h-3 w-3 text-emerald-500" />;
  return <ArrowDownRight className="h-3 w-3 text-rose-500" />;
}

function pctLabel(pct: number | null) {
  if (pct == null) return '—';
  return `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

interface DataSummaryModalProps {
  open: boolean;
  onClose: () => void;
  plantIds: string[];
  plantCodeById: Map<string, string>;
}

function DataSummaryModal({ open, onClose, plantIds, plantCodeById }: DataSummaryModalProps) {
  const [tab, setTab] = useState<SummaryTab>('consumption');

  // Date range: default last 7 days
  const todayStr = format(new Date(), 'yyyy-MM-dd');
  const [fromStr, setFromStr] = useState<string>(format(subDays(new Date(), 6), 'yyyy-MM-dd'));
  const [toStr,   setToStr]   = useState<string>(todayStr);

  const startISO = new Date(fromStr + 'T00:00:00').toISOString();
  const endISO   = new Date(toStr   + 'T23:59:59').toISOString();

  // ── Locators (meta) ────────────────────────────────────────────────────────
  const { data: locators } = useQuery({
    queryKey: ['dsm-locators', plantIds],
    queryFn: async () => {
      if (!plantIds.length) return [];
      const { data } = await supabase
        .from('locators').select('id,name,code,plant_id')
        .in('plant_id', plantIds).eq('status', 'Active');
      return (data ?? []) as any[];
    },
    enabled: open && plantIds.length > 0,
  });

  const locatorIds = useMemo(() => (locators ?? []).map((l: any) => l.id), [locators]);

  const { data: consReadings, isLoading: consLoading } = useQuery({
    queryKey: ['dsm-cons-readings', locatorIds, fromStr, toStr],
    queryFn: async () => {
      if (!locatorIds.length) return [];
      const { data } = await supabase
        .from('locator_readings')
        .select('locator_id,daily_volume,current_reading,previous_reading,reading_datetime,is_meter_replacement')
        .in('locator_id', locatorIds)
        .gte('reading_datetime', startISO)
        .lte('reading_datetime', endISO)
        .order('reading_datetime', { ascending: true });
      return (data ?? []) as any[];
    },
    enabled: open && locatorIds.length > 0,
  });

  // ── Product meters (meta) ──────────────────────────────────────────────────
  const { data: productMeters } = useQuery({
    queryKey: ['dsm-product-meters', plantIds],
    queryFn: async () => {
      if (!plantIds.length) return [];
      const { data } = await (supabase.from('product_meters' as any) as any)
        .select('id,name,plant_id').in('plant_id', plantIds);
      return (data ?? []) as any[];
    },
    enabled: open && plantIds.length > 0,
  });

  const meterIds = useMemo(() => (productMeters ?? []).map((m: any) => m.id), [productMeters]);

  const { data: prodReadings, isLoading: prodLoading } = useQuery({
    queryKey: ['dsm-prod-readings', meterIds, fromStr, toStr],
    queryFn: async () => {
      if (!meterIds.length) return [];
      const { data } = await (supabase.from('product_meter_readings' as any) as any)
        .select('meter_id,daily_volume,current_reading,previous_reading,reading_datetime,is_meter_replacement')
        .in('meter_id', meterIds)
        .gte('reading_datetime', startISO)
        .lte('reading_datetime', endISO)
        .order('reading_datetime', { ascending: true });
      return (data ?? []) as any[];
    },
    enabled: open && meterIds.length > 0,
  });

  // ── Build pivot: rows = dates, columns = entities ──────────────────────────
  // computePivotFromReadings mirrors TrendChart computeEntityDeltas so
  // meter-replacement rows and their successors are correctly zeroed.
  const consPivot = useMemo(() => {
    const sortedLocs = [...(locators ?? [])].sort((a, b) => {
      const pa = plantCodeById.get(a.plant_id) ?? '';
      const pb = plantCodeById.get(b.plant_id) ?? '';
      return pa.localeCompare(pb) || (a.name ?? '').localeCompare(b.name ?? '');
    });
    const pivot = computePivotFromReadings(consReadings ?? [], 'locator_id', 'daily_volume');

    // Fill every date in the selected range — not just dates that have readings.
    // Without this, days with zero consumption are invisible in the table.
    const allDates: string[] = [];
    const cur = new Date(fromStr + 'T00:00:00');
    const end = new Date(toStr   + 'T00:00:00');
    while (cur <= end) {
      allDates.push(format(cur, 'yyyy-MM-dd'));
      cur.setDate(cur.getDate() + 1);
    }
    return { dates: allDates, entities: sortedLocs, pivot };
  }, [locators, consReadings, plantCodeById, fromStr, toStr]);

  const prodPivot = useMemo(() => {
    const sortedMeters = [...(productMeters ?? [])].sort((a, b) => {
      const pa = plantCodeById.get(a.plant_id) ?? '';
      const pb = plantCodeById.get(b.plant_id) ?? '';
      return pa.localeCompare(pb) || (a.name ?? '').localeCompare(b.name ?? '');
    });
    const pivot = computePivotFromReadings(prodReadings ?? [], 'meter_id', 'daily_volume');

    // Fill every date in the selected range — not just dates with readings.
    const allDates2: string[] = [];
    const cur2 = new Date(fromStr + 'T00:00:00');
    const end2 = new Date(toStr   + 'T00:00:00');
    while (cur2 <= end2) {
      allDates2.push(format(cur2, 'yyyy-MM-dd'));
      cur2.setDate(cur2.getDate() + 1);
    }
    return { dates: allDates2, entities: sortedMeters, pivot };
  }, [productMeters, prodReadings, plantCodeById, fromStr, toStr]);

  const isLoading = tab === 'consumption' ? consLoading : prodLoading;
  const { dates, entities, pivot } = tab === 'consumption' ? consPivot : prodPivot;
  const entityIdField = tab === 'consumption' ? 'id' : 'id';

  // Column totals (sum per entity across all dates)
  const colTotals = useMemo(() =>
    entities.map((e) =>
      dates.reduce((s, d) => s + (pivot.get(d)?.get(e.id) ?? 0), 0),
    ),
  [entities, dates, pivot]);

  // Row totals (sum per date across all entities)
  const rowTotals = useMemo(() =>
    dates.map((d) =>
      entities.reduce((s, e) => s + (pivot.get(d)?.get(e.id) ?? 0), 0),
    ),
  [entities, dates, pivot]);

  const grandTotal = colTotals.reduce((s, v) => s + v, 0);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent
        className="max-w-[95vw] w-full max-h-[92vh] flex flex-col p-0 gap-0 overflow-hidden"
        data-testid="data-summary-modal"
      >
        {/* ── Header ── */}
        <DialogHeader className="px-5 pt-4 pb-3 border-b shrink-0">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <DialogTitle className="text-base font-semibold flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary" />
              Data Summary
            </DialogTitle>

            {/* Date range picker */}
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <CalendarDays className="h-3.5 w-3.5 shrink-0" />
              <input
                type="date"
                value={fromStr}
                max={toStr}
                onChange={(e) => e.target.value && setFromStr(e.target.value)}
                className="bg-transparent border border-border rounded px-1.5 py-0.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40"
              />
              <span>→</span>
              <input
                type="date"
                value={toStr}
                min={fromStr}
                max={todayStr}
                onChange={(e) => e.target.value && setToStr(e.target.value)}
                className="bg-transparent border border-border rounded px-1.5 py-0.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40"
              />
            </div>
          </div>
        </DialogHeader>

        {/* ── Option toggles: Consumption / Production ── */}
        <div className="flex border-b shrink-0 px-5 bg-muted/20">
          {(['consumption', 'production'] as SummaryTab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={[
                'px-5 py-2.5 text-xs font-semibold border-b-2 -mb-px transition-colors',
                tab === t
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >
              {t === 'consumption' ? (
                <span className="flex items-center gap-1.5"><Receipt className="h-3 w-3" />Consumption</span>
              ) : (
                <span className="flex items-center gap-1.5"><Droplet className="h-3 w-3" />Production</span>
              )}
            </button>
          ))}
        </div>

        {/* ── Body: horizontal pivot table ── */}
        <div className="flex-1 overflow-auto">
          {isLoading && (
            <div className="flex items-center justify-center h-32 text-xs text-muted-foreground">Loading…</div>
          )}
          {!isLoading && entities.length === 0 && (
            <div className="flex items-center justify-center h-32 text-xs text-muted-foreground">
              No {tab === 'consumption' ? 'locators' : 'product meters'} found.
            </div>
          )}
          {!isLoading && entities.length > 0 && dates.length === 0 && (
            <div className="flex items-center justify-center h-32 text-xs text-muted-foreground">
              No readings in this date range.
            </div>
          )}
          {!isLoading && entities.length > 0 && dates.length > 0 && (
            <table className="w-full text-[11px] border-collapse" data-testid="dsm-pivot-table">
              <thead className="sticky top-0 z-20">
                {/* Entity name header row */}
                <tr className="bg-muted/95 backdrop-blur-sm">
                  {/* Sticky Date column */}
                  <th className="sticky left-0 z-30 bg-muted/95 px-3 py-2 text-left font-semibold text-muted-foreground whitespace-nowrap border-b border-r border-border min-w-[100px]">
                    Date
                  </th>
                  {entities.map((e, i) => (
                    <th
                      key={e.id}
                      className="px-2 py-2 text-center font-semibold text-muted-foreground whitespace-nowrap border-b border-border min-w-[90px]"
                      title={`${plantCodeById.get(e.plant_id) ?? ''} · ${e.name ?? e.code ?? e.id}`}
                    >
                      <div className="truncate max-w-[110px] mx-auto">
                        {e.name ?? e.code ?? `#${i + 1}`}
                      </div>
                      {plantCodeById.get(e.plant_id) && (
                        <div className="text-[9px] font-normal text-muted-foreground/70 truncate">
                          {plantCodeById.get(e.plant_id)}
                        </div>
                      )}
                    </th>
                  ))}
                  <th className="sticky right-0 z-30 bg-teal-50/95 dark:bg-teal-950/60 px-3 py-2 text-right font-bold text-teal-700 dark:text-teal-300 whitespace-nowrap border-b border-l border-border min-w-[90px]">
                    Total (m³)
                  </th>
                </tr>

                {/* Column totals sub-header */}
                <tr className="bg-teal-50/60 dark:bg-teal-950/20">
                  <td className="sticky left-0 z-30 bg-teal-50/60 dark:bg-teal-950/20 px-3 py-1.5 font-semibold text-teal-700 dark:text-teal-300 whitespace-nowrap border-b border-r border-border text-[10px]">
                    TOTAL
                  </td>
                  {colTotals.map((tot, i) => (
                    <td key={entities[i].id} className="px-2 py-1.5 text-center font-semibold font-mono-num text-teal-700 dark:text-teal-300 border-b border-border tabular-nums">
                      {tot > 0 ? tot.toLocaleString(undefined, { maximumFractionDigits: 1 }) : <span className="text-muted-foreground/50">—</span>}
                    </td>
                  ))}
                  <td className="sticky right-0 z-30 bg-teal-50/60 dark:bg-teal-950/20 px-3 py-1.5 text-right font-bold font-mono-num text-teal-700 dark:text-teal-300 border-b border-l border-border tabular-nums">
                    {grandTotal.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                  </td>
                </tr>
              </thead>

              <tbody>
                {[...dates].reverse().map((date, di) => {
                  const rowVols = entities.map((e) => pivot.get(date)?.get(e.id) ?? null);
                  const rowTot = rowTotals[dates.length - 1 - di];
                  const isEven = di % 2 === 0;
                  return (
                    <tr
                      key={date}
                      className={isEven ? 'bg-background hover:bg-muted/20' : 'bg-muted/10 hover:bg-muted/30'}
                    >
                      <td className={[
                        'sticky left-0 z-10 px-3 py-1.5 font-medium text-muted-foreground whitespace-nowrap border-r border-border',
                        isEven ? 'bg-background' : 'bg-muted/10',
                      ].join(' ')}>
                        {format(new Date(date + 'T12:00:00'), 'MMM d, yyyy')}
                      </td>
                      {rowVols.map((vol, ei) => (
                        <td key={entities[ei].id} className="px-2 py-1.5 text-right font-mono-num tabular-nums border-border">
                          {vol != null && vol > 0
                            ? vol.toLocaleString(undefined, { maximumFractionDigits: 1 })
                            : <span className="text-muted-foreground/40">—</span>
                          }
                        </td>
                      ))}
                      <td className={[
                        'sticky right-0 z-10 px-3 py-1.5 text-right font-semibold font-mono-num tabular-nums border-l border-border',
                        tab === 'consumption' ? 'text-highlight' : 'text-primary',
                        isEven ? 'bg-background' : 'bg-muted/10',
                      ].join(' ')}>
                        {rowTot > 0 ? rowTot.toLocaleString(undefined, { maximumFractionDigits: 1 }) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Footer legend ── */}
        {!isLoading && entities.length > 0 && (
          <div className="px-5 py-2 border-t shrink-0 flex items-center gap-4 text-[10px] text-muted-foreground bg-muted/20">
            {tab === 'consumption'
              ? <><Receipt className="h-3 w-3 text-highlight" /> Consumption — delta volume (m³) per locator per day</>
              : <><Droplet className="h-3 w-3 text-primary" /> Production — delta volume (m³) per product meter per day</>
            }
            <span className="ml-auto">{entities.length} {tab === 'consumption' ? 'locators' : 'meters'} · {dates.length} days</span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { selectedPlantId } = useAppStore();
  const { data: plants } = usePlants();
  const [modal, setModal] = useState<null | { metric: string; title: string }>(null);
  const [downtimeOpen, setDowntimeOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);

  // View mode controls how trend graphs surface on the dashboard.
  // See `components/dashboard/types.ts` for definitions. Lazy-init
  // from localStorage so the user's preference survives reload
  // without a flash of "inline".
  const [viewMode, setViewMode] = useState<DashboardViewMode>(readSavedViewMode);
  // In `sections` mode, this holds the metric key whose chart is
  // currently fold-open. Single-open behaviour — clicking another KPI
  // auto-collapses the previous. `inline` mode shows everything;
  // `popup` mode never sets this (it routes through `modal` instead).
  const [expandedMetric, setExpandedMetric] = useState<string | null>(null);
  const persistViewMode = (m: DashboardViewMode) => {
    setViewMode(m);
    setExpandedMetric(null);
    setModal(null);
    try { window.localStorage.setItem(VIEW_MODE_KEY, m); } catch (err) {
      // Safari private mode / quota errors — view-mode just won't persist.
      // eslint-disable-next-line no-console
      console.warn('[Dashboard] could not persist view mode preference:', err);
    }
  };
  // Returns the click handler for chart-bearing KPI cards. Behaviour
  // depends on the current view mode:
  //   • inline   → no click action (chart is already on screen below)
  //   • sections → toggle this metric's collapsible chart (single-open)
  //   • popup    → open the TrendModal (existing behaviour)
  const handleMetricClick = (metric: string, title: string): (() => void) | undefined => {
    if (viewMode === 'inline') return undefined;
    return () => {
      if (viewMode === 'sections') {
        setExpandedMetric((prev) => (prev === metric ? null : metric));
      } else {
        setModal({ metric, title });
      }
    };
  };

  const visiblePlants = useMemo(
    () => (selectedPlantId ? plants?.filter((p) => p.id === selectedPlantId) : plants),
    [plants, selectedPlantId],
  );
  const plantIds = visiblePlants?.map((p) => p.id) ?? [];

  // Bug 4 fix: build today/yesterday boundaries in UTC using the local calendar date,
  // so that readings entered at e.g. 08:00 PST (= 00:00 UTC) are not pushed into yesterday.
  // We construct YYYY-MM-DD from local time and then parse it as a UTC midnight to avoid
  // the double-offset problem that startOfDay(new Date()).toISOString() causes in UTC+8.
  const _localDateStr = format(new Date(), 'yyyy-MM-dd');          // local calendar date
  const today     = new Date(_localDateStr + 'T00:00:00').toISOString();   // local midnight → ISO
  const yesterday = new Date(format(subDays(new Date(), 1), 'yyyy-MM-dd') + 'T00:00:00').toISOString();

  // ----- Today aggregates from raw tables -----
  //
  // IMPORTANT: locator_readings and well_readings do NOT have a plant_id column.
  // Filtering them with .in('plant_id', plantIds) returns zero rows — which is
  // why the stat cards were showing 0 m³. We must first resolve the entity IDs
  // (locator_id / well_id) for this plant, then query by those IDs.

  const { data: _locatorIds } = useQuery({
    queryKey: ['dash-locator-ids', plantIds],
    queryFn: async () => {
      if (!plantIds.length) return [] as string[];
      const { data } = await supabase
        .from('locators').select('id').in('plant_id', plantIds).eq('status', 'Active');
      return (data ?? []).map((l: any) => l.id as string);
    },
    enabled: plantIds.length > 0,
  });

  const { data: _wellIds } = useQuery({
    queryKey: ['dash-well-ids', plantIds],
    queryFn: async () => {
      if (!plantIds.length) return [] as string[];
      const { data } = await supabase.from('wells').select('id').in('plant_id', plantIds);
      return (data ?? []).map((w: any) => w.id as string);
    },
    enabled: plantIds.length > 0,
  });

  const { data: todayLocators } = useQuery({
    queryKey: ['dash-loc-today', _locatorIds, today],
    queryFn: async () => {
      if (!_locatorIds?.length) return [];
      const { data } = await supabase
        .from('locator_readings')
        .select('locator_id,daily_volume,current_reading,previous_reading,reading_datetime,is_meter_replacement')
        .in('locator_id', _locatorIds)
        .gte('reading_datetime', today)
        .order('reading_datetime', { ascending: true });
      return (data ?? []) as any[];
    },
    enabled: (_locatorIds?.length ?? 0) > 0,
  });

  const { data: todayWells } = useQuery({
    queryKey: ['dash-wells-today', _wellIds, today],
    queryFn: async () => {
      if (!_wellIds?.length) return [];
      const { data } = await supabase
        .from('well_readings')
        .select('well_id,daily_volume,current_reading,previous_reading,reading_datetime,is_meter_replacement')
        .in('well_id', _wellIds)
        .gte('reading_datetime', today)
        .order('reading_datetime', { ascending: true });
      return (data ?? []) as any[];
    },
    enabled: (_wellIds?.length ?? 0) > 0,
  });
  // Production = sum of Product Meter deltas (treated/distributed water)
  const { data: todayProductMeters } = useQuery({
    queryKey: ['dash-product-meters-today', plantIds],
    queryFn: async () => {
      if (!plantIds.length) return [];
      const { data: meters } = await (supabase.from('product_meters' as any) as any)
        .select('id').in('plant_id', plantIds);
      const meterIds = (meters ?? []).map((m: any) => m.id);
      if (!meterIds.length) return [];
      const { data } = await (supabase.from('product_meter_readings' as any) as any)
        .select('meter_id,daily_volume,current_reading,previous_reading,reading_datetime,is_meter_replacement')
        .in('meter_id', meterIds)
        .gte('reading_datetime', today)
        .order('reading_datetime', { ascending: true });
      return (data ?? []) as any[];
    },
    enabled: plantIds.length > 0,
  });
  const { data: todayPower } = useQuery({
    queryKey: ['dash-power-today', plantIds],
    queryFn: async () => plantIds.length
      ? (await supabase.from('power_readings').select('daily_consumption_kwh,plant_id')
          .in('plant_id', plantIds).gte('reading_datetime', today)).data ?? []
      : [],
    enabled: plantIds.length > 0,
  });
  // ----- Yesterday aggregates (for trend deltas on highlighted KPIs) -----
  const { data: yLocators } = useQuery({
    queryKey: ['dash-loc-yest', _locatorIds, yesterday, today],
    queryFn: async () => {
      if (!_locatorIds?.length) return [];
      const { data } = await supabase
        .from('locator_readings')
        .select('locator_id,daily_volume,current_reading,previous_reading,reading_datetime,is_meter_replacement')
        .in('locator_id', _locatorIds)
        .gte('reading_datetime', yesterday)
        .lt('reading_datetime', today)
        .order('reading_datetime', { ascending: true });
      return (data ?? []) as any[];
    },
    enabled: (_locatorIds?.length ?? 0) > 0,
  });
  const { data: yWells } = useQuery({
    queryKey: ['dash-wells-yest', _wellIds, yesterday, today],
    queryFn: async () => {
      if (!_wellIds?.length) return [];
      const { data } = await supabase
        .from('well_readings')
        .select('well_id,daily_volume,current_reading,previous_reading,reading_datetime,is_meter_replacement')
        .in('well_id', _wellIds)
        .gte('reading_datetime', yesterday)
        .lt('reading_datetime', today)
        .order('reading_datetime', { ascending: true });
      return (data ?? []) as any[];
    },
    enabled: (_wellIds?.length ?? 0) > 0,
  });
  // Yesterday product meters for production trend delta
  const { data: yProductMeters } = useQuery({
    queryKey: ['dash-product-meters-yest', plantIds],
    queryFn: async () => {
      if (!plantIds.length) return [];
      const { data: meters } = await (supabase.from('product_meters' as any) as any)
        .select('id').in('plant_id', plantIds);
      const meterIds = (meters ?? []).map((m: any) => m.id);
      if (!meterIds.length) return [];
      const { data } = await (supabase.from('product_meter_readings' as any) as any)
        .select('meter_id,daily_volume,current_reading,previous_reading,reading_datetime,is_meter_replacement')
        .in('meter_id', meterIds)
        .gte('reading_datetime', yesterday)
        .lt('reading_datetime', today)
        .order('reading_datetime', { ascending: true });
      return (data ?? []) as any[];
    },
    enabled: plantIds.length > 0,
  });
  const { data: yPower } = useQuery({
    queryKey: ['dash-power-yest', plantIds],
    queryFn: async () => plantIds.length
      ? (await supabase.from('power_readings').select('daily_consumption_kwh')
          .in('plant_id', plantIds).gte('reading_datetime', yesterday).lt('reading_datetime', today)).data ?? []
      : [],
    enabled: plantIds.length > 0,
  });
  const { data: latestRO } = useQuery({
    queryKey: ['dash-ro-recent', plantIds],
    queryFn: async () => plantIds.length
      ? (await supabase.from('ro_train_readings')
          .select('permeate_tds,feed_tds,dp_psi,recovery_pct,permeate_ph,turbidity_ntu,plant_id,train_number,reading_datetime')
          .in('plant_id', plantIds).gte('reading_datetime', subDays(new Date(), 1).toISOString())
          .order('reading_datetime', { ascending: false })).data ?? []
      : [],
    enabled: plantIds.length > 0,
  });
  // Today's production cost (chem + power)
  const { data: todayCosts } = useQuery({
    queryKey: ['dash-costs-today', plantIds],
    queryFn: async () => plantIds.length
      ? (await supabase.from('production_costs').select('chem_cost,power_cost,total_cost,plant_id')
          .in('plant_id', plantIds).eq('cost_date', format(new Date(), 'yyyy-MM-dd'))).data ?? []
      : [],
    enabled: plantIds.length > 0,
  });
  // Latest daily summary fallback per plant (today first, else latest)
  const { data: dailySummary } = useQuery({
    queryKey: ['dash-summary-recent', plantIds],
    queryFn: async () => plantIds.length
      ? (await supabase.from('daily_plant_summary').select('*').in('plant_id', plantIds)
          .order('summary_date', { ascending: false }).limit(plantIds.length * 5)).data ?? []
      : [],
    enabled: plantIds.length > 0,
  });

  // ── Stat card aggregates ────────────────────────────────────────────────────
  // Uses computePivotFromReadings (same replacement-aware logic as TrendChart)
  // so meter-replacement spikes don't inflate today's totals.
  const _todayKey     = format(new Date(), 'yyyy-MM-dd');
  const _yesterdayKey = format(subDays(new Date(), 1), 'yyyy-MM-dd');

  const rawWaterVol = useMemo(() => pivotDayTotal(
    computePivotFromReadings(todayWells ?? [], 'well_id', 'daily_volume'), _todayKey,
  ), [todayWells, _todayKey]);

  const production = useMemo(() => pivotDayTotal(
    computePivotFromReadings(todayProductMeters ?? [], 'meter_id', 'daily_volume'), _todayKey,
  ), [todayProductMeters, _todayKey]);

  const consumption = useMemo(() => pivotDayTotal(
    computePivotFromReadings(todayLocators ?? [], 'locator_id', 'daily_volume'), _todayKey,
  ), [todayLocators, _todayKey]);

  const kwh = (todayPower ?? []).reduce((s: number, r: any) => s + (r.daily_consumption_kwh ?? 0), 0);

  // NRW uses Production (product meter output) vs Consumption (locator billed)
  const nrw = calc.nrw(production, consumption);
  const pv = calc.pvRatio(kwh, production);

  const yRawWaterVol = useMemo(() => pivotDayTotal(
    computePivotFromReadings(yWells ?? [], 'well_id', 'daily_volume'), _yesterdayKey,
  ), [yWells, _yesterdayKey]);

  const yProduction = useMemo(() => pivotDayTotal(
    computePivotFromReadings(yProductMeters ?? [], 'meter_id', 'daily_volume'), _yesterdayKey,
  ), [yProductMeters, _yesterdayKey]);

  const yConsumption = useMemo(() => pivotDayTotal(
    computePivotFromReadings(yLocators ?? [], 'locator_id', 'daily_volume'), _yesterdayKey,
  ), [yLocators, _yesterdayKey]);

  const yKwh = (yPower ?? []).reduce((s: number, r: any) => s + (r.daily_consumption_kwh ?? 0), 0);
  const dProduction = pctDelta(production, yProduction);
  const dConsumption = pctDelta(consumption, yConsumption);
  const dRawWater = pctDelta(rawWaterVol, yRawWaterVol);
  const dKwh = pctDelta(kwh, yKwh);

  const nrwBreached = nrw != null && nrw > 20;
  // Bug 5: RO averages are now computed after roByTrain useMemo below (deduped per train).

  // Per-train latest snapshot — group `latestRO` by (plant_id, train_number)
  // and keep the most recent row per train (the query is already ordered
  // reading_datetime DESC, so the first row we encounter per key wins).
  // Used by the "Raw TDS / Raw NTU per train" breakdown lists in Quality.
  // Note: TDS and NTU are recorded at the RO-train level in this schema,
  // not the well level — we surface them here labelled as "Train N" with
  // the plant code so the user knows what they're looking at.
  const roByTrain = useMemo(() => {
    const seen = new Set<string>();
    const rows: any[] = [];
    (latestRO as any[] | undefined ?? []).forEach((r) => {
      const key = `${r.plant_id}__${r.train_number ?? '?'}`;
      if (seen.has(key)) return;
      seen.add(key);
      rows.push(r);
    });
    rows.sort((a, b) => {
      // Sort by plant_id then train_number for stable rendering across re-renders.
      if (a.plant_id !== b.plant_id) return String(a.plant_id).localeCompare(String(b.plant_id));
      return (a.train_number ?? 0) - (b.train_number ?? 0);
    });
    return rows;
  }, [latestRO]);

  // Bug 5 fix: recompute RO averages from deduplicated roByTrain so trains with more
  // readings per 24h window don't inflate/skew the aggregate values.
  const avgPermTds = roByTrain.length
    ? +(roByTrain.reduce((s, r) => s + (r.permeate_tds ?? 0), 0) / roByTrain.length).toFixed(0)
    : null;
  const avgFeedTds = roByTrain.length
    ? +(roByTrain.reduce((s, r) => s + (r.feed_tds ?? 0), 0) / roByTrain.length).toFixed(0)
    : null;
  const avgRecovery = roByTrain.length
    ? +(roByTrain.reduce((s, r) => s + (r.recovery_pct ?? 0), 0) / roByTrain.length).toFixed(1)
    : null;
  const avgTurb = roByTrain.length
    ? +(roByTrain.reduce((s, r) => s + (r.turbidity_ntu ?? 0), 0) / roByTrain.length).toFixed(2)
    : null;
  // Lookup helper for plant codes inside per-train rows. Falls back to the
  // raw plant_id when the plant list hasn't loaded yet so we never render
  // a blank label.
  const plantCodeById = useMemo(() => {
    const m = new Map<string, string>();
    (plants ?? []).forEach((p: any) => m.set(p.id, p.code ?? p.name ?? p.id));
    return m;
  }, [plants]);

  // Costs aggregate (today). Fallback to most recent daily_plant_summary row per plant for missing fields.
  const chemCost = (todayCosts ?? []).reduce((s, r: any) => s + (+r.chem_cost || 0), 0);
  const powerCost = (todayCosts ?? []).reduce((s, r: any) => s + (+r.power_cost || 0), 0);
  const productionCost = chemCost + powerCost;

  // Pull latest daily_plant_summary per plant (for blending, downtime, raw water)
  const latestPerPlant = useMemo(() => {
    const m = new Map<string, any>();
    (dailySummary ?? []).forEach((r: any) => { if (!m.has(r.plant_id)) m.set(r.plant_id, r); });
    return Array.from(m.values());
  }, [dailySummary]);
  const blending = latestPerPlant.reduce((s, r: any) => s + (+r.blending_m3 || 0), 0);
  const rawWater = latestPerPlant.reduce((s, r: any) => s + (+r.raw_water_consumption_m3 || 0), 0);

  const { data: chemInv } = useQuery({
    queryKey: ['dash-chem', plantIds],
    queryFn: async () => plantIds.length
      ? (await supabase.from('chemical_inventory').select('*').in('plant_id', plantIds)).data ?? []
      : [],
    enabled: plantIds.length > 0,
  });

  const trainGaps = useTrainAutoOffline(plantIds);

  // Legacy RO/chem alerts (still useful, live-computed)
  const localAlerts: { tone: 'danger' | 'warn'; text: string }[] = [];
  trainGaps.forEach((g) => localAlerts.push({ tone: 'warn', text: `Train ${g.train_number} no reading ${g.hours_gap.toFixed(1)}h — auto-flagged Offline` }));
  (latestRO ?? []).forEach((r: any) => {
    if (r.dp_psi >= 40) localAlerts.push({ tone: 'danger', text: `DP alert: ${r.dp_psi} psi` });
    if (r.permeate_tds >= 600) localAlerts.push({ tone: 'danger', text: `TDS alert: ${r.permeate_tds} ppm` });
    if (r.permeate_ph != null && (r.permeate_ph < 6.5 || r.permeate_ph > 8.5)) localAlerts.push({ tone: 'warn', text: `pH out of range: ${r.permeate_ph}` });
  });
  (chemInv ?? []).forEach((c: any) => {
    if (c.current_stock < c.low_stock_threshold) localAlerts.push({ tone: 'warn', text: `Low stock: ${c.chemical_name}` });
  });

  // Unified alerts feed (downtime / blending / recovery) served from backend
  const BASE = (import.meta.env.REACT_APP_BACKEND_URL as string) || '';
  const { data: feed } = useQuery<{ count: number; alerts: any[] }>({
    queryKey: ['alerts-feed', selectedPlantId],
    queryFn: async () => {
      try {
        const qs = new URLSearchParams({ days: '30' });
        if (selectedPlantId) qs.set('plant_id', selectedPlantId);
        const res = await fetch(`${BASE}/api/alerts/feed?${qs.toString()}`);
        if (!res.ok) return { count: 0, alerts: [] };
        return res.json();
      } catch {
        return { count: 0, alerts: [] };
      }
    },
    refetchInterval: 60_000,
    retry: false,
  });
  const feedAlerts = feed?.alerts ?? [];

  return (
    <div className="space-y-3 animate-fade-in">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-xs text-muted-foreground">
            {selectedPlantId ? visiblePlants?.[0]?.name : `All plants (${plants?.length ?? 0})`} · Today
            {' · Production '}
            <span className="font-mono-num text-foreground">{fmtNum(production)}</span>
            <span className="ml-0.5">m³</span>
            {' · '}
            <button
              onClick={() => setSummaryOpen(true)}
              className="underline underline-offset-2 text-primary hover:text-primary/80 transition-colors"
            >
              Data Summary
            </button>
          </p>
        </div>
        {/* View-mode toggle. Three layouts; choice persists to localStorage.
            Tooltip on each option spells out what it does so the icons aren't
            cryptic. The control is intentionally compact — sits in the page
            header, not the cluster headers, so switching modes never moves it. */}
        <ToggleGroup
          type="single"
          value={viewMode}
          onValueChange={(v) => v && persistViewMode(v as DashboardViewMode)}
          className="h-8 shrink-0"
          data-testid="dashboard-view-mode"
        >
          <ToggleGroupItem
            value="inline"
            className="h-7 px-2 text-[11px] data-[state=on]:bg-primary/10 data-[state=on]:text-primary"
            title="Inline — all trend graphs visible directly on the dashboard, just scroll"
            aria-label="Inline view"
          >
            <LayoutGrid className="h-3 w-3 mr-1" /> Inline
          </ToggleGroupItem>
          <ToggleGroupItem
            value="sections"
            className="h-7 px-2 text-[11px] data-[state=on]:bg-primary/10 data-[state=on]:text-primary"
            title="Sections — click a KPI card to fold/unfold its trend chart"
            aria-label="Sections view"
          >
            <ListCollapse className="h-3 w-3 mr-1" /> Sections
          </ToggleGroupItem>
          <ToggleGroupItem
            value="popup"
            className="h-7 px-2 text-[11px] data-[state=on]:bg-primary/10 data-[state=on]:text-primary"
            title="Popup — click a KPI card to open its trend chart in a dialog"
            aria-label="Popup view"
          >
            <ExternalLink className="h-3 w-3 mr-1" /> Popup
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {/* NRW threshold alert banner */}
      {nrwBreached && (
        <div
          className="flex items-start gap-2 rounded-lg border border-rose-300/70 bg-gradient-to-r from-rose-50 to-rose-100/40 px-3 py-2 dark:from-rose-950/40 dark:to-rose-900/20 dark:border-rose-900/60 cursor-pointer hover:shadow-sm transition-shadow"
          onClick={() => setModal({ metric: 'nrw', title: 'NRW trend' })}
          data-testid="nrw-banner"
          role="button"
        >
          <AlertTriangle className="h-4 w-4 text-rose-600 dark:text-rose-400 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold text-rose-700 dark:text-rose-300">
              NRW Water Loss above threshold — {nrw}%
            </div>
            <div className="text-[11px] text-rose-700/80 dark:text-rose-300/80">
              Limit is 20%. Tap to open the NRW trend and investigate.
            </div>
          </div>
        </div>
      )}

      {/* ─── Cluster 1: Overview ─── */}
      {/* Order matches the spec (2026-07): Production Cost · Locators
          Consumption · NRW · Raw Water · Blending. Raw Water and
          Blending are now two separate tiles (previously combined in a
          single card) per user request. Production volume (m³) is
          surfaced in the page subheader so the underlying NRW math
          stays visible without spending a card on it. */}
      <ClusterHeader icon={Droplet} title="Overview" accent="text-primary" />
      <div className="grid gap-2 grid-cols-2 sm:[grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
        <StatCard icon={Banknote} accent="text-accent" label="Production Cost"
          size="lg" calc
          calcTooltip="Production Cost = Power Cost + Chemical Cost (today)"
          value={`₱${fmtNum(productionCost, 0)}`}
          onClick={handleMetricClick('productionCost', 'Production Cost (Power + Chemical)')} />
        <StatCard icon={Receipt} accent="text-highlight" label="Locators Consumption" value={fmtNum(consumption)} unit="m³"
          trend={dConsumption}
          onClick={() => setSummaryOpen(true)} />
        <StatCard icon={Activity} label="NRW" value={nrw == null ? '—' : nrw} unit="%" tone={nrwColor(nrw)}
          size="lg" calc threshold="20%"
          calcTooltip="NRW % = (Production − Locator Consumption) ÷ Production × 100"
          onClick={handleMetricClick('nrw', 'NRW Trend')} />
        <StatCard icon={Droplet} accent="text-primary" label="Raw Water"
          value={fmtNum(rawWaterVol)} unit="m³" trend={dRawWater}
          onClick={handleMetricClick('rawwater', 'Raw Water (m³)')} />
        <StatCard icon={Waves} accent="text-violet-600" label="Blending"
          value={fmtNum(blending)} unit="m³" />
      </div>
      <ClusterCharts metrics={OVERVIEW_CHART_METRICS} viewMode={viewMode} expandedMetric={expandedMetric} plantIds={plantIds} clusterId="overview" />

      {/* ─── Cluster 2: Quality ─── */}
      {/* Spec order: Feed TDS · Product TDS · Raw TDS (per well source) ·
          Raw NTU (per well source). The Raw TDS / NTU tiles surface the
          aggregate headline plus a small breakdown labelled "per well
          source" — see PerWellSourceCard for the schema caveat (these
          are physically measured at the RO feed manifold which BLENDS
          multiple well sources, so each row represents one source line). */}
      <ClusterHeader icon={FlaskConical} title="Quality" accent="text-accent" subtitle="RO output" />
      <div className="grid gap-2 grid-cols-2 sm:[grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
        <StatCard icon={Gauge} label="Feed TDS" value={avgFeedTds ?? '—'} unit="ppm" />
        <StatCard icon={FlaskConical} accent="text-accent" label="Product TDS" value={avgPermTds ?? '—'} unit="ppm"
          onClick={handleMetricClick('tds', 'Permeate TDS Trend')} />
        {/* Raw TDS · per well source — aggregate value above, list below */}
        <PerWellSourceCard
          icon={Gauge}
          label="Raw TDS"
          unit="ppm"
          aggregate={avgFeedTds}
          rows={roByTrain}
          field="feed_tds"
          plantCodeById={plantCodeById}
          testId="raw-tds-per-well-source"
        />
        <PerWellSourceCard
          icon={Cloud}
          label="Raw NTU"
          unit="NTU"
          aggregate={avgTurb}
          rows={roByTrain}
          field="turbidity_ntu"
          plantCodeById={plantCodeById}
          testId="raw-ntu-per-well-source"
          decimals={2}
        />
        <StatCard icon={Thermometer} label="Recovery" value={avgRecovery ?? '—'} unit="%"
          onClick={handleMetricClick('recovery', 'Recovery Trendline')} />
      </div>
      <ClusterCharts metrics={QUALITY_CHART_METRICS} viewMode={viewMode} expandedMetric={expandedMetric} plantIds={plantIds} clusterId="quality" />

      {/* ─── Cluster 3: Production Cost (Power + Chemical) ─── */}
      {/* Spec order: Power Cost · Chemical Cost · Power kWh · PV Ratio.
          The header doubles as the section title called out in the spec. */}
      <ClusterHeader icon={Zap} title="Production Cost (Power + Chemical)" accent="text-chart-6" subtitle="Today" />
      <div className="grid gap-2 grid-cols-2 sm:[grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
        <StatCard icon={Zap} accent="text-chart-6" label="Power Cost"
          value={`₱${fmtNum(powerCost, 0)}`}
          onClick={handleMetricClick('productionCost', 'Production Cost (Power + Chemical)')} />
        <StatCard icon={FlaskConical} accent="text-highlight" label="Chemical Cost"
          value={`₱${fmtNum(chemCost, 0)}`}
          onClick={handleMetricClick('productionCost', 'Production Cost (Power + Chemical)')} />
        <StatCard icon={Zap} accent="text-chart-6" label="Power kWh" value={fmtNum(kwh)} unit="kWh"
          trend={dKwh} />
        <StatCard icon={Zap} accent="text-chart-6" label="PV Ratio" value={pv == null ? '—' : pv} unit="kWh/m³"
          calc threshold="1.2"
          calcTooltip="PV Ratio = Power kWh ÷ Production m³ (lower is more efficient)"
          onClick={handleMetricClick('pv', 'PV Ratio Trend')} />
      </div>
      <ClusterCharts metrics={COST_CHART_METRICS} viewMode={viewMode} expandedMetric={expandedMetric} plantIds={plantIds} clusterId="cost" />

      <Card className="p-3" data-testid="alerts-card">
        <div className="flex items-center gap-2 mb-2">
          <AlertTriangle className="h-4 w-4 text-danger" />
          <h2 className="text-sm font-semibold">Active Alerts</h2>
          <span className="text-[10px] text-muted-foreground">
            {feedAlerts.length + localAlerts.length} active
          </span>
          {(feedAlerts.length + localAlerts.length) > 0 && <span className="pulse-dot ml-auto" />}
        </div>

        {/* Unified feed — downtime, blending, recovery */}
        {feedAlerts.length > 0 && (
          <div className="space-y-1.5 mb-2" data-testid="alerts-feed-list">
            {feedAlerts.slice(0, 8).map((a, i) => {
              const tone = a.severity === 'high' ? 'danger'
                : a.severity === 'medium' ? 'warn'
                : a.severity === 'low' ? 'accent'
                : 'info' as const;
              const kindLabel = a.kind === 'downtime' ? 'Downtime'
                : a.kind === 'blending' ? 'Blending'
                : 'Recovery';
              return (
                <button
                  key={`feed-${i}`}
                  className="w-full text-left flex items-start gap-2 text-xs hover:bg-muted/40 rounded px-1 py-1"
                  onClick={() => {
                    if (a.kind === 'downtime') setDowntimeOpen(true);
                  }}
                  data-testid={`alert-row-${a.kind}-${i}`}
                >
                  <StatusPill tone={tone as any}>{kindLabel}</StatusPill>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{a.title}</div>
                    {a.detail && <div className="text-muted-foreground truncate">{a.detail}</div>}
                  </div>
                  <span className="font-mono-num text-[10px] text-muted-foreground shrink-0 mt-0.5">{a.date}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Live-computed RO / chem / train gap alerts */}
        {localAlerts.length > 0 && (
          <div className="space-y-1.5 pt-1 border-t">
            {localAlerts.slice(0, 5).map((a, i) => (
              <div key={`${a.tone}-${a.text}-${i}`} className="flex items-center gap-2 text-sm">
                <StatusPill tone={a.tone}>{a.tone}</StatusPill>
                <span className="text-xs">{a.text}</span>
              </div>
            ))}
          </div>
        )}

        {feedAlerts.length === 0 && localAlerts.length === 0 && (
          <p className="text-xs text-muted-foreground py-2 text-center">All clear — no alerts</p>
        )}
      </Card>

      <Card className="p-3">
        <h2 className="text-sm font-semibold mb-2">Chemical stock</h2>
        <div className="space-y-2.5">
          {(chemInv ?? []).slice(0, 8).map((c: any) => {
            const pct = c.low_stock_threshold ? Math.min(100, (c.current_stock / (c.low_stock_threshold * 4)) * 100) : 0;
            return (
              <div key={c.id}>
                <div className="flex justify-between text-xs mb-1">
                  <span>{c.chemical_name}</span>
                  <span className="font-mono-num">{c.current_stock} {c.unit}</span>
                </div>
                <Progress value={pct} className="h-1.5" />
              </div>
            );
          })}
          {!chemInv?.length && <p className="text-sm text-muted-foreground py-2 text-center">No inventory yet</p>}
        </div>
      </Card>

      <PowerChart plantIds={plantIds} />
      <EnergyMixCard plantIds={plantIds} />
      <BlendingVolumeCard plantIds={plantIds} />

      <TrendModal open={!!modal} onClose={() => setModal(null)} metric={modal?.metric ?? ''} title={modal?.title ?? ''} plantIds={plantIds} />
      <DowntimeEventsModal
        open={downtimeOpen}
        onClose={() => setDowntimeOpen(false)}
        plantId={selectedPlantId || undefined}
        plantName={selectedPlantId ? visiblePlants?.[0]?.name : 'All plants'}
      />
      <DataSummaryModal
        open={summaryOpen}
        onClose={() => setSummaryOpen(false)}
        plantIds={plantIds}
        plantCodeById={plantCodeById}
      />
    </div>
  );
}
