// Shared types and constants for the Dashboard cluster components.
// These pieces are factored out of Dashboard.tsx so the page file
// stays focused on data orchestration. Changing a constant or type
// here ripples to StatCard, TrendChart, PowerChart, and the page
// itself.

// View-mode preference for how trend graphs surface on the dashboard.
// Persists to localStorage so a user's "I prefer the popup view" choice
// survives a page reload. Three modes:
//   • inline   — every trend chart is rendered directly below its
//                cluster (no clicks needed; just scroll). Default.
//   • sections — clicking a chart-bearing KPI card folds its trend
//                chart open inline below the cluster. Single-open:
//                clicking another KPI auto-collapses the previous.
//   • popup    — clicking a chart-bearing KPI card opens its trend
//                chart inside a modal Dialog (legacy behaviour).
export type DashboardViewMode = 'inline' | 'sections' | 'popup';

export const VIEW_MODE_KEY = 'pwri:dashboard-view-mode';

// Stored value is a non-sensitive UI preference enum
// ('inline' | 'sections' | 'popup') — no auth/PII goes through this key,
// so localStorage is appropriate. Audit tools may flag this; it's safe.
export function readSavedViewMode(): DashboardViewMode {
  if (typeof window === 'undefined') return 'inline';
  const raw = window.localStorage.getItem(VIEW_MODE_KEY);
  return raw === 'sections' || raw === 'popup' ? raw : 'inline';
}

export type RangeKey = '7D' | '14D' | '30D' | '60D' | '90D' | 'CUSTOM';
export const RANGE_DAYS: Record<Exclude<RangeKey, 'CUSTOM'>, number> = {
  '7D': 7, '14D': 14, '30D': 30, '60D': 60, '90D': 90,
};

export const TREND_Y_LABEL: Record<string, string> = {
  production: 'Volume (m³)',
  rawwater: 'Raw Water (m³)',
  recovery: 'Recovery (%)',
  tds: 'Permeate TDS (ppm)',
  pv: 'kWh · m³',
  productionCost: 'Cost (₱)',
};

export type StatTone = 'accent' | 'warn' | 'danger' | undefined;

export const TONE_BG: Record<NonNullable<StatTone>, string> = {
  accent: 'bg-gradient-to-br from-emerald-50/60 to-transparent border-emerald-200/60 dark:from-emerald-950/25 dark:border-emerald-900/40',
  warn:   'bg-gradient-to-br from-amber-50/70 to-transparent border-amber-200/70 dark:from-amber-950/25 dark:border-amber-900/40',
  danger: 'bg-gradient-to-br from-rose-50/70 to-transparent border-rose-200/70 dark:from-rose-950/30 dark:border-rose-900/50',
};

export const TONE_ICON: Record<NonNullable<StatTone>, string> = {
  accent: 'text-emerald-600 dark:text-emerald-400',
  warn:   'text-amber-600 dark:text-amber-400',
  danger: 'text-rose-600 dark:text-rose-400',
};

// Trend metrics that have an associated chart. Used by ClusterCharts
// to render the inline / collapsed-section views, and to drive the
// click handler on each chart-bearing StatCard. Keys here must match
// the `metric` strings handled inside <TrendChart>.
export type ChartMetric = { metric: string; title: string };

export const OVERVIEW_CHART_METRICS: ChartMetric[] = [
  { metric: 'production', title: 'Production vs Consumption' },
  { metric: 'nrw',        title: 'NRW Trend' },
  { metric: 'rawwater',   title: 'Raw Water (m³)' },
];

export const QUALITY_CHART_METRICS: ChartMetric[] = [
  { metric: 'tds',      title: 'Permeate TDS Trend' },
  { metric: 'recovery', title: 'Recovery Trendline' },
];

export const COST_CHART_METRICS: ChartMetric[] = [
  { metric: 'productionCost', title: 'Production Cost (Power + Chemical)' },
  { metric: 'pv', title: 'PV Ratio Trend' },
];

// Percent delta helper used by trend badges. Returns null when either
// value is non-finite, or when prev === 0 with today != 0 (undefined %).
export function pctDelta(today: number, prev: number): number | null {
  if (!Number.isFinite(today) || !Number.isFinite(prev)) return null;
  if (prev === 0) return today === 0 ? 0 : null;
  return ((today - prev) / prev) * 100;
}
