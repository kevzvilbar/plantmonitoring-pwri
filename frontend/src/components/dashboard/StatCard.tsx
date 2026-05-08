import { Card } from '@/components/ui/card';
import { StatusPill } from '@/components/StatusPill';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { StatTone, TONE_BG, TONE_ICON } from './types';

// Tiny up/down/flat arrow with percent label. Renders nothing when
// `delta` is null or non-finite. Used inside StatCard to show "vs
// previous day" trends on the highlighted KPIs.
export function TrendBadge({ delta }: { delta: number | null }) {
  if (delta === null || !Number.isFinite(delta)) return null;
  const abs = Math.abs(delta);
  const Icon = abs < 0.5 ? Minus : delta > 0 ? TrendingUp : TrendingDown;
  const cls = abs < 0.5
    ? 'text-muted-foreground'
    : delta > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400';
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] font-medium ${cls}`} title="vs previous day">
      <Icon className="h-3 w-3" />
      {abs < 0.5 ? '0%' : `${abs.toFixed(0)}%`}
    </span>
  );
}

// Standard KPI tile used across the dashboard clusters. Tone drives
// the gradient background + the StatusPill. `calc` swaps in a sky
// gradient + adds a "calc" pill so derived metrics (NRW, PV) read
// distinctly from raw measurements.
export function StatCard({
  icon: Icon, label, value, unit, tone, onClick, accent, calc, threshold,
  size = 'default', trend = null, calcTooltip,
}: {
  icon: any; label: string; value: any; unit?: string;
  tone?: StatTone; onClick?: () => void; accent?: string;
  calc?: boolean; threshold?: string;
  size?: 'default' | 'lg';
  trend?: number | null;
  calcTooltip?: string;
}) {
  const lg = size === 'lg';
  const toneBg = tone ? TONE_BG[tone] : '';
  const calcBg = !tone && calc
    ? 'bg-gradient-to-br from-sky-50/50 to-transparent border-sky-200/60 dark:from-sky-950/25 dark:border-sky-900/40'
    : '';
  const baseBg = !tone && !calc
    ? 'bg-gradient-to-br from-card to-card/60'
    : '';
  const iconCls = tone ? TONE_ICON[tone] : (accent ?? 'text-muted-foreground');
  return (
    <Card
      className={`stat-card min-w-0 hover:border-primary/40 hover:shadow-sm transition-all ${onClick ? 'cursor-pointer' : 'cursor-default'} ${lg ? 'p-3.5' : 'p-3'} ${baseBg} ${toneBg} ${calcBg}`}
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-2">
        <Icon className={`shrink-0 ${lg ? 'h-5 w-5' : 'h-4 w-4'} ${iconCls}`} />
        <div className="flex items-center gap-1">
          {trend !== null && trend !== undefined && <TrendBadge delta={trend} />}
          {calc && (
            <span
              className="text-[9px] uppercase tracking-wider px-1 py-0.5 rounded bg-sky-100 text-sky-700 border border-sky-200 dark:bg-sky-900/40 dark:text-sky-200"
              title={calcTooltip ?? 'Calculated / derived metric'}
            >calc</span>
          )}
          {tone && <StatusPill tone={tone}>•</StatusPill>}
        </div>
      </div>
      <div className={`mt-2 font-mono-num text-foreground leading-none whitespace-nowrap overflow-hidden text-ellipsis ${lg ? 'text-2xl sm:text-3xl' : 'text-xl'}`}>
        {value}
        {unit && <span className={`font-sans text-muted-foreground ml-1 ${lg ? 'text-sm' : 'text-xs'}`}>{unit}</span>}
      </div>
      <div className={`text-muted-foreground mt-1 leading-tight break-words ${lg ? 'text-xs font-medium' : 'text-[11px]'}`}>
        {label}
        {threshold && <span className="ml-1 text-[10px] text-muted-foreground/70">(limit {threshold})</span>}
      </div>
    </Card>
  );
}

// Quality-cluster card that surfaces an aggregate Raw value at the top
// and renders a compact "per-well-source" breakdown beneath. Used for
// Raw TDS and Raw NTU.
//
// Note on schema: Raw TDS / NTU are physically measured at the RO-feed
// inlet (the manifold that BLENDS multiple well sources into a single
// feed line), not at each individual well. So each row in the
// breakdown represents a Raw water source line — labelled with the
// plant code + the source/train number that the manifold feeds. The
// label deliberately says "per well source" (the user's preferred
// wording) rather than "per train" because conceptually the operator
// thinks of these readings as characterising the raw water source, not
// the train hardware. When fewer than 2 sources have data, the
// breakdown collapses to just the aggregate value so we don't render
// a near-empty list.
export function PerWellSourceCard({
  icon: Icon, label, unit, aggregate, rows, field, plantCodeById,
  testId, decimals = 0,
}: {
  icon: any;
  label: string;
  unit: string;
  aggregate: number | null | undefined;
  rows: any[];
  field: 'feed_tds' | 'turbidity_ntu' | 'permeate_tds';
  plantCodeById: Map<string, string>;
  testId: string;
  decimals?: number;
}) {
  // Filter out rows with no reading for this metric — they'd render as
  // "—" and add noise to a list whose whole purpose is to show numbers.
  const liveRows = rows.filter((r) => r[field] != null);
  return (
    <Card
      className="stat-card min-w-0 hover:border-primary/40 hover:shadow-sm transition-all p-3 bg-gradient-to-br from-card to-card/60"
      data-testid={testId}
    >
      <div className="flex items-start justify-between gap-2">
        <Icon className="shrink-0 h-4 w-4 text-muted-foreground" />
        <span
          className="text-[9px] uppercase tracking-wider px-1 py-0.5 rounded bg-muted/60 text-muted-foreground"
          title="Raw water characteristics measured at the RO feed manifold (per well-source line)"
        >
          per well source
        </span>
      </div>
      <div className="mt-2 font-mono-num text-foreground leading-none whitespace-nowrap text-xl">
        {aggregate ?? '—'}
        {unit && <span className="font-sans text-muted-foreground ml-1 text-xs">{unit}</span>}
      </div>
      <div className="text-muted-foreground mt-1 leading-tight text-[11px]">{label}</div>
      {liveRows.length >= 2 && (
        <div className="mt-2 pt-1.5 border-t space-y-0.5 max-h-24 overflow-y-auto">
          {liveRows.map((r) => (
            <div
              key={`${r.plant_id}-${r.train_number}`}
              className="flex items-center justify-between text-[10px]"
            >
              <span className="text-muted-foreground truncate">
                {plantCodeById.get(r.plant_id) ?? '—'} · Source {r.train_number ?? '?'}
              </span>
              <span className="font-mono-num text-foreground/90 tabular-nums shrink-0 ml-2">
                {decimals === 0 ? Math.round(r[field]) : (+r[field]).toFixed(decimals)}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// Section heading shared between the three clusters (Overview /
// Quality / Production Cost). Kept tiny on purpose — the cluster
// header is meant to be glance-able, not a focal element.
export function ClusterHeader({
  icon: Icon, title, subtitle, accent,
}: {
  icon: any; title: string; subtitle?: string; accent?: string;
}) {
  return (
    <div className="flex items-baseline gap-2 mt-1 mb-1.5 px-0.5">
      <Icon className={`h-3.5 w-3.5 ${accent ?? 'text-muted-foreground'}`} />
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
      {subtitle && <span className="text-[10px] text-muted-foreground/70">{subtitle}</span>}
    </div>
  );
}
