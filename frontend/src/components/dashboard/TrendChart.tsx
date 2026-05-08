import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { calc } from '@/lib/calculations';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  Legend, ComposedChart, Bar,
} from 'recharts';
import { format, subDays, startOfDay } from 'date-fns';
import {
  ChartMetric, DashboardViewMode, RANGE_DAYS, RangeKey, TREND_Y_LABEL,
} from './types';
import { useAppStore } from '@/store/appStore';

// ─── helpers shared by DataSummaryPopup ──────────────────────────────────────

/** Resolve a single reading row → delta volume (m³), clamped to 0. */
function resolveReadingDelta(r: any): number {
  if (r.daily_volume != null && +r.daily_volume > 0) return +r.daily_volume;
  if (r.current_reading != null && r.previous_reading != null)
    return Math.max(0, +r.current_reading - +r.previous_reading);
  return 0;
}

/**
 * Build a pivot:  dateKey (yyyy-MM-dd) → entityId → summed volume.
 * Readings must already be sorted by reading_datetime asc.
 * Returns the pivot map and the sorted set of unique date keys found.
 */
function buildEntityPivot(
  readings: any[],
  entityField: string,
): { pivot: Map<string, Map<string, number>>; dateKeys: string[] } {
  const pivot = new Map<string, Map<string, number>>();
  readings.forEach((r) => {
    if (r.is_meter_replacement) return;          // skip replacement rows
    const dateKey = format(new Date(r.reading_datetime), 'yyyy-MM-dd');
    const entityId = r[entityField] ?? '__';
    const vol = resolveReadingDelta(r);
    if (!pivot.has(dateKey)) pivot.set(dateKey, new Map());
    pivot.get(dateKey)!.set(entityId, (pivot.get(dateKey)!.get(entityId) ?? 0) + vol);
  });
  const dateKeys = Array.from(pivot.keys()).sort();
  return { pivot, dateKeys };
}

/** Fill every calendar day between startIso and endIso (yyyy-MM-dd strings). */
function fillDateRange(startIso: string, endIso: string): string[] {
  const dates: string[] = [];
  const cur = new Date(startIso + 'T00:00:00');
  const end = new Date(endIso   + 'T00:00:00');
  while (cur <= end) {
    dates.push(format(cur, 'yyyy-MM-dd'));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

/** Format a yyyy-MM-dd key for display as "MMM d" */
function fmtDateKey(key: string): string {
  return format(new Date(key + 'T00:00:00'), 'MMM d');
}

type DSMTab = 'overview' | 'production' | 'consumption';

// ─── CSS class helpers (avoids repetition) ──────────────────────────────────
const TH = 'px-2 py-2 text-center text-[10px] font-semibold text-muted-foreground border-b border-border align-bottom';
const TH_DATE = 'px-3 py-2 text-left text-[10px] font-semibold text-muted-foreground whitespace-nowrap border-b border-border sticky left-0 bg-muted/95 w-[72px] min-w-[72px]';
const TH_TOTAL = 'px-2 py-2 text-center text-[10px] font-bold border-b border-l border-border sticky right-0 bg-teal-50/95 dark:bg-teal-950/60 text-teal-700 dark:text-teal-300 align-bottom w-[80px] min-w-[80px]';
const TD = 'px-2 py-1.5 text-center font-mono-num tabular-nums text-[11px]';
const TD_TOTAL_ROW = 'px-2 py-1.5 text-center font-semibold font-mono-num tabular-nums text-[11px] text-teal-700 dark:text-teal-300';
const TD_TOTAL_COL = 'px-2 py-1.5 text-center font-semibold font-mono-num tabular-nums text-[11px] text-teal-700 dark:text-teal-300 sticky right-0 border-l border-border w-[80px] min-w-[80px]';

function fmtV(v: number | null | undefined, dec = 1) {
  if (v == null || v === 0) return <span className="text-muted-foreground/40">—</span>;
  return v.toLocaleString(undefined, { maximumFractionDigits: dec });
}

/** Generic pivot table: Date rows × entity columns × Total column */
function PivotTable({
  dates,
  entities,       // [{id, label}]
  pivot,          // dateKey → entityId → value
  totalLabel,
  unit = 'm³',
  colorClass = 'text-primary',
}: {
  dates: string[];
  entities: { id: string; label: string }[];
  pivot: Map<string, Map<string, number>>;
  totalLabel: string;
  unit?: string;
  colorClass?: string;
}) {
  const rowTotals = dates.map((d) =>
    entities.reduce((s, e) => s + (pivot.get(d)?.get(e.id) ?? 0), 0),
  );

  if (entities.length === 0) {
    return <div className="flex items-center justify-center h-24 text-xs text-muted-foreground">No entity data found.</div>;
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Fixed header — never scrolls */}
      <div className="overflow-x-auto shrink-0 border-b border-border">
        <table className="border-collapse text-[11px] w-full table-fixed" style={{ minWidth: `${72 + entities.length * 72 + 80}px` }}>
          <colgroup>
            <col style={{ width: '72px', minWidth: '72px' }} />
            {entities.map((e) => <col key={e.id} style={{ minWidth: '72px' }} />)}
            <col style={{ width: '80px', minWidth: '80px' }} />
          </colgroup>
          <thead>
            <tr className="bg-muted/95">
              <th className={TH_DATE}>Date</th>
              {entities.map((e) => (
                <th key={e.id} className={TH} title={e.label}>
                  <div className="text-center leading-tight break-words hyphens-auto" style={{ wordBreak: 'break-word' }}>{e.label}</div>
                  <div className="text-[9px] font-normal opacity-60 mt-0.5">{unit}</div>
                </th>
              ))}
              <th className={TH_TOTAL}>{totalLabel}<br /><span className="text-[9px] font-normal opacity-80">{unit}</span></th>
            </tr>
          </thead>
        </table>
      </div>
      {/* Scrollable body */}
      <div className="overflow-auto flex-1">
        <table className="border-collapse text-[11px] w-full table-fixed" style={{ minWidth: `${72 + entities.length * 72 + 80}px` }}>
          <colgroup>
            <col style={{ width: '72px', minWidth: '72px' }} />
            {entities.map((e) => <col key={e.id} style={{ minWidth: '72px' }} />)}
            <col style={{ width: '80px', minWidth: '80px' }} />
          </colgroup>
          <tbody>
            {[...dates].reverse().map((date, di) => {
              const isEven = di % 2 === 0;
              const rowIdx = dates.length - 1 - di;
              const rowTotal = rowTotals[rowIdx];
              return (
                <tr key={date} className={isEven ? 'bg-background hover:bg-muted/15' : 'bg-muted/10 hover:bg-muted/25'}>
                  <td className={[
                    'px-3 py-1.5 whitespace-nowrap font-medium text-[11px] text-muted-foreground sticky left-0 border-r border-border',
                    isEven ? 'bg-background' : 'bg-muted/10',
                  ].join(' ')}>
                    {fmtDateKey(date)}
                  </td>
                  {entities.map((e) => {
                    const val = pivot.get(date)?.get(e.id) ?? null;
                    return (
                      <td key={e.id} className={TD}>
                        {fmtV(val)}
                      </td>
                    );
                  })}
                  <td className={[
                    TD_TOTAL_COL,
                    colorClass,
                    isEven ? 'bg-background' : 'bg-muted/10',
                  ].join(' ')}>
                    {rowTotal > 0 ? rowTotal.toLocaleString(undefined, { maximumFractionDigits: 1 }) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Overview tab — aggregated columns only (matches original single-column layout) */
function OverviewTable({
  metric,
  chartData,
}: {
  metric: string;
  chartData: any[];
}) {
  if (chartData.length === 0) {
    return <div className="flex items-center justify-center h-24 text-xs text-muted-foreground">No data in selected range.</div>;
  }

  // Determine columns for this metric
  type ColDef = { key: string; label: string; fmt: (d: any) => React.ReactNode };

  const cols: ColDef[] = [];

  if (metric === 'production' || metric === 'nrw') {
    cols.push({
      key: 'production', label: 'Production (m³)',
      fmt: (d) => d.production != null ? d.production.toLocaleString(undefined, { maximumFractionDigits: 1 }) : '—',
    });
    cols.push({
      key: 'consumption', label: 'Consumption (m³)',
      fmt: (d) => d.consumption != null ? d.consumption.toLocaleString(undefined, { maximumFractionDigits: 1 }) : '—',
    });
  }
  if (metric === 'nrw') {
    cols.push({
      key: 'nrw', label: 'NRW (%)',
      fmt: (d) => <span className={d.nrw != null && d.nrw > 20 ? 'text-rose-500 font-semibold' : ''}>{d.nrw != null ? d.nrw + '%' : '—'}</span>,
    });
  }
  if (metric === 'rawwater') {
    cols.push({
      key: 'rawwater', label: 'Raw Water (m³)',
      fmt: (d) => d.rawwater != null ? d.rawwater.toLocaleString(undefined, { maximumFractionDigits: 1 }) : '—',
    });
  }
  if (metric === 'recovery') {
    cols.push({
      key: 'recovery', label: 'Recovery (%)',
      fmt: (d) => d.recovery != null ? d.recovery + '%' : '—',
    });
  }
  if (metric === 'tds') {
    cols.push({
      key: 'tds', label: 'Permeate TDS (ppm)',
      fmt: (d) => d.tds != null ? d.tds + ' ppm' : '—',
    });
  }
  if (metric === 'pv') {
    cols.push(
      { key: 'production', label: 'Production (m³)', fmt: (d) => d.production?.toLocaleString(undefined, { maximumFractionDigits: 1 }) ?? '—' },
      { key: 'kwh', label: 'Power (kWh)', fmt: (d) => d.kwh?.toLocaleString(undefined, { maximumFractionDigits: 1 }) ?? '—' },
      { key: 'pv', label: 'PV Ratio (kWh/m³)', fmt: (d) => d.production > 0 ? (d.kwh / d.production).toFixed(2) : '—' },
    );
  }
  if (metric === 'productionCost') {
    cols.push(
      { key: 'powerCost', label: 'Power (₱)', fmt: (d) => d.powerCost != null ? '₱' + d.powerCost.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—' },
      { key: 'chemCost', label: 'Chemical (₱)', fmt: (d) => d.chemCost != null ? '₱' + d.chemCost.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—' },
      { key: 'totalCost', label: 'Total (₱)', fmt: (d) => d.totalCost != null ? '₱' + d.totalCost.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—' },
      { key: 'unitCost', label: '₱/m³', fmt: (d) => d.unitCost != null ? '₱' + d.unitCost : '—' },
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Fixed header */}
      <div className="overflow-x-auto shrink-0 border-b border-border">
        <table className="w-full border-collapse text-[11px]">
          <thead className="bg-muted/95">
            <tr>
              <th className={TH_DATE}>Date</th>
              {cols.map((c) => <th key={c.key} className={TH}>{c.label}</th>)}
            </tr>
          </thead>
        </table>
      </div>
      {/* Scrollable body */}
      <div className="overflow-auto flex-1">
        <table className="w-full border-collapse text-[11px]">
          <tbody>
            {[...chartData].reverse().map((d, i) => (
              <tr key={d.date} className={i % 2 === 0 ? 'bg-background hover:bg-muted/15' : 'bg-muted/10 hover:bg-muted/25'}>
                <td className={[
                  'px-3 py-1.5 whitespace-nowrap font-medium text-[11px] text-muted-foreground sticky left-0',
                  i % 2 === 0 ? 'bg-background' : 'bg-muted/10',
                ].join(' ')}>{d.date}</td>
                {cols.map((c) => <td key={c.key} className={TD}>{c.fmt(d)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── DataSummaryPopup — 3-tab popup shown when "Data Summary" is clicked ───────
// Tab 1 (always): Overview / Prod vs Consum — aggregated daily totals
// Tab 2: Production — pivot: Date × ProductMeter1…N × Total
// Tab 3: Consumption — pivot: Date × Locator1…N × Total
// For non-production/consumption metrics the Production/Consumption tabs show
// the relevant entity breakdown that feeds that metric.
function DataSummaryPopup({
  open, onClose, metric, title,
  chartData,
  locReadings, productReadings, wellReadings, costReadings,
  locatorNames, productMeterNames, wellNames, plantNames,
}: {
  open: boolean;
  onClose: () => void;
  metric: string;
  title?: string;
  chartData: any[];
  locReadings: any[];
  productReadings: any[];
  wellReadings: any[];
  costReadings: any[];
  locatorNames?: Map<string, string>;
  productMeterNames?: Map<string, string>;
  wellNames?: Map<string, string>;
  plantNames?: Map<string, string>;
}) {
  const [tab, setTab] = useState<DSMTab>('overview');

  // Date range filter state — defaults to full range of available data
  const allDates = chartData.map((d) => d.date as string);
  const defaultFrom = allDates.length ? allDates[0] : '';
  const defaultTo = allDates.length ? allDates[allDates.length - 1] : '';
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');

  // Convert filterFrom/filterTo back to Date for comparison (use full range if empty)
  const parsedFrom = filterFrom ? new Date(`${filterFrom}T00:00:00`) : null;
  const parsedTo = filterTo ? new Date(`${filterTo}T23:59:59`) : null;

  const filteredChartData = useMemo(() => {
    if (!parsedFrom && !parsedTo) return chartData;
    return chartData.filter((d) => {
      // d.date is 'MMM d' format — not parseable by new Date().
      // Use the stored isoDate (full ISO string) for reliable comparison.
      const dt = d.isoDate ? new Date(d.isoDate) : null;
      if (!dt) return true;
      if (parsedFrom && dt < parsedFrom) return false;
      if (parsedTo && dt > parsedTo) return false;
      return true;
    });
  }, [chartData, filterFrom, filterTo]);

  const filteredLocReadings = useMemo(() => {
    if (!parsedFrom && !parsedTo) return locReadings;
    return locReadings.filter((r) => {
      const dt = new Date(r.reading_datetime);
      if (parsedFrom && dt < parsedFrom) return false;
      if (parsedTo && dt > parsedTo) return false;
      return true;
    });
  }, [locReadings, filterFrom, filterTo]);

  const filteredProductReadings = useMemo(() => {
    if (!parsedFrom && !parsedTo) return productReadings;
    return productReadings.filter((r) => {
      const dt = new Date(r.reading_datetime);
      if (parsedFrom && dt < parsedFrom) return false;
      if (parsedTo && dt > parsedTo) return false;
      return true;
    });
  }, [productReadings, filterFrom, filterTo]);

  const filteredWellReadings = useMemo(() => {
    if (!parsedFrom && !parsedTo) return wellReadings;
    return wellReadings.filter((r) => {
      const dt = new Date(r.reading_datetime);
      if (parsedFrom && dt < parsedFrom) return false;
      if (parsedTo && dt > parsedTo) return false;
      return true;
    });
  }, [wellReadings, filterFrom, filterTo]);

  // Determine which secondary tabs are relevant for this metric
  const hasProdTab = metric === 'production' || metric === 'nrw' || metric === 'pv' || metric === 'rawwater';
  const hasConsTab = metric === 'production' || metric === 'nrw';

  // Tab label config
  const overviewLabel =
    metric === 'production' || metric === 'nrw' ? 'Prod. vs Consum.'
    : metric === 'pv' ? 'Prod. vs Power'
    : metric === 'productionCost' ? 'Cost Overview'
    : 'Overview';

  const prodTabLabel =
    metric === 'rawwater' ? 'Per Well'
    : metric === 'pv' ? 'Per Well / Meter'
    : 'Production';

  // Build entity lists and pivots
  // --- Production entities ---
  const prodEntities = useMemo<{ id: string; label: string }[]>(() => {
    if (metric === 'rawwater' || metric === 'pv') {
      // wells
      const ids = Array.from(new Set((filteredWellReadings ?? []).map((r: any) => r.well_id).filter(Boolean)));
      return ids.map((id) => ({ id, label: wellNames?.get(id) ?? `Well ${id.slice(-4)}` }))
        .sort((a, b) => a.label.localeCompare(b.label));
    }
    // product meters
    const ids = Array.from(new Set((filteredProductReadings ?? []).map((r: any) => r.meter_id).filter(Boolean)));
    return ids.map((id) => ({ id, label: productMeterNames?.get(id) ?? `Meter ${id.slice(-4)}` }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [metric, filteredProductReadings, filteredWellReadings, productMeterNames, wellNames]);

  const prodPivot = useMemo(() => {
    const readings = (metric === 'rawwater' || metric === 'pv') ? (filteredWellReadings ?? []) : (filteredProductReadings ?? []);
    const field = (metric === 'rawwater' || metric === 'pv') ? 'well_id' : 'meter_id';
    return buildEntityPivot(
      [...readings].sort((a, b) => new Date(a.reading_datetime).getTime() - new Date(b.reading_datetime).getTime()),
      field,
    );
  }, [metric, filteredProductReadings, filteredWellReadings]);
  const prodPivotMap = prodPivot.pivot;
  const prodDateKeys = prodPivot.dateKeys;

  // --- Consumption entities ---
  const consEntities = useMemo<{ id: string; label: string }[]>(() => {
    const ids = Array.from(new Set((filteredLocReadings ?? []).map((r: any) => r.locator_id).filter(Boolean)));
    return ids.map((id) => ({ id, label: locatorNames?.get(id) ?? `Locator ${id.slice(-4)}` }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [filteredLocReadings, locatorNames]);

  const consPivotResult = useMemo(() => buildEntityPivot(
    [...(filteredLocReadings ?? [])].sort((a, b) => new Date(a.reading_datetime).getTime() - new Date(b.reading_datetime).getTime()),
    'locator_id',
  ), [filteredLocReadings]);
  const consPivot = consPivotResult.pivot;
  const consDateKeys = consPivotResult.dateKeys;

  // Derive a full calendar range of yyyy-MM-dd keys for each tab.
  // Using only dates that have readings (from chartData or pivot keys) means
  // days with zero data are invisible — instead we fill every day in the window.
  const consDates = useMemo(() => {
    if (consDateKeys.length === 0) return [];
    // Expand from the earliest to latest reading date, bounded by filter if set
    const start = filterFrom || consDateKeys[0];
    const end   = filterTo   || consDateKeys[consDateKeys.length - 1];
    return fillDateRange(start, end);
  }, [consDateKeys, filterFrom, filterTo]);

  const prodDates = useMemo(() => {
    if (prodDateKeys.length === 0) return [];
    const start = filterFrom || prodDateKeys[0];
    const end   = filterTo   || prodDateKeys[prodDateKeys.length - 1];
    return fillDateRange(start, end);
  }, [prodDateKeys, filterFrom, filterTo]);

  // Overview dates: union of all available data, or filter-bounded
  const overviewDates = useMemo(() => {
    const allKeys = filteredChartData
      .filter((d) => d.isoDate)
      .map((d) => d.isoDate.slice(0, 10) as string);
    if (allKeys.length === 0) return [];
    const start = filterFrom || allKeys[0];
    const end   = filterTo   || allKeys[allKeys.length - 1];
    return fillDateRange(start, end);
  }, [filteredChartData, filterFrom, filterTo]);

  // Tab guard: if active tab becomes irrelevant, reset
  const activeTab: DSMTab = (!hasProdTab && tab === 'production') || (!hasConsTab && tab === 'consumption') ? 'overview' : tab;

  // The shared "dates" for footer count — use per-tab
  const tabDates = activeTab === 'consumption' ? consDates
    : activeTab === 'production' ? prodDates
    : overviewDates;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent
        className="max-w-[94vw] w-full max-h-[90vh] flex flex-col p-0 gap-0 overflow-hidden"
        data-testid={`dsm-popup-${metric}`}
      >
        {/* Header */}
        <DialogHeader className="px-5 pt-4 pb-0 border-b shrink-0">
          <DialogTitle className="text-sm font-semibold pb-2">
            Data Summary — {title ?? metric}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Multi-tab data summary for {title ?? metric}.
          </DialogDescription>

          {/* Date range filter */}
          <div className="flex items-center gap-2 pb-2 flex-wrap">
            <span className="text-[10px] text-muted-foreground font-medium shrink-0">Date range:</span>
            <Input
              type="date"
              value={filterFrom}
              onChange={(e) => setFilterFrom(e.target.value)}
              placeholder={defaultFrom}
              className="h-6 w-[110px] text-[10px] px-1.5"
            />
            <span className="text-[10px] text-muted-foreground shrink-0">→</span>
            <Input
              type="date"
              value={filterTo}
              onChange={(e) => setFilterTo(e.target.value)}
              placeholder={defaultTo}
              className="h-6 w-[110px] text-[10px] px-1.5"
            />
            {(filterFrom || filterTo) && (
              <button
                onClick={() => { setFilterFrom(''); setFilterTo(''); }}
                className="h-6 px-2 rounded text-[10px] font-medium bg-muted text-muted-foreground hover:text-foreground border border-border transition-colors"
              >
                Clear
              </button>
            )}
          </div>

          {/* Tabs row */}
          <div className="flex gap-0 -mb-px">
            {([
              { key: 'overview' as DSMTab, label: overviewLabel, show: true },
              { key: 'production' as DSMTab, label: prodTabLabel, show: hasProdTab },
              { key: 'consumption' as DSMTab, label: 'Consumption', show: hasConsTab },
            ] as const).filter((t) => t.show).map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={[
                  'px-5 py-2.5 text-xs font-semibold border-b-2 transition-colors whitespace-nowrap',
                  activeTab === t.key
                    ? 'border-primary text-primary bg-background'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border',
                ].join(' ')}
              >
                {t.label}
              </button>
            ))}
          </div>
        </DialogHeader>

        {/* Body */}
        <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
          <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
              {activeTab === 'overview' && (
                <OverviewTable metric={metric} chartData={filteredChartData} />
              )}
              {activeTab === 'production' && hasProdTab && (
                <PivotTable
                  dates={prodDates}
                  entities={prodEntities}
                  pivot={prodPivotMap}
                  totalLabel={metric === 'rawwater' ? 'Total Raw (m³)' : 'Total Prod. (m³)'}
                  unit="m³"
                  colorClass="text-primary"
                />
              )}
              {activeTab === 'consumption' && hasConsTab && (
                <PivotTable
                  dates={consDates}
                  entities={consEntities}
                  pivot={consPivot}
                  totalLabel="Total Cons. (m³)"
                  unit="m³"
                  colorClass="text-highlight"
                />
              )}
            </div>
        </div>

        {/* Footer info bar */}
        <div className="px-5 py-2 border-t shrink-0 flex items-center gap-3 text-[10px] text-muted-foreground bg-muted/20">
          <span className="font-medium">{tabDates.length} days in range</span>
          {activeTab === 'production' && hasProdTab && (
            <span>· {prodEntities.length} {metric === 'rawwater' ? 'wells' : 'product meters'}</span>
          )}
          {activeTab === 'consumption' && hasConsTab && (
            <span>· {consEntities.length} locators</span>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Renders the per-cluster trend chart slot beneath a cluster's StatCards.
//   • inline   — every chart in the cluster is rendered directly below
//                the cards (full-width, compact height) so the user can
//                just scroll to see all trends.
//   • sections — at most one chart (matching `expandedMetric`) is
//                rendered below the cards. Single-open behaviour: the
//                user clicks a KPI card to fold its chart open here;
//                clicking another KPI auto-closes the previous.
//   • popup    — nothing is rendered here; charts surface only inside
//                the TrendModal opened from the StatCards above.
export function ClusterCharts({
  metrics, viewMode, expandedMetric, plantIds, clusterId,
}: {
  metrics: ChartMetric[];
  viewMode: DashboardViewMode;
  expandedMetric: string | null;
  plantIds: string[];
  clusterId: string;
}) {
  if (viewMode === 'popup') return null;
  if (viewMode === 'inline') {
    return (
      <div className="space-y-2 mt-2" data-testid={`cluster-inline-charts-${clusterId}`}>
        {metrics.map((m) => (
          <InlineTrendChart key={m.metric} metric={m.metric} title={m.title} plantIds={plantIds} compact />
        ))}
      </div>
    );
  }
  // sections — render the expanded chart only if it belongs to this cluster
  if (viewMode === 'sections' && expandedMetric) {
    const m = metrics.find((x) => x.metric === expandedMetric);
    if (!m) return null;
    return (
      <div className="mt-2" data-testid={`cluster-section-chart-${m.metric}`}>
        <InlineTrendChart metric={m.metric} title={m.title} plantIds={plantIds} />
      </div>
    );
  }
  return null;
}

// Card-wrapped trend chart used both for `inline` (compact height,
// stacked beneath each cluster) and `sections` (regular height,
// single open at a time). Title and range buttons share the same row
// so the chart area is maximised, especially on mobile.
export function InlineTrendChart({
  metric, title, plantIds, compact = false,
}: {
  metric: string;
  title: string;
  plantIds: string[];
  compact?: boolean;
}) {
  return (
    <Card className="p-3" data-testid={`inline-trend-${metric}`}>
      <TrendChart metric={metric} title={title} plantIds={plantIds} compact={compact} />
    </Card>
  );
}

// Modal-wrapped trend chart used in `popup` view mode. Thin Dialog
// shell — the chart logic itself lives entirely in <TrendChart> below.
export function TrendModal({
  open, onClose, metric, title, plantIds,
}: {
  open: boolean;
  onClose: () => void;
  metric: string;
  title: string;
  plantIds: string[];
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl w-[95vw] sm:w-full">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">
            Pick a date range to inspect the {title.toLowerCase()} time series for the selected plants.
          </DialogDescription>
        </DialogHeader>
        <TrendChart metric={metric} plantIds={plantIds} />
      </DialogContent>
    </Dialog>
  );
}

// Reusable trend chart used both inside the popup TrendModal and as
// an inline/section panel embedded directly on the dashboard. Owns
// its own range state, supabase queries, and chart rendering. The
// `compact` prop swaps in a shorter chart height for the inline view
// where multiple charts stack vertically and we want to keep the
// page from getting absurdly tall. When `title` is provided the
// component renders it on the same row as the range buttons so the
// chart area is maximised on mobile.
export function TrendChart({
  metric, plantIds, compact = false, title,
}: {
  metric: string;
  plantIds: string[];
  compact?: boolean;
  title?: string;
}) {
  // All charts share a single range selection via the global store so
  // that picking 14D on one chart instantly syncs every other chart.
  const range = useAppStore((s) => s.chartRange);
  const from = useAppStore((s) => s.chartFrom);
  const to = useAppStore((s) => s.chartTo);
  const setRange = useAppStore((s) => s.setChartRange);
  const setChartCustomDates = useAppStore((s) => s.setChartCustomDates);
  const handleFromChange = (v: string) => setChartCustomDates(v, to);
  const handleToChange = (v: string) => setChartCustomDates(from, v);
  // Toggle for the inline data summary table
  const [showSummary, setShowSummary] = useState(false);

  // Stable date-bounded ISO strings so react-query can cache properly.
  const { startISO, endISO, startKey, endKey } = useMemo(() => {
    if (range === 'CUSTOM') {
      const s = new Date(`${from}T00:00:00`);
      const e = new Date(`${to}T23:59:59`);
      return {
        startISO: s.toISOString(), endISO: e.toISOString(),
        startKey: from, endKey: to,
      };
    }
    const days = RANGE_DAYS[range];
    const end = new Date();
    const start = startOfDay(subDays(end, days));
    return {
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      startKey: format(start, 'yyyy-MM-dd'),
      endKey: format(end, 'yyyy-MM-dd'),
    };
  }, [range, from, to]);

  const needsWellReadings = metric === 'nrw' || metric === 'rawwater' || metric === 'pv';
  const needsProductMeterReadings = metric === 'production' || metric === 'nrw' || metric === 'pv';
  const needsLocReadings = metric === 'production' || metric === 'nrw';
  const needsRoReadings = metric === 'recovery' || metric === 'tds';
  const needsPowerReadings = metric === 'pv';
  const needsCostReadings = metric === 'productionCost';

  // ── Entity name lookups — fetched once per plant selection ─────────────────
  const { data: wellNames } = useQuery({
    queryKey: ['entity-names-wells', plantIds],
    queryFn: async () => {
      const { data } = await supabase.from('wells').select('id, name').in('plant_id', plantIds);
      const map = new Map<string, string>();
      (data ?? []).forEach((w: any) => map.set(w.id, w.name));
      return map;
    },
    enabled: plantIds.length > 0 && needsWellReadings,
  });

  const { data: locatorNames } = useQuery({
    queryKey: ['entity-names-locators', plantIds],
    queryFn: async () => {
      const { data } = await supabase.from('locators').select('id, name').in('plant_id', plantIds);
      const map = new Map<string, string>();
      (data ?? []).forEach((l: any) => map.set(l.id, l.name));
      return map;
    },
    enabled: plantIds.length > 0 && needsLocReadings,
  });

  const { data: productMeterNames } = useQuery({
    queryKey: ['entity-names-product-meters', plantIds],
    queryFn: async () => {
      const { data } = await (supabase.from('product_meters' as never) as any)
        .select('id, name').in('plant_id', plantIds);
      const map = new Map<string, string>();
      (data ?? []).forEach((m: any) => map.set(m.id, m.name));
      return map;
    },
    enabled: plantIds.length > 0 && needsProductMeterReadings,
  });

  // Plant names are used for power meter replacement messages (one power meter per plant).
  const { data: plantNames } = useQuery({
    queryKey: ['entity-names-plants', plantIds],
    queryFn: async () => {
      const { data } = await supabase.from('plants').select('id, name').in('id', plantIds);
      const map = new Map<string, string>();
      (data ?? []).forEach((p: any) => map.set(p.id, p.name));
      return map;
    },
    enabled: plantIds.length > 0 && needsPowerReadings,
  });

  const supaSelect = async <T,>(table: string, cols: string) => {
    const { data, error } = await supabase.from(table as never).select(cols)
      .in('plant_id', plantIds).gte('reading_datetime', startISO).lte('reading_datetime', endISO);
    if (error) throw new Error(`${table}: ${error.message}`);
    return (data as T[]) ?? [];
  };

  // ── BUG FIX: locator_readings has no plant_id column ─────────────────────
  // The previous implementation called supaSelect('locator_readings', ...)
  // which filtered by plant_id — a column that does NOT exist on that table.
  // This returned zero rows for every plant except SRP (which coincidentally
  // worked due to data characteristics), causing consumption = 0 for all
  // dates in the selected range (most visibly Jan 1 – Mar 21).
  //
  // Fix: two-step query that mirrors the pattern Dashboard.tsx already uses:
  //   Step 1 — resolve the locator IDs that belong to these plants (via the
  //             locators table, which DOES have plant_id).
  //   Step 2 — query locator_readings filtered by those locator IDs.
  //
  // The locator meta query is shared with the name-lookup query above but
  // we need the IDs before the readings query can run, so we keep it
  // separate and gate the readings query on the result.
  const { data: _locatorIdsForReadings } = useQuery({
    queryKey: ['trend-loc-ids', plantIds],
    queryFn: async () => {
      if (!plantIds.length) return [] as string[];
      const { data } = await supabase
        .from('locators')
        .select('id')
        .in('plant_id', plantIds)
        .eq('status', 'Active');
      return (data ?? []).map((l: any) => l.id as string);
    },
    enabled: plantIds.length > 0 && needsLocReadings,
  });

  const { data: locReadings, isFetching: fetchingLoc, error: errLoc } = useQuery({
    queryKey: ['trend-loc', metric, startKey, endKey, plantIds],
    queryFn: async () => {
      const locatorIds = _locatorIdsForReadings ?? [];
      if (!locatorIds.length) return [];
      const { data, error } = await supabase
        .from('locator_readings')
        .select('locator_id,daily_volume,current_reading,previous_reading,reading_datetime,is_meter_replacement')
        .in('locator_id', locatorIds)
        .gte('reading_datetime', startISO)
        .lte('reading_datetime', endISO)
        .order('reading_datetime', { ascending: true });
      if (error) throw new Error(`locator_readings: ${error.message}`);
      return (data ?? []) as any[];
    },
    // Wait for locator IDs to resolve before fetching readings.
    enabled: plantIds.length > 0 && needsLocReadings && (_locatorIdsForReadings !== undefined),
  });

  // Product meter readings — the treated-water output meters installed on
  // the product line. These are the authoritative source for Production volume,
  // distinct from well (raw water) meters and locator (distribution) meters.
  // The table is not in the generated Supabase types so we cast as `never`.
  const { data: productReadings, isFetching: fetchingProduct, error: errProduct } = useQuery({
    queryKey: ['trend-product', metric, startKey, endKey, plantIds],
    queryFn: async () => {
      // Try with is_meter_replacement first; fall back gracefully if column
      // doesn't exist in this deployment (field will be undefined → false).
      const { data, error } = await (supabase.from('product_meter_readings' as never) as any)
        // Bug fix: include daily_volume so computeEntityDeltas can use it directly,
        // matching how locator_readings are handled (avoids boundary-read delta = 0).
        .select('meter_id,daily_volume,current_reading,previous_reading,reading_datetime,is_meter_replacement,plant_id')
        .in('plant_id', plantIds)
        .gte('reading_datetime', startISO)
        .lte('reading_datetime', endISO);
      if (error) {
        if (error.message?.includes('is_meter_replacement')) {
          const { data: d2, error: e2 } = await (supabase.from('product_meter_readings' as never) as any)
            .select('meter_id,daily_volume,current_reading,previous_reading,reading_datetime,plant_id')
            .in('plant_id', plantIds)
            .gte('reading_datetime', startISO)
            .lte('reading_datetime', endISO);
          if (e2) throw new Error(`product_meter_readings: ${e2.message}`);
          return (d2 as any[]) ?? [];
        }
        throw new Error(`product_meter_readings: ${error.message}`);
      }
      return (data as any[]) ?? [];
    },
    enabled: plantIds.length > 0 && needsProductMeterReadings,
  });

  // ── Well readings — fetch with well_id so deltas are scoped per well ────────
  // Operations.tsx saves well readings with well_id + plant_id but never
  // writes daily_volume. Raw Water must therefore be computed as the sum of
  // (current_reading − previous_reading) per well per day, excluding rows
  // flagged is_meter_replacement and the first reading after a replacement.
  // Fetching well_id here (instead of relying on plant_id alone) lets
  // computeEntityDeltas group correctly by individual meter rather than by
  // plant, preventing cross-well subtraction that produced the -4,853,089 bug.
  const { data: wellReadings, isFetching: fetchingWell, error: errWell } = useQuery({
    queryKey: ['trend-well', metric, startKey, endKey, plantIds],
    queryFn: () => supaSelect<any>(
      'well_readings',
      'well_id,current_reading,previous_reading,reading_datetime,is_meter_replacement,plant_id',
    ),
    enabled: plantIds.length > 0 && needsWellReadings,
  });

  const { data: roReadings, isFetching: fetchingRo, error: errRo } = useQuery({
    queryKey: ['trend-ro', metric, startKey, endKey, plantIds],
    queryFn: () => supaSelect<any>('ro_train_readings', 'recovery_pct,permeate_tds,reading_datetime'),
    enabled: plantIds.length > 0 && needsRoReadings,
  });
  const { data: powerReadings, isFetching: fetchingPower, error: errPower } = useQuery({
    queryKey: ['trend-power', metric, startKey, endKey, plantIds],
    queryFn: () => supaSelect<any>('power_readings', 'daily_consumption_kwh,meter_reading_kwh,reading_datetime,is_meter_replacement,plant_id'),
    enabled: plantIds.length > 0 && needsPowerReadings,
  });

  // Production-cost rows use a date column (`cost_date`) rather than a
  // datetime, so the generic `supaSelect` helper (which filters on
  // `reading_datetime`) doesn't fit. Inline this single query instead.
  // `production_m3` is pulled so we can compute weighted ₱/m³ across
  // multi-plant selections (a simple average of per-plant `cost_per_m3`
  // would mis-weight a plant that produced 10× the volume).
  const { data: costReadings, isFetching: fetchingCost, error: errCost } = useQuery({
    queryKey: ['trend-cost', metric, startKey, endKey, plantIds],
    queryFn: async () => {
      const { data, error } = await supabase.from('production_costs')
        .select('cost_date,power_cost,chem_cost,total_cost,production_m3')
        .in('plant_id', plantIds)
        .gte('cost_date', startKey)
        .lte('cost_date', endKey);
      if (error) throw new Error(`production_costs: ${error.message}`);
      return (data as any[]) ?? [];
    },
    enabled: plantIds.length > 0 && needsCostReadings,
  });

  const isFetching = fetchingLoc || fetchingWell || fetchingRo || fetchingPower || fetchingCost || fetchingProduct;
  const queryError = (errLoc || errWell || errRo || errPower || errCost || errProduct) as Error | null;

  const chartData = useMemo(() => {
    const byDay = new Map<string, any>();
    const ensure = (d: string, sortKey: number) =>
      byDay.get(d) ?? byDay.set(d, {
        date: d, sortKey, isoDate: new Date(sortKey).toISOString(),
        production: 0, consumption: 0, rawwater: 0,
        recovery: 0, recoverySamples: 0,
        tds: 0, tdsSamples: 0, kwh: 0,
        powerCost: 0, chemCost: 0, totalCost: 0,
        costProduction: 0,
        // _raw* fields accumulate the true unclamped deltas so the tooltip
        // can show the real value even when the chart plots 0 (clamped).
        // null means "no negative delta seen" → tooltip shows normal value.
        _rawProduction: null as number | null,
        _rawConsumption: null as number | null,
        _rawRawwater: null as number | null,
        _rawKwh: null as number | null,
        // _meterReplacements: list of human-readable entity names replaced on this day.
        // e.g. ["Well 4 Raw Meter", "McDonalds Product Meter"]
        _meterReplacements: [] as string[],
      }).get(d);

    // ── Unified meter-replacement-aware delta helper ────────────────────────
    // Used for ALL meter types: wells, locators, product meters, power.
    //
    // entityKeyField: the column that uniquely identifies an individual meter.
    //   • well_readings          → 'well_id'
    //   • locator_readings       → 'locator_id'
    //   • product_meter_readings → 'meter_id'
    //   • power_readings         → 'plant_id'  (one power meter per plant)
    //
    // Keying by the individual meter ID (not plant_id) prevents readings from
    // different meters at the same plant bleeding into each other's diff —
    // the root cause of the -4,853,089 / +885,406 spikes seen in Raw Water.
    //
    // dailyVolumeField: if the table stores a pre-computed daily volume column
    // (e.g. locator_readings.daily_volume), use it directly when present.
    // Wells and product meters don't have this column so pass null.
    //
    // Meter-replacement handling (matches Operations.tsx display logic):
    //   • REPL row (is_meter_replacement = true):
    //       delta = 0, new baseline = current_reading, flag entity as "afterRepl"
    //   • First non-REPL row after a REPL:
    //       delta = 0 (new meter has no valid predecessor yet), clear flag
    //   • All subsequent rows:
    //       delta = current_reading − last seen current_reading for that entity
    //
    // rawDelta is null when there is no predecessor (first reading in window,
    // or first after replacement) so the tooltip doesn't false-flag those as
    // negative readings.
    function computeEntityDeltas(
      readings: any[],
      entityKeyField: string,
      dailyVolumeField: string | null,
    ): { r: any; delta: number; rawDelta: number | null; isMeterReplacement: boolean }[] {
      const sorted = [...readings].sort(
        (a, b) => new Date(a.reading_datetime).getTime() - new Date(b.reading_datetime).getTime(),
      );

      const lastReading = new Map<string, number>(); // entityKey → last current_reading
      const afterRepl   = new Set<string>();          // entities whose next row is zeroed

      return sorted.map((r) => {
        const entityKey = r[entityKeyField] ?? r.plant_id ?? '__';
        const isMR      = !!r.is_meter_replacement;

        if (isMR) {
          lastReading.set(entityKey, +r.current_reading);
          afterRepl.add(entityKey);
          return { r, delta: 0, rawDelta: null, isMeterReplacement: true };
        }

        if (afterRepl.has(entityKey)) {
          lastReading.set(entityKey, +r.current_reading);
          afterRepl.delete(entityKey);
          return { r, delta: 0, rawDelta: null, isMeterReplacement: false };
        }

        if (dailyVolumeField && r[dailyVolumeField] != null) {
          const rawDelta = +r[dailyVolumeField];
          const delta    = Math.max(0, rawDelta);
          lastReading.set(entityKey, +r.current_reading);
          return { r, delta, rawDelta, isMeterReplacement: false };
        }

        if (!lastReading.has(entityKey)) {
          lastReading.set(entityKey, +r.current_reading);
          // Bug fix: if the DB stored previous_reading, compute the delta
          // instead of returning 0.  Without this, the first reading in the
          // fetch window (which has no prior in-memory row) always shows 0 —
          // causing every locator/well to report no data at the start of a
          // long range even though readings exist in the database.
          if (r.previous_reading != null) {
            const rawDelta = +r.current_reading - +r.previous_reading;
            const delta    = Math.max(0, rawDelta);
            return { r, delta, rawDelta, isMeterReplacement: false };
          }
          return { r, delta: 0, rawDelta: null, isMeterReplacement: false };
        }

        const rawDelta = +r.current_reading - lastReading.get(entityKey)!;
        const delta    = Math.max(0, rawDelta);
        lastReading.set(entityKey, +r.current_reading);
        return { r, delta, rawDelta, isMeterReplacement: false };
      });
    }

    // Helper: accumulate raw delta into a _raw field only when it's negative.
    // Keeps null when all readings are non-negative (tooltip shows normal value).
    const accumulateRaw = (row: any, field: string, rawDelta: number | null) => {
      if (rawDelta === null) return;
      if (rawDelta < 0) {
        row[field] = (row[field] ?? 0) + rawDelta;
      }
    };

    // ── Raw Water = sum of per-well (current − previous) deltas ────────────
    // Uses computeEntityDeltas keyed by well_id for correct per-well scoping.
    computeEntityDeltas(wellReadings ?? [], 'well_id', null).forEach(({ r, delta, rawDelta, isMeterReplacement }) => {
      const dt = new Date(r.reading_datetime);
      const key = format(dt, 'MMM d');
      const row = ensure(key, dt.getTime());
      row.rawwater += delta;
      accumulateRaw(row, '_rawRawwater', rawDelta);
      if (isMeterReplacement) {
        const entityName = wellNames?.get(r.well_id) ?? r.well_id ?? 'Well';
        const label = `${entityName} Raw Meter`;
        if (!row._meterReplacements.includes(label)) row._meterReplacements.push(label);
      }
    });

    // Production = sum of product meter (treated-water output) deltas.
    // Bug fix: pass 'daily_volume' so the pre-computed column is used when present,
    // matching how locator_readings are handled (avoids boundary-read delta = 0).
    computeEntityDeltas(productReadings ?? [], 'meter_id', 'daily_volume').forEach(({ r, delta, rawDelta, isMeterReplacement }) => {
      const dt = new Date(r.reading_datetime);
      const key = format(dt, 'MMM d');
      const row = ensure(key, dt.getTime());
      row.production += delta;
      accumulateRaw(row, '_rawProduction', rawDelta);
      if (isMeterReplacement) {
        const entityName = productMeterNames?.get(r.meter_id) ?? r.meter_id ?? 'Product Meter';
        const label = `${entityName} Product Meter`;
        if (!row._meterReplacements.includes(label)) row._meterReplacements.push(label);
      }
    });

    // Consumption = sum of locator (distribution/endpoint) meter deltas.
    // NOTE: locReadings are now fetched via locator_id (not plant_id) so all
    // plants return data correctly — see the two-step query above.
    computeEntityDeltas(locReadings ?? [], 'locator_id', 'daily_volume').forEach(({ r, delta, rawDelta, isMeterReplacement }) => {
      const dt = new Date(r.reading_datetime);
      const key = format(dt, 'MMM d');
      const row = ensure(key, dt.getTime());
      row.consumption += delta;
      accumulateRaw(row, '_rawConsumption', rawDelta);
      if (isMeterReplacement) {
        const entityName = locatorNames?.get(r.locator_id) ?? r.locator_id ?? 'Locator';
        const label = `${entityName} Meter`;
        if (!row._meterReplacements.includes(label)) row._meterReplacements.push(label);
      }
    });

    (roReadings ?? []).forEach((r: any) => {
      const dt = new Date(r.reading_datetime);
      const key = format(dt, 'MMM d');
      const row = ensure(key, dt.getTime());
      if (r.recovery_pct != null) { row.recovery += +r.recovery_pct; row.recoverySamples += 1; }
      if (r.permeate_tds != null) { row.tds += +r.permeate_tds; row.tdsSamples += 1; }
    });

    // Power = sequential delta of meter_reading_kwh, exactly like locator.
    computeEntityDeltas(
      (powerReadings ?? []).map((r: any) => ({
        ...r,
        current_reading: r.meter_reading_kwh ?? r.daily_consumption_kwh ?? 0,
      })),
      'plant_id',
      'daily_consumption_kwh',
    ).forEach(({ r, delta, rawDelta, isMeterReplacement }) => {
      const dt = new Date(r.reading_datetime);
      const key = format(dt, 'MMM d');
      const row = ensure(key, dt.getTime());
      row.kwh += delta;
      accumulateRaw(row, '_rawKwh', rawDelta);
      if (isMeterReplacement) {
        const entityName = plantNames?.get(r.plant_id) ?? r.plant_id ?? 'Plant';
        const label = `${entityName} Power Meter`;
        if (!row._meterReplacements.includes(label)) row._meterReplacements.push(label);
      }
    });

    (costReadings ?? []).forEach((r: any) => {
      const dt = new Date(`${r.cost_date}T00:00:00`);
      const key = format(dt, 'MMM d');
      const row = ensure(key, dt.getTime());
      const power = +(r.power_cost ?? 0);
      const chem = +(r.chem_cost ?? 0);
      row.powerCost += power;
      row.chemCost += chem;
      row.totalCost += r.total_cost != null ? +r.total_cost : power + chem;
      row.costProduction += +(r.production_m3 ?? 0);
    });

    return Array.from(byDay.values())
      .sort((a, b) => a.sortKey - b.sortKey)
      .map(({ sortKey: _s, recoverySamples, tdsSamples, costProduction, ...d }) => ({
        ...d,
        recovery: recoverySamples ? +(d.recovery / recoverySamples).toFixed(1) : null,
        tds: tdsSamples ? Math.round(d.tds / tdsSamples) : null,
        nrw: calc.nrw(d.production, d.consumption),
        unitCost: costProduction > 0 ? +(d.totalCost / costProduction).toFixed(2) : null,
        // _meterReplacements is already in ...d — preserved here for the tooltip
      }));
  }, [locReadings, wellReadings, productReadings, roReadings, powerReadings, costReadings,
      wellNames, locatorNames, productMeterNames, plantNames]);

  // ── Per-day negative-value index ────────────────────────────────────────
  // Built from the _raw* fields stored in chartData. Each entry lists only
  // the fields that are actually plotted for this metric and had a negative
  // raw delta on that date. The tooltip uses this to show the true value
  // (e.g. -900.3) even though the chart bar/line shows 0 (clamped).
  const negativeByDate = useMemo<Map<string, { label: string; rawValue: number; chartValue: number }[]>>(() => {
    const map = new Map<string, { label: string; rawValue: number; chartValue: number }[]>();

    // Mapping: metric → which _raw field to check, its display label, and the
    // corresponding plotted (clamped) field name.
    const checks: Record<string, Array<{ rawField: string; chartField: string; label: string }>> = {
      production:     [
        { rawField: '_rawProduction',  chartField: 'production',  label: 'Production (m³)' },
        { rawField: '_rawConsumption', chartField: 'consumption', label: 'Consumption (m³)' },
      ],
      nrw:            [
        { rawField: '_rawProduction',  chartField: 'production',  label: 'Production (m³)' },
        { rawField: '_rawConsumption', chartField: 'consumption', label: 'Consumption (m³)' },
        // nrw is derived — flag it when the computed value is negative
        { rawField: 'nrw',             chartField: 'nrw',         label: 'NRW %' },
      ],
      rawwater:       [{ rawField: '_rawRawwater', chartField: 'rawwater', label: 'Raw Water (m³)' }],
      pv:             [
        { rawField: '_rawProduction', chartField: 'production', label: 'Production (m³)' },
        { rawField: '_rawKwh',        chartField: 'kwh',        label: 'Power (kWh)' },
      ],
      // recovery, tds, productionCost values come straight from the DB —
      // no clamping — so rawField === chartField (negative = truly negative).
      recovery:       [{ rawField: 'recovery',  chartField: 'recovery',  label: 'Recovery (%)' }],
      tds:            [{ rawField: 'tds',        chartField: 'tds',       label: 'Permeate TDS (ppm)' }],
      productionCost: [
        { rawField: 'powerCost', chartField: 'powerCost', label: 'Power (₱)' },
        { rawField: 'chemCost',  chartField: 'chemCost',  label: 'Chemical (₱)' },
        { rawField: 'totalCost', chartField: 'totalCost', label: 'Total (₱)' },
      ],
    };

    const fields = checks[metric] ?? [];

    for (const row of chartData) {
      for (const { rawField, chartField, label } of fields) {
        const raw = row[rawField];
        // For _raw* fields: null means no negative delta → skip.
        // For direct fields (recovery, tds, costs, nrw): check if < 0.
        const isNegative = rawField.startsWith('_raw')
          ? raw !== null && raw < 0
          : raw != null && +raw < 0;

        if (!isNegative) continue;

        const entry = { label, rawValue: +raw, chartValue: +(row[chartField] ?? 0) };
        const existing = map.get(row.date);
        if (existing) existing.push(entry);
        else map.set(row.date, [entry]);
      }
    }

    return map;
  }, [chartData, metric]);

  // Custom tooltip — same look as Recharts default but:
  //  • Shows the true raw (unclamped) value for any field that was clamped to 0
  //  • When the zero was caused by a meter replacement, shows "🔧 [Name] was Replaced"
  //    instead of the generic "⚠️ Negative reading" warning
  //  • If both a replacement AND a genuine negative exist on the same day, shows both
  const NegativeAwareTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null;
    const warnings = negativeByDate.get(label as string) ?? [];

    // Meter replacements for this date — from chartData row
    const chartRow = chartData.find((d) => d.date === label);
    const replacements: string[] = chartRow?._meterReplacements ?? [];

    // Build a quick lookup from dataKey → rawValue for affected fields
    const rawOverride = new Map(warnings.map((w) => {
      // Match label back to dataKey by finding the payload entry with the same name
      const entry = payload.find((p: any) => p.name === w.label);
      return [entry?.dataKey, w.rawValue];
    }));

    // Warnings that are NOT covered by a meter replacement (genuine negatives)
    // A warning is "covered" if the value is 0 on the chart (i.e. clamped) AND
    // there are replacements on this day — the zero was caused by the replacement.
    const genuineNegatives = replacements.length > 0
      ? warnings.filter((w) => {
          const entry = payload.find((p: any) => p.name === w.label);
          const chartVal = entry?.value ?? 0;
          // If the chart shows 0, the replacement explains it — not a genuine negative
          return chartVal !== 0;
        })
      : warnings;

    return (
      <div style={{
        background: 'hsl(var(--card))',
        border: '1px solid hsl(var(--border))',
        borderRadius: 8,
        fontSize: 11,
        padding: '8px 10px',
        minWidth: 148,
        maxWidth: 300,
        boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
      }}>
        <p style={{ margin: '0 0 4px', fontWeight: 600 }}>{label}</p>
        {payload.map((entry: any) => {
          const override = rawOverride.get(entry.dataKey);
          // On replacement days the chart plots 0 (adjusted/offset value).
          // Show 0 — which IS the correct adjusted reading — not the raw negative.
          const displayValue = (override !== undefined && replacements.length === 0)
            ? override
            : entry.value;
          const isNegative = displayValue != null && displayValue < 0;
          return (
            <p key={entry.dataKey} style={{
              margin: '1px 0',
              color: entry.color ?? entry.stroke,
            }}>
              {entry.name}:{' '}
              <span style={isNegative ? { fontWeight: 600 } : undefined}>
                {displayValue != null ? displayValue.toLocaleString() : '—'}
              </span>
              {/* Only show "chart: 0" hint when value was clamped AND it's a genuine negative */}
              {override !== undefined && replacements.length === 0 && (
                <span style={{ fontSize: 9, opacity: 0.7, marginLeft: 3 }}>(chart: 0)</span>
              )}
            </p>
          );
        })}

        {/* ── Meter replacement notice — replaces negative-reading warning ── */}
        {replacements.length > 0 && (
          <div style={{
            marginTop: 6,
            paddingTop: 5,
            borderTop: '1px solid hsl(var(--border))',
          }}>
            {replacements.map((name) => (
              <div key={name} style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 5,
                color: '#92400e',
                marginBottom: 2,
              }}>
                <span style={{ fontSize: 12, lineHeight: 1 }}>🔧</span>
                <span style={{ fontSize: 10, lineHeight: 1.4 }}>
                  <strong>{name} was Replaced</strong>
                  {' '}
                  <span style={{ opacity: 0.75 }}>(value adjusted to 0)</span>
                </span>
              </div>
            ))}
          </div>
        )}

        {/* ── Genuine negative readings (not explained by a replacement) ── */}
        {genuineNegatives.length > 0 && (
          <div style={{
            marginTop: 6,
            paddingTop: 5,
            borderTop: '1px solid hsl(var(--border))',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 5,
            color: '#92400e',
          }}>
            <span style={{ fontSize: 12, lineHeight: 1 }}>⚠️</span>
            <span style={{ fontSize: 10, lineHeight: 1.4 }}>
              <strong>Negative reading:</strong>{' '}
              {genuineNegatives.map((w) => w.label).join(', ')}
            </span>
          </div>
        )}
      </div>
    );
  };

  const chartHeight = compact ? 'h-[200px]' : 'h-[340px]';

  // Format large numbers as 1.2K / 3.4M on the Y-axis so the axis
  // label doesn't eat into the chart area on narrow mobile screens.
  const formatYAxis = (value: number) => {
    if (value === 0) return '0';
    if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
    return String(value);
  };

  return (
    <>
      {/* Title, range buttons, and Data Summary tab on one compact row */}
      <div className="flex flex-wrap items-center gap-1 mb-2">
        {title && (
          <span className="text-sm font-semibold mr-1 shrink-0">{title}</span>
        )}
        {/* Range pills — compact size */}
        <div className="flex flex-wrap items-center gap-0.5">
          {(['7D', '14D', '30D', '60D', '90D'] as RangeKey[]).map((r) => (
            <button key={r}
              onClick={() => setRange(r)}
              data-testid={`trend-range-${metric}-${r}`}
              className={[
                'h-5 px-1.5 rounded text-[10px] font-medium transition-colors leading-none',
                range === r
                  ? 'bg-teal-700 text-white'
                  : 'bg-muted text-muted-foreground hover:text-foreground border border-border',
              ].join(' ')}
            >{r}</button>
          ))}
          <button
            onClick={() => setRange('CUSTOM')}
            data-testid={`trend-range-${metric}-CUSTOM`}
            className={[
              'h-5 px-1.5 rounded text-[10px] font-medium transition-colors leading-none',
              range === 'CUSTOM'
                ? 'bg-teal-700 text-white'
                : 'bg-muted text-muted-foreground hover:text-foreground border border-border',
            ].join(' ')}
          >Custom</button>
          {range === 'CUSTOM' && (
            <div className="flex items-center gap-1 mt-1 w-full sm:w-auto sm:mt-0">
              <Input
                type="date"
                value={from}
                onChange={(e) => handleFromChange(e.target.value)}
                className="h-6 w-[110px] text-[10px] px-1.5"
                data-testid={`trend-from-${metric}`}
              />
              <span className="text-[10px] text-muted-foreground shrink-0">→</span>
              <Input
                type="date"
                value={to}
                onChange={(e) => handleToChange(e.target.value)}
                className="h-6 w-[110px] text-[10px] px-1.5"
                data-testid={`trend-to-${metric}`}
              />
            </div>
          )}
          {isFetching && (
            <span className="text-[10px] text-muted-foreground ml-1">Loading…</span>
          )}
        </div>

        {/* Data Summary — opens a popup dialog (non-retractable) */}
        <button
          onClick={() => setShowSummary(true)}
          className="ml-auto h-5 px-2 rounded text-[10px] font-medium transition-colors leading-none shrink-0 border bg-muted text-muted-foreground hover:text-foreground hover:bg-muted/80 border-border"
          title="Open data summary table"
        >
          Data Summary
        </button>
      </div>

      {/* ── Data Summary Popup Dialog — 3-tab pivot table ───────────────── */}
      {showSummary && (
        <DataSummaryPopup
          open={showSummary}
          onClose={() => setShowSummary(false)}
          metric={metric}
          title={title}
          chartData={chartData}
          locReadings={locReadings ?? []}
          productReadings={productReadings ?? []}
          wellReadings={wellReadings ?? []}
          costReadings={costReadings ?? []}
          locatorNames={locatorNames}
          productMeterNames={productMeterNames}
          wellNames={wellNames}
          plantNames={plantNames}
        />
      )}

      <div className={`${chartHeight} w-full relative`} data-testid={`trend-chart-${metric}`}>
        {queryError && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
            <div className="rounded-md border border-rose-300 bg-rose-50/95 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/80 dark:border-rose-900 dark:text-rose-300 shadow-sm pointer-events-auto max-w-md text-center">
              <div className="font-semibold mb-0.5">Couldn't load trend data</div>
              <div className="text-[11px] opacity-80">{queryError.message}</div>
            </div>
          </div>
        )}
        {!queryError && !isFetching && chartData.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
            <div className="rounded-md border border-border/60 bg-card/80 backdrop-blur-sm px-3 py-2 text-xs text-muted-foreground text-center pointer-events-auto max-w-md shadow-sm">
              <div className="font-medium text-foreground">No data in selected range</div>
              <div className="text-[11px] mt-0.5">
                Try a wider range, switch plant, or log readings for {metric === 'nrw' ? 'wells & locators' : metric === 'pv' ? 'wells & power' : metric === 'tds' || metric === 'recovery' ? 'RO trains' : metric === 'productionCost' ? 'power + chemicals (production_costs rollup)' : 'wells'}.
              </div>
            </div>
          </div>
        )}
        <ResponsiveContainer width="100%" height="100%">
          {metric === 'nrw' ? (
            <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
              <YAxis yAxisId="vol" tick={{ fontSize: 10 }} stroke="hsl(var(--chart-1))" tickFormatter={formatYAxis} width={36} label={{ value: 'm³', angle: -90, position: 'insideLeft', fontSize: 9, offset: 8 }} />
              <YAxis yAxisId="pct" orientation="right" tick={{ fontSize: 10 }} stroke="hsl(var(--warn))" width={28} tickFormatter={(v) => `${v}%`} />
              <Tooltip content={<NegativeAwareTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar yAxisId="vol" dataKey="production" fill="hsl(var(--chart-1))" name="Production (m³)" />
              <Bar yAxisId="vol" dataKey="consumption" fill="hsl(var(--chart-2))" name="Consumption (m³)" />
              <Line yAxisId="pct" type="monotone" dataKey="nrw" stroke="hsl(var(--warn))" strokeWidth={2.5} dot={{ r: 3 }} name="NRW %" />
            </ComposedChart>
          ) : metric === 'productionCost' ? (
            // Two-axis composed chart: absolute ₱ amounts on the left,
            // ₱/m³ unit cost on the right. Unit cost lives in a different
            // magnitude bucket (single-digit ₱/m³ vs thousands of ₱) so
            // sharing one axis would either flatten the unit-cost line or
            // crush the totals. Dashed stroke flags it as a derived ratio.
            <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
              <YAxis yAxisId="amt" tick={{ fontSize: 10 }} stroke="hsl(var(--accent))" tickFormatter={formatYAxis} width={36} label={{ value: '₱', angle: -90, position: 'insideLeft', fontSize: 9, offset: 8 }} />
              <YAxis yAxisId="unit" orientation="right" tick={{ fontSize: 10 }} stroke="hsl(var(--warn))" width={28} tickFormatter={(v) => `₱${v}`} />
              <Tooltip content={<NegativeAwareTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line yAxisId="amt" type="monotone" dataKey="totalCost" stroke="hsl(var(--accent))" strokeWidth={2.5} dot={{ r: 2 }} name="Total (₱)" />
              <Line yAxisId="amt" type="monotone" dataKey="powerCost" stroke="hsl(var(--chart-6))" strokeWidth={2} dot={false} name="Power (₱)" />
              <Line yAxisId="amt" type="monotone" dataKey="chemCost" stroke="hsl(var(--highlight))" strokeWidth={2} dot={false} name="Chemical (₱)" />
              <Line yAxisId="unit" type="monotone" dataKey="unitCost" stroke="hsl(var(--warn))" strokeWidth={2} strokeDasharray="4 3" dot={{ r: 2 }} name="₱/m³" connectNulls />
            </ComposedChart>
          ) : (
            <LineChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
              <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" tickFormatter={formatYAxis} width={36} label={{ value: TREND_Y_LABEL[metric] ?? '', angle: -90, position: 'insideLeft', fontSize: 9, offset: 8 }} />
              <Tooltip content={<NegativeAwareTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {metric === 'production' && (<>
                <Line type="monotone" dataKey="production" stroke="hsl(var(--chart-1))" strokeWidth={2} dot={false} name="Production (m³)" />
                <Line type="monotone" dataKey="consumption" stroke="hsl(var(--chart-2))" strokeWidth={2} dot={false} name="Consumption (m³)" />
              </>)}
              {metric === 'rawwater' && (
                <Line type="monotone" dataKey="rawwater" stroke="hsl(var(--chart-1))" strokeWidth={2} dot={false} name="Raw Water (m³)" />
              )}
              {metric === 'recovery' && (
                <Line type="monotone" dataKey="recovery" stroke="hsl(var(--chart-6))" strokeWidth={2} dot={{ r: 2 }} name="Recovery (%)" />
              )}
              {metric === 'tds' && (
                <Line type="monotone" dataKey="tds" stroke="hsl(var(--accent))" strokeWidth={2} dot={false} name="Permeate TDS (ppm)" />
              )}
              {metric === 'pv' && (<>
                <Line type="monotone" dataKey="production" stroke="hsl(var(--chart-1))" strokeWidth={2} dot={false} name="Production (m³)" />
                <Line type="monotone" dataKey="kwh" stroke="hsl(var(--chart-6))" strokeWidth={2} dot={false} name="Power (kWh)" />
              </>)}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </>
  );
}
