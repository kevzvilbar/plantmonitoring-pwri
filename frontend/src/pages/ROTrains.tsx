import React, { useState, useMemo, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useAppStore } from '@/store/appStore';
import { usePlants } from '@/hooks/usePlants';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { StatusPill } from '@/components/StatusPill';
import { calc, fmtNum, ALERTS } from '@/lib/calculations';
import { findExistingReading } from '@/lib/duplicateCheck';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { ComputedInput } from '@/components/ComputedInput';
import { ExportButton } from '@/components/ExportButton';
import { cn } from '@/lib/utils';



// ─── Chemical Dosing constants ────────────────────────────────────────────────
const KNOWN_CHEMICALS = [
  { name: 'Chlorine', defaultUnit: 'kg' },
  { name: 'SMBS', defaultUnit: 'kg' },
  { name: 'Anti Scalant', defaultUnit: 'L' },
  { name: 'Soda Ash', defaultUnit: 'kg' },
  { name: 'Caustic Soda', defaultUnit: 'kg' },
  { name: 'HCl', defaultUnit: 'L' },
  { name: 'SLS', defaultUnit: 'g' },
];
const CHEM_UNITS = ['kg', 'g', 'L', 'mL', 'pcs', 'gal', '__custom__'];
const DOSING_KEYS = [
  { key: 'chlorine_kg', name: 'Chlorine', unit: 'kg' },
  { key: 'smbs_kg', name: 'SMBS', unit: 'kg' },
  { key: 'anti_scalant_l', name: 'Anti Scalant', unit: 'L' },
  { key: 'soda_ash_kg', name: 'Soda Ash', unit: 'kg' },
];

export default function ROTrains() {
  return (
    <div className="space-y-3 animate-fade-in">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">RO Trains & Pre-Treatment</h1>

        </div>
      </div>
      <Tabs defaultValue="overview">
        <TabsList className="grid grid-cols-4 w-full">
          <TabsTrigger value="overview" className="data-[state=active]:bg-emerald-600 data-[state=active]:text-white data-[state=active]:shadow-none text-xs sm:text-sm">Overview</TabsTrigger>
          <TabsTrigger value="pretreat-ro" className="data-[state=active]:bg-emerald-600 data-[state=active]:text-white data-[state=active]:shadow-none text-[10px] sm:text-sm leading-tight">Pre-Treatment & RO</TabsTrigger>
          <TabsTrigger value="cip" className="data-[state=active]:bg-emerald-600 data-[state=active]:text-white data-[state=active]:shadow-none text-xs sm:text-sm">CIP</TabsTrigger>
          <TabsTrigger value="chemical-dosing" className="data-[state=active]:bg-emerald-600 data-[state=active]:text-white data-[state=active]:shadow-none text-[10px] sm:text-sm leading-tight">Chemical Dosing</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="mt-3"><Overview /></TabsContent>
        <TabsContent value="pretreat-ro" className="mt-3"><PretreatmentAndROLog /></TabsContent>
        <TabsContent value="cip" className="mt-3"><CIPLog /></TabsContent>
        <TabsContent value="chemical-dosing" className="mt-3"><ChemicalDosing /></TabsContent>
      </Tabs>
    </div>
  );
}

function PlantPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data: plants } = usePlants();
  const { selectedPlantId } = useAppStore();
  // One-shot seed: see PlantPick in Chemicals.tsx for the same pattern.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (selectedPlantId && !value) onChange(selectedPlantId); }, [selectedPlantId]);
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger><SelectValue placeholder="Select plant" /></SelectTrigger>
      <SelectContent>{plants?.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
    </Select>
  );
}

// ─── Sparkline SVG (tiny inline trend line) ──────────────────────────────────
function Sparkline({ values, color = 'currentColor' }: { values: number[]; color?: string }) {
  if (values.length < 2) return <span className="text-[10px] text-muted-foreground/40">—</span>;
  const w = 48; const h = 16;
  const min = Math.min(...values); const max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / range) * h;
    return `${x},${y}`;
  }).join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="inline-block align-middle">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// ─── Effective-status helper ──────────────────────────────────────────────────
// Rules (in priority order):
//   1. Operator manually tagged 'Maintenance' → always Maintenance (hard lock)
//   2. A reading exists within the last 2 hours → Running
//   3. Otherwise → Offline (no recent data)
//
// NOTE: 'Offline' is the DB default for every train, so it must NOT
// short-circuit before the 2-hr data check. Only 'Maintenance' is a
// hard manual override that beats live data. No extra DB column needed.
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

function deriveTrainStatus(train: any, lastReading: any): 'Running' | 'Maintenance' | 'Offline' {
  if (train.status === 'Maintenance') return 'Maintenance';
  // Data-driven: a reading within the last 2 hours means the train is Running
  if (lastReading?.reading_datetime) {
    const age = Date.now() - new Date(lastReading.reading_datetime).getTime();
    if (age <= TWO_HOURS_MS) return 'Running';
  }
  // No recent data → Offline
  return 'Offline';
}

// ─── Overview Dashboard ───────────────────────────────────────────────────────
function Overview() {
  const [plantId, setPlantId] = useState('');
  const [statusFilter, setStatusFilter] = useState<'All' | 'Running' | 'Maintenance' | 'Offline'>('All');
  const [search, setSearch] = useState('');
  const { selectedPlantId, addAlerts, removeAlerts } = useAppStore();

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (selectedPlantId && !plantId) setPlantId(selectedPlantId); }, [selectedPlantId]);

  const { data: trains } = useQuery({
    queryKey: ['ro-overview', plantId],
    queryFn: async () => plantId
      ? (await supabase.from('ro_trains').select('*').eq('plant_id', plantId).order('train_number')).data ?? []
      : [],
    enabled: !!plantId,
  });

  // Fetch last readings for ALL trains at once
  const trainIds = (trains ?? []).map((t: any) => t.id);
  // Join IDs into a stable string so React Query doesn't see a new array reference every render
  const trainIdsKey = trainIds.join(',');
  const { data: lastReadings } = useQuery({
    queryKey: ['ro-last-all', trainIdsKey],
    queryFn: async () => {
      if (!trainIds.length) return {};
      const { data } = await supabase
        .from('ro_train_readings')
        .select('*')
        .in('train_id', trainIds)
        .order('reading_datetime', { ascending: false });
      // Keep only the most recent per train
      const map: Record<string, any> = {};
      for (const r of data ?? []) {
        if (!map[r.train_id]) map[r.train_id] = r;
      }
      return map;
    },
    enabled: trainIds.length > 0,
    // Re-evaluate the 2-hr window every minute so status flips automatically
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  // Fetch last 5 readings per train for sparklines
  const { data: sparkData } = useQuery({
    queryKey: ['ro-spark', trainIdsKey],
    queryFn: async () => {
      if (!trainIds.length) return {};
      const { data } = await supabase
        .from('ro_train_readings')
        .select('train_id, recovery_pct, permeate_tds, reading_datetime')
        .in('train_id', trainIds)
        .order('reading_datetime', { ascending: false })
        .limit(trainIds.length * 6);
      const map: Record<string, any[]> = {};
      for (const r of data ?? []) {
        if (!map[r.train_id]) map[r.train_id] = [];
        if (map[r.train_id].length < 5) map[r.train_id].push(r);
      }
      return map;
    },
    enabled: trainIds.length > 0,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const allReadings = Object.values(lastReadings ?? {});

  // Summary stats — use derived status so the 2-hr rule is reflected in counts
  const onlineCount  = (trains ?? []).filter((t: any) => deriveTrainStatus(t, lastReadings?.[t.id]) === 'Running').length;
  const maintCount   = (trains ?? []).filter((t: any) => deriveTrainStatus(t, lastReadings?.[t.id]) === 'Maintenance').length;
  const offlineCount = (trains ?? []).filter((t: any) => deriveTrainStatus(t, lastReadings?.[t.id]) === 'Offline').length;
  const avgRecovery    = allReadings.filter(r => r.recovery_pct != null).length
    ? (allReadings.reduce((s, r) => s + (r.recovery_pct ?? 0), 0) / allReadings.filter(r => r.recovery_pct != null).length).toFixed(1)
    : null;
  const avgPermTDS     = allReadings.filter(r => r.permeate_tds != null).length
    ? (allReadings.reduce((s, r) => s + (r.permeate_tds ?? 0), 0) / allReadings.filter(r => r.permeate_tds != null).length).toFixed(0)
    : null;
  const totalTrains    = (trains ?? []).length;
  const healthScore    = totalTrains ? Math.round((onlineCount / totalTrains) * 100) : null;

  const PERM_TDS_LIMIT = 600; // ppm — alert threshold
  const highTDSTrains  = (trains ?? []).filter((t: any) => {
    const reading = lastReadings?.[t.id];
    return reading?.permeate_tds != null && reading.permeate_tds > PERM_TDS_LIMIT;
  });

  // ── Sync high-TDS trains into the global Plant Alert panel & bell ────────
  // Runs whenever readings refresh (every 60s). Upserts by stable id so the
  // bell count and PlantAlertPanel stay in sync without duplicate entries.
  useEffect(() => {
    if (!plantId) return;
    if (highTDSTrains.length === 0) {
      // Clear any previously-pushed TDS alerts for this plant's trains
      const ids = (trains ?? []).map((t: any) => `high-tds-${t.id}`);
      removeAlerts(ids);
      return;
    }
    const alerts = highTDSTrains.map((t: any) => {
      const tds = lastReadings?.[t.id]?.permeate_tds;
      return {
        id: `high-tds-${t.id}`,
        severity: 'critical' as const,
        title: 'High Permeate TDS',
        description: `Train ${t.train_number}${t.name ? ` (${t.name})` : ''}: ${fmtNum(tds, 0)} ppm — above ${PERM_TDS_LIMIT} ppm limit`,
        source: 'RO Trains',
        plantId,
        timestamp: Date.now(),
      };
    });
    addAlerts(alerts);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highTDSTrains.length, plantId]);

  const filtered = (trains ?? []).filter((t: any) => {
    const effectiveStatus = deriveTrainStatus(t, lastReadings?.[t.id]);
    const matchStatus = statusFilter === 'All' || effectiveStatus === statusFilter;
    const matchSearch = !search || `train ${t.train_number}`.toLowerCase().includes(search.toLowerCase()) || String(t.train_number).includes(search);
    return matchStatus && matchSearch;
  });

  const STATUS_FILTERS = ['All', 'Running', 'Maintenance', 'Offline'] as const;
  const statusColor = (s: string) =>
    s === 'Running' ? 'text-emerald-500' : s === 'Maintenance' ? 'text-amber-500' : s === 'Offline' ? 'text-red-500' : 'text-foreground';

  return (
    <div className="space-y-3">
      {/* ── Controls row ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2 items-end">
        <div className="min-w-[160px] flex-1">
          <Label className="text-[11px] text-muted-foreground">Plant</Label>
          <PlantPicker value={plantId} onChange={setPlantId} />
        </div>
        {/* Status filter pills */}
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-[11px] text-muted-foreground mr-1">Show:</span>
          {STATUS_FILTERS.map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={cn(
                'px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors',
                statusFilter === s
                  ? 'bg-primary text-primary-foreground border-primary'
                  : cn('border-border bg-muted/50 hover:bg-muted', statusColor(s))
              )}>
              {s}
            </button>
          ))}
        </div>
        {/* Search */}
        <div className="relative min-w-[160px]">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-[12px]">🔍</span>
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search train…"
            className="w-full h-9 pl-7 pr-3 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>

      {/* ── Summary cards ─────────────────────────────────────────────── */}
      {plantId && (
        <div className="grid grid-cols-3 gap-2">
          {/* Plant Health */}
          <Card className="p-3 space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Plant Health</p>
            <div className="flex items-end gap-2">
              <span className={cn('text-2xl font-bold font-mono-num', healthScore != null && healthScore >= 80 ? 'text-emerald-500' : healthScore != null && healthScore >= 50 ? 'text-amber-500' : 'text-red-500')}>
                {healthScore != null ? `${healthScore}%` : '—'}
              </span>
              <span className={cn('text-[11px] font-medium pb-0.5', healthScore != null && healthScore >= 80 ? 'text-emerald-500' : 'text-amber-500')}>
                {healthScore != null && healthScore >= 80 ? 'Optimal' : healthScore != null && healthScore >= 50 ? 'Degraded' : 'Critical'}
              </span>
            </div>
            <div className="flex gap-2 text-[10px] text-muted-foreground flex-wrap">
              <span className="text-emerald-500 font-medium">● {onlineCount} Online</span>
              <span className="text-amber-500 font-medium">● {maintCount} Maint.</span>
              <span className="text-red-500 font-medium">● {offlineCount} Offline</span>
            </div>
          </Card>

          {/* Production Summary */}
          <Card className="p-3 space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Avg Recovery</p>
            <div className="flex items-end gap-2">
              <span className="text-2xl font-bold font-mono-num text-foreground">
                {avgRecovery != null ? `${avgRecovery}%` : '—'}
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground">{totalTrains} trains total · {onlineCount} active</p>
          </Card>

          {/* Product Quality */}
          <Card className="p-3 space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Avg Perm TDS</p>
            <div className="flex items-end gap-2">
              <span className="text-2xl font-bold font-mono-num text-foreground">
                {avgPermTDS != null ? `${avgPermTDS} ppm` : '—'}
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground">Last readings · all trains</p>
          </Card>
        </div>
      )}


      {/* ── Train grid ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {filtered.map((t: any) => (
          <TrainCard
            key={t.id}
            train={t}
            last={lastReadings?.[t.id] ?? null}
            spark={sparkData?.[t.id] ?? []}
          />
        ))}
      </div>
      {plantId && !filtered.length && (
        <Card className="p-4 text-xs text-center text-muted-foreground">No trains match your filter</Card>
      )}
      {!plantId && (
        <Card className="p-4 text-xs text-center text-muted-foreground">Select a plant to view trains</Card>
      )}
    </div>
  );
}

function TrainCard({ train, last, spark }: { train: any; last: any; spark: any[] }) {
  const status: string = deriveTrainStatus(train, last);
  const statusBadge = {
    Running:     { label: 'Online',      dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400', border: 'border-emerald-200 dark:border-emerald-800' },
    Maintenance: { label: 'Maintenance', dot: 'bg-amber-500',   text: 'text-amber-600 dark:text-amber-400',     border: 'border-amber-200 dark:border-amber-800' },
    Offline:     { label: 'Offline',     dot: 'bg-red-500',     text: 'text-red-600 dark:text-red-400',         border: 'border-red-200 dark:border-red-800' },
  }[status] ?? { label: status, dot: 'bg-muted-foreground', text: 'text-muted-foreground', border: 'border-border' };

  const recovery   = last?.recovery_pct  != null ? `${fmtNum(last.recovery_pct, 1)}%`  : '—';
  const permTDS    = last?.permeate_tds  != null ? `${fmtNum(last.permeate_tds, 0)} ppm` : '—';
  const lastTime   = last?.reading_datetime ? format(new Date(last.reading_datetime), 'hh:mm:ss aa') : '—';

  const recoveryVals = spark.map((r: any) => r.recovery_pct).filter((v: any) => v != null).reverse();
  const tdsVals      = spark.map((r: any) => r.permeate_tds).filter((v: any) => v != null).reverse();

  const recWarn  = last?.recovery_pct != null && (last.recovery_pct < 65 || last.recovery_pct > 75);
  const tdsWarn  = last?.permeate_tds != null && last.permeate_tds > 600;

  return (
    <Card className={cn('p-3 space-y-1.5 border', statusBadge.border)}>
      {/* Header */}
      <div className="flex items-center justify-between gap-1">
        <div className="flex items-center gap-1.5">
          <span className="text-base">🌊</span>
          <span className="text-sm font-semibold">Train {train.train_number}</span>
        </div>
        <div className={cn('flex items-center gap-1 text-[11px] font-medium', statusBadge.text)}>
          <span className={cn('h-1.5 w-1.5 rounded-full', statusBadge.dot)} />
          {statusBadge.label}
        </div>
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <span>Recovery:</span>
        <span className={cn('font-mono-num font-semibold', recWarn ? 'text-amber-500' : 'text-foreground')}>
          {recovery}
        </span>
        <Sparkline values={recoveryVals} color={recWarn ? '#f59e0b' : '#6b7280'} />
        <span className="ml-1">·</span>
        <span>Perm TDS:</span>
        <span className={cn('font-mono-num font-semibold', tdsWarn ? 'text-red-500' : 'text-foreground')}>
          {permTDS}
        </span>
        <Sparkline values={tdsVals} color={tdsWarn ? '#ef4444' : '#6b7280'} />
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between text-[10px] text-muted-foreground pt-0.5 border-t border-border/50">
        <span>Last reading: {lastTime}</span>
        <div className="flex gap-2">
          {train.num_afm > 0 && <span className="font-medium">AFM×{train.num_afm}</span>}
          {train.num_booster_pumps > 0 && <span className="font-medium">BP×{train.num_booster_pumps}</span>}
        </div>
      </div>
    </Card>
  );
}

type AfmRow = {
  unit: number;
  bw: boolean;
  bwStart: string;
  bwEnd: string;
  meterStart: string;
  meterEnd: string;
  pressureIn: string;
  pressureOut: string;
};

function PretreatmentAndROLog() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const { selectedPlantId } = useAppStore();
  const { data: plants } = usePlants();
  const [plantId, setPlantId] = useState('');
  const [trainId, setTrainId] = useState('');
  const [dt, setDt] = useState(format(new Date(), "yyyy-MM-dd'T'HH:mm"));

  // Plant-wide synchronized backwash window (only used when plant.backwash_mode = 'synchronized')
  const [syncBwOn, setSyncBwOn] = useState(false);
  const [syncBwStart, setSyncBwStart] = useState('');
  const [syncBwEnd, setSyncBwEnd] = useState('');
  const [syncMeterStart, setSyncMeterStart] = useState('');
  const [syncMeterEnd, setSyncMeterEnd] = useState('');

  const [hppTarget, setHppTarget] = useState('');
  const [bagsChanged, setBagsChanged] = useState('0');
  const [remarks, setRemarks] = useState('');

  // RO Train online/offline status
  const [trainOnline, setTrainOnline] = useState(true);
  const [offlineStart, setOfflineStart] = useState('');
  const [offlineEnd, setOfflineEnd] = useState('');
  const [offlineReason, setOfflineReason] = useState('');
  const [offlineReasonOther, setOfflineReasonOther] = useState('');

  // RO Train readings
  const [roValues, setRoValues] = useState({
    feed_pressure_psi: '', reject_pressure_psi: '',
    feed_flow: '', permeate_flow: '', reject_flow: '',
    feed_tds: '', permeate_tds: '', reject_tds: '',
    feed_ph: '', permeate_ph: '', reject_ph: '',
    turbidity_ntu: '', temperature_c: '', suction_pressure_psi: '',
    feed_meter_curr: '',
    permeate_meter_curr: '',
    reject_meter_curr: '',
    power_meter_curr: '',
  });

  // One-shot seed: when the global selectedPlantId resolves and this
  // page hasn't picked a plant yet, default to it. Re-seeding on
  // plantId change is undesirable (would clobber the user's choice),
  // so plantId is intentionally omitted from deps.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (selectedPlantId && !plantId) setPlantId(selectedPlantId); }, [selectedPlantId]);

  const plant = useMemo(() => plants?.find((p) => p.id === plantId), [plants, plantId]);
  const isSynchronized = (plant as any)?.backwash_mode === 'synchronized';

  const { data: trains } = useQuery({
    queryKey: ['pretreat-trains', plantId],
    queryFn: async () => plantId
      ? (await supabase.from('ro_trains').select('*').eq('plant_id', plantId).order('train_number')).data ?? []
      : [],
    enabled: !!plantId,
  });
  const train = useMemo(() => trains?.find((t: any) => t.id === trainId), [trains, trainId]);

  // Pull the most recent pre-treatment reading for this train so we can default
  // the new form's "Meter Reading Start" to the previous backwash end value.
  const { data: prevPretreat } = useQuery({
    queryKey: ['pretreat-prev', trainId],
    enabled: !!trainId,
    queryFn: async () => (await supabase.from('ro_pretreatment_readings')
      .select('mmf_readings').eq('train_id', trainId)
      .order('reading_datetime', { ascending: false }).limit(1)).data?.[0] ?? null,
  });
  const prevMeterEndByUnit: Record<number, number | null> = useMemo(() => {
    const out: Record<number, number | null> = {};
    const arr = (prevPretreat?.mmf_readings ?? []) as any[];
    for (const r of arr) {
      if (r?.unit != null) out[+r.unit] = r.meter_end ?? null;
    }
    return out;
  }, [prevPretreat]);

  // Pull the most recent RO train reading to auto-fill prev meter readings + duration
  // NOTE: feed_meter_curr/permeate_meter_curr/reject_meter_curr/power_meter_curr do NOT exist
  // as DB columns — they are local-only calc inputs. We store the computed volumes instead.
  // The prev reading's datetime is all we need for duration auto-compute.
  const { data: prevRO } = useQuery({
    queryKey: ['ro-prev', trainId],
    enabled: !!trainId,
    queryFn: async () => (await supabase.from('ro_train_readings')
      .select('reading_datetime')
      .eq('train_id', trainId)
      .order('reading_datetime', { ascending: false }).limit(1)).data?.[0] ?? null,
  });

  // Auto-compute duration (min) between current reading datetime and last reading datetime
  const autoDurationMin = useMemo(() => {
    if (!prevRO?.reading_datetime || !dt) return null;
    const diff = (new Date(dt).getTime() - new Date(prevRO.reading_datetime).getTime()) / 60000;
    return diff > 0 ? +diff.toFixed(1) : null;
  }, [prevRO, dt]);

  // Previous meter readings: these are local-only inputs — the DB does not store raw meter
  // current readings, only the computed delta volumes. So prev values cannot be auto-filled
  // from the last reading; the operator must enter them manually each session.
  const prevFeedMeter  = null;
  const prevPermMeter  = null;
  const prevRejMeter   = null;
  const prevPowerMeter = null;

  // Per-AFM/MMF rows: independent backwash + reading + pressure
  const [afmmf, setAfmmf] = useState<Record<number, AfmRow>>({});
  const [boosters, setBoosters] = useState<Record<number, { hz: string; target: string; amp: string; psiMode: boolean }>>({});
  const [housings, setHousings] = useState<Record<number, { inP: string; outP: string }>>({});

  useEffect(() => {
    setAfmmf({}); setBoosters({}); setHousings({});
    setSyncBwOn(false); setSyncBwStart(''); setSyncBwEnd('');
    setSyncMeterStart(''); setSyncMeterEnd('');
    setTrainOnline(true); setOfflineStart(''); setOfflineEnd('');
    setOfflineReason(''); setOfflineReasonOther('');
    setRoValues({
      feed_pressure_psi: '', reject_pressure_psi: '',
      feed_flow: '', permeate_flow: '', reject_flow: '',
      feed_tds: '', permeate_tds: '', reject_tds: '',
      feed_ph: '', permeate_ph: '', reject_ph: '',
      turbidity_ntu: '', temperature_c: '', suction_pressure_psi: '',
      feed_meter_curr: '',
      permeate_meter_curr: '',
      reject_meter_curr: '',
      power_meter_curr: '',
    });
  }, [trainId]);

  // Prefill the synchronized shared meter start when we discover the
  // previous backwash end value. Intentionally NOT depending on
  // `syncMeterStart` — re-running when the user types into the field
  // would overwrite their input. The `syncMeterStart === ''` guard
  // already prevents over-writes for the initial seed case.
  useEffect(() => {
    if (!isSynchronized) return;
    const firstUnit = Object.keys(prevMeterEndByUnit)[0];
    const v = firstUnit != null ? prevMeterEndByUnit[+firstUnit] : null;
    if (v != null && syncMeterStart === '') setSyncMeterStart(String(v));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prevMeterEndByUnit, isSynchronized]);

  const setAfmmfField = (u: number, patch: Partial<AfmRow>) => setAfmmf((p) => ({
    ...p,
    [u]: {
      unit: u, bw: false, bwStart: '', bwEnd: '',
      meterStart: '', meterEnd: '', pressureIn: '', pressureOut: '',
      ...(p[u] ?? {}), ...patch,
    },
  }));

  // RO calculations
  const num = (s: string) => s ? +s : NaN;
  const dp = calc.pressureDiff(num(roValues.feed_pressure_psi), num(roValues.reject_pressure_psi));

  // ── Water meter derived flow rates (m³/hr) ──────────────────────────────
  // Duration: auto from datetime diff; prev readings: auto from last session's curr
  const mDur   = autoDurationMin ?? NaN;
  const mDurHr = !isNaN(mDur) && mDur > 0 ? mDur / 60 : null;

  const feedCurr = num(roValues.feed_meter_curr);
  const permCurr = num(roValues.permeate_meter_curr);
  const rejCurr  = num(roValues.reject_meter_curr);

  const feedDelta  = !isNaN(feedCurr) && prevFeedMeter != null ? feedCurr - prevFeedMeter : null;
  const permDelta  = !isNaN(permCurr) && prevPermMeter != null ? permCurr - prevPermMeter : null;
  const rejDelta   = !isNaN(rejCurr)  && prevRejMeter  != null ? rejCurr  - prevRejMeter  : null;

  // Dynamic filling: any one missing = sum/diff of the other two (requires at least two streams entered)
  const feedVol  = feedDelta  ?? (permDelta !== null && rejDelta  !== null ? +(permDelta  + rejDelta ).toFixed(3) : null);
  const permVol  = permDelta  ?? (feedDelta !== null && rejDelta  !== null ? +(feedDelta  - rejDelta ).toFixed(3) : null);
  const rejVol   = rejDelta   ?? (feedDelta !== null && permDelta !== null ? +(feedDelta  - permDelta).toFixed(3) : null);

  const feedFlowMeter  = feedVol  !== null && mDurHr ? +(feedVol  / mDurHr).toFixed(2) : null;
  const permFlowMeter  = permVol  !== null && mDurHr ? +(permVol  / mDurHr).toFixed(2) : null;
  const rejFlowMeter   = rejVol   !== null && mDurHr ? +(rejVol   / mDurHr).toFixed(2) : null;

  // True if the volume was inferred (not directly entered)
  const feedInferred = feedDelta === null && feedVol !== null;
  const permInferred = permDelta === null && permVol !== null;
  const rejInferred  = rejDelta  === null && rejVol  !== null;

  // ── Effective flow values: EM 3-way inference ──────────────────────────
  // Enter any 2 EM values → third is auto-computed. Enter all 3 to override.
  const emFeedFlow  = roValues.feed_flow     ? num(roValues.feed_flow)     : null;
  const emPermFlow  = roValues.permeate_flow ? num(roValues.permeate_flow) : null;
  const emRejFlow   = roValues.reject_flow   ? num(roValues.reject_flow)   : null;

  const emEntered = [emFeedFlow, emPermFlow, emRejFlow].filter(v => v !== null).length;

  // Infer the missing EM value when exactly 2 are entered
  const effFeedFlow: number | null = (() => {
    if (emFeedFlow !== null) return emFeedFlow;
    if (emEntered === 2 && emPermFlow !== null && emRejFlow !== null)
      return +((emPermFlow + emRejFlow).toFixed(2));
    return feedFlowMeter;
  })();
  const effPermFlow: number | null = (() => {
    if (emPermFlow !== null) return emPermFlow;
    if (emEntered === 2 && emFeedFlow !== null && emRejFlow !== null)
      return +((emFeedFlow - emRejFlow).toFixed(2));
    return permFlowMeter;
  })();
  const effRejFlow: number | null = (() => {
    if (emRejFlow !== null) return emRejFlow;
    if (emEntered === 2 && emFeedFlow !== null && emPermFlow !== null)
      return +((emFeedFlow - emPermFlow).toFixed(2));
    // fallback: compute from effective feed/perm (meter-derived)
    const fb = emFeedFlow ?? feedFlowMeter;
    const pb = emPermFlow ?? permFlowMeter;
    if (fb !== null && pb !== null) return +((fb - pb).toFixed(2));
    return rejFlowMeter;
  })();

  // Inferred flags (not user-typed, computed from the other two)
  const emFeedInferred = emFeedFlow === null && emEntered === 2 && emPermFlow !== null && emRejFlow !== null;
  const emPermInferred = emPermFlow === null && emEntered === 2 && emFeedFlow !== null && emRejFlow !== null;
  const emRejInferred  = emRejFlow  === null && emEntered >= 1 && effRejFlow !== null && !(emFeedFlow === null && emPermFlow === null);

  // Recovery uses effective flows (EM > meter-derived)
  const recovery    = effPermFlow !== null && effFeedFlow !== null && effFeedFlow > 0
    ? +((effPermFlow / effFeedFlow) * 100).toFixed(1) : null;
  const rejection   = calc.rejection(num(roValues.permeate_tds), num(roValues.reject_tds));
  const saltPassage = calc.saltPassage(num(roValues.permeate_tds), num(roValues.reject_tds));
  const rejectFlow  = effRejFlow;

  const phWarn = num(roValues.permeate_ph) && (num(roValues.permeate_ph) < 6.5 || num(roValues.permeate_ph) > 8.5);
  const recWarn = recovery != null && (recovery < 65 || recovery > 75);
  const dpAlert = dp != null && dp >= ALERTS.dp_max;

  // Train is offline and no end time entered → block all RO parameter inputs
  const isOfflineBlocked = !trainOnline && !offlineEnd;
  const offlineReasonFinal = offlineReason === 'Other' ? offlineReasonOther : offlineReason;

  // ── Power meter ──────────────────────────────────────────────────────────
  // Duration reuses the same auto-computed interval; prev reading from last session
  const pwrDurHr = mDurHr;  // same time window as water meter
  const pwrCurr  = num(roValues.power_meter_curr);
  const pwrDelta = !isNaN(pwrCurr) && prevPowerMeter != null
    ? +(pwrCurr - prevPowerMeter).toFixed(3)
    : null;
  const pwrKw    = pwrDelta !== null && pwrDurHr ? +(pwrDelta / pwrDurHr).toFixed(2) : null;  // avg kW
  // Specific energy uses effective permeate volume (meter-derived preferred for volumetric accuracy)
  const secEnergy = pwrDelta !== null && permVol && permVol > 0                               // kWh/m³
    ? +(pwrDelta / permVol).toFixed(3) : null;

  const submit = async () => {
    if (!plantId || !trainId) { toast.error('Select plant and train'); return; }

    // Offline validation
    if (!trainOnline) {
      if (!offlineStart) { toast.error('Please enter the time the train went offline.'); return; }
      if (!offlineReason) { toast.error('Please select a reason for the offline event.'); return; }
      if (offlineReason === 'Other' && !offlineReasonOther.trim()) { toast.error('Please specify the reason for offline.'); return; }
    }

    // Check for duplicate RO reading
    const dup = await findExistingReading({
      table: 'ro_train_readings', entityCol: 'train_id', entityId: trainId,
      datetime: new Date(dt), windowKind: 'hour',
    });
    if (dup) {
      toast.error('A reading already exists for this train within this hour. Edit it from the Overview tab to avoid duplicates.');
      return;
    }

    // Save RO Train reading.
    // Confirmed DB columns in ro_train_readings (from original working code):
    //   feed_pressure_psi, reject_pressure_psi, feed_flow, permeate_flow, reject_flow,
    //   feed_tds, permeate_tds, reject_tds, feed_ph, permeate_ph, reject_ph,
    //   turbidity_ntu, temperature_c, suction_pressure_psi,
    //   dp_psi, recovery_pct, rejection_pct, salt_passage_pct, recorded_by.
    // Excluded (local-only, no DB column): feed_meter_curr, permeate_meter_curr,
    //   reject_meter_curr, power_meter_curr.
    // To save volume/power data, first confirm exact column names in your Supabase schema.
    const EXCLUDED_KEYS = new Set([
      'feed_meter_curr', 'permeate_meter_curr', 'reject_meter_curr', 'power_meter_curr',
    ]);
    const roPayload: any = {
      train_id: trainId, plant_id: plantId, reading_datetime: new Date(dt).toISOString(),
      ...Object.fromEntries(
        Object.entries(roValues)
          .filter(([k]) => !EXCLUDED_KEYS.has(k))
          .map(([k, val]) => [k, val ? +val : null])
      ),
      reject_flow: rejectFlow ?? (roValues.reject_flow ? +roValues.reject_flow : null),
      dp_psi: dp,
      recovery_pct: recovery,
      rejection_pct: rejection,
      salt_passage_pct: saltPassage,
      recorded_by: user?.id,
    };
    const { error: roError } = await supabase.from('ro_train_readings').insert(roPayload);
    if (roError) { toast.error(`RO reading error: ${roError.message}`); return; }

    // ── Sync train status in DB only for manual overrides ────────────────────
    // Submitting a reading as Online clears a prior manual Offline tag so the
    // 2-hr rule takes back over. We never write 'Running' unprompted — the
    // derived status handles that automatically via the last reading timestamp.
    if (!trainOnline) {
      await supabase.from('ro_trains').update({ status: 'Offline' }).eq('id', trainId);
    } else if (train?.status === 'Offline') {
      await supabase.from('ro_trains').update({ status: 'Running' }).eq('id', trainId);
    }

    // Save pre-treatment reading
    // mmf_readings keeps per-unit meter start/end (synchronized = shared values across all units)
    const rowsArr = Object.values(afmmf);
    const mmf_readings = isSynchronized
      ? (syncBwOn && (syncMeterStart || syncMeterEnd)
          ? Array.from({ length: train.num_afm }, (_, i) => i + 1).map((u) => ({
              unit: u,
              meter_start: syncMeterStart ? +syncMeterStart : null,
              meter_end: syncMeterEnd ? +syncMeterEnd : null,
            }))
          : [])
      : rowsArr.filter((r) => r.bw && (r.meterStart || r.meterEnd))
          .map((r) => ({
            unit: r.unit,
            meter_start: r.meterStart ? +r.meterStart : null,
            meter_end: r.meterEnd ? +r.meterEnd : null,
          }));

    // Merge backwash + inlet/outlet pressures into the single afm_units jsonb column
    const afm_units = rowsArr
      .filter((r) => r.bw || r.pressureIn || r.pressureOut)
      .map((r) => {
        const pIn = r.pressureIn ? +r.pressureIn : null;
        const pOut = r.pressureOut ? +r.pressureOut : null;
        const dp_psi = pIn !== null && pOut !== null ? +(pIn - pOut).toFixed(2) : null;
        const bwOngoing = isSynchronized ? syncBwOn : r.bw;
        return {
          unit: r.unit,
          backwash_start: bwOngoing
            ? (isSynchronized
                ? (syncBwStart ? new Date(syncBwStart).toISOString() : null)
                : (r.bwStart ? new Date(r.bwStart).toISOString() : null))
            : null,
          backwash_end: bwOngoing
            ? (isSynchronized
                ? (syncBwEnd ? new Date(syncBwEnd).toISOString() : null)
                : (r.bwEnd ? new Date(r.bwEnd).toISOString() : null))
            : null,
          inlet_psi: bwOngoing ? null : pIn,
          outlet_psi: bwOngoing ? null : pOut,
          dp_psi: bwOngoing ? null : dp_psi,
        };
      });

    const booster_pumps = Object.entries(boosters).filter(([, v]) => v.hz || v.target || v.amp)
      .map(([k, v]) => ({ unit: +k, target_pressure_psi: v.target ? +v.target : null, amperage: v.amp ? +v.amp : null }));
    const filter_housings = Object.entries(housings).filter(([, v]) => v.inP || v.outP)
      .map(([k, v]) => ({ unit: +k, in_psi: v.inP ? +v.inP : null, out_psi: v.outP ? +v.outP : null }));

    const { error: pretreatError } = await supabase.from('ro_pretreatment_readings').insert({
      plant_id: plantId, train_id: trainId,
      reading_datetime: new Date(dt).toISOString(),
      backwash_start: isSynchronized && syncBwOn && syncBwStart ? new Date(syncBwStart).toISOString() : null,
      backwash_end: isSynchronized && syncBwOn && syncBwEnd ? new Date(syncBwEnd).toISOString() : null,
      mmf_readings, booster_pumps, afm_units, filter_housings,
      hpp_target_pressure_psi: hppTarget ? +hppTarget : null,
      bag_filters_changed: +bagsChanged || 0,
      remarks: remarks || null,
      recorded_by: user?.id,
    });
    if (pretreatError) { toast.error(`Pre-treatment error: ${pretreatError.message}`); return; }

    toast.success('Pre-treatment & RO reading saved');
    setAfmmf({}); setBoosters({}); setHousings({});
    setSyncBwOn(false); setSyncBwStart(''); setSyncBwEnd('');
    setSyncMeterStart(''); setSyncMeterEnd('');
    setHppTarget(''); setBagsChanged('0'); setRemarks('');
    // Reset offline state (train reverts to online after a successful save)
    setTrainOnline(true); setOfflineStart(''); setOfflineEnd(''); setOfflineReason(''); setOfflineReasonOther('');
    setRoValues({
      feed_pressure_psi: '', reject_pressure_psi: '',
      feed_flow: '', permeate_flow: '', reject_flow: '',
      feed_tds: '', permeate_tds: '', reject_tds: '',
      feed_ph: '', permeate_ph: '', reject_ph: '',
      turbidity_ntu: '', temperature_c: '', suction_pressure_psi: '',
      feed_meter_curr: '',
      permeate_meter_curr: '',
      reject_meter_curr: '',
      power_meter_curr: '',
    });
    qc.invalidateQueries();
  };

  const f = (k: keyof typeof roValues) => ({ value: roValues[k], onChange: (e: any) => setRoValues({ ...roValues, [k]: e.target.value }) });

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-2">
        <p className="text-sm text-muted-foreground">AFM/MMF, Boosters, Filter Housings & RO Vessel</p>
        <ExportButton table="ro_pretreatment_readings" filters={plantId ? { plant_id: plantId } : undefined} />
      </div>

      <Card className="p-3 space-y-3">
        {/* Plant + Train row — with online/offline toggle */}
        <div className="grid grid-cols-2 gap-2 max-w-md">
          <div>
            <Label>Plant</Label>
            <Select value={plantId} onValueChange={(v) => { setPlantId(v); setTrainId(''); }}>
              <SelectTrigger className="h-9"><SelectValue placeholder="Select Plant" /></SelectTrigger>
              <SelectContent>{plants?.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <Label>Train</Label>
            <Select value={trainId} onValueChange={setTrainId} disabled={!plantId}>
              <SelectTrigger className="h-9"><SelectValue placeholder="Select Train" /></SelectTrigger>
              <SelectContent>{trains?.map((t: any) => (
                <SelectItem key={t.id} value={t.id}>{t.name ?? `Train ${t.train_number}`}</SelectItem>
              ))}</SelectContent>
            </Select>
          </div>
        </div>

        {/* Online / Offline toggle — shown once a train is picked */}
        {train && (
          <div className={cn(
            'rounded-md border px-3 py-2.5 flex items-center gap-3 transition-colors',
            trainOnline
              ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30'
              : 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30'
          )}>
            <Checkbox
              id="train-online"
              checked={trainOnline}
              onCheckedChange={(c) => {
                setTrainOnline(!!c);
                if (!!c) { setOfflineStart(''); setOfflineEnd(''); setOfflineReason(''); setOfflineReasonOther(''); }
              }}
              className={trainOnline ? 'data-[state=checked]:bg-emerald-600 data-[state=checked]:border-emerald-600' : ''}
            />
            <div className="flex-1 min-w-0">
              <label htmlFor="train-online" className={cn(
                'text-sm font-semibold cursor-pointer select-none',
                trainOnline ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-400'
              )}>
                {trainOnline ? '● Online / Running' : '○ Offline / Not Running'}
              </label>
              {!trainOnline && (
                <p className="text-[10px] text-red-600 dark:text-red-400 mt-0.5">
                  RO parameters locked until offline period is resolved or train comes back online
                </p>
              )}
            </div>
          </div>
        )}

        {/* Offline details — shown when train is marked offline */}
        {train && !trainOnline && (
          <div className="space-y-2.5 rounded-md border border-red-200 dark:border-red-800 bg-red-50/60 dark:bg-red-950/20 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-red-700 dark:text-red-400">Offline Details</p>

            {/* Reason dropdown */}
            <div>
              <Label className="text-[11px] text-muted-foreground">Reason for Offline <span className="text-red-500">*</span></Label>
              <Select value={offlineReason} onValueChange={setOfflineReason}>
                <SelectTrigger className="h-9 mt-0.5 border-red-200 dark:border-red-700">
                  <SelectValue placeholder="Select reason…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Scheduled Maintenance">Scheduled Maintenance</SelectItem>
                  <SelectItem value="Membrane Replacement">Membrane Replacement</SelectItem>
                  <SelectItem value="CIP In Progress">CIP In Progress</SelectItem>
                  <SelectItem value="Power Outage">Power Outage</SelectItem>
                  <SelectItem value="High Pressure Trip">High Pressure Trip</SelectItem>
                  <SelectItem value="Low Feed Flow">Low Feed Flow</SelectItem>
                  <SelectItem value="Instrumentation Fault">Instrumentation Fault</SelectItem>
                  <SelectItem value="Pump Failure">Pump Failure</SelectItem>
                  <SelectItem value="Feedwater Quality Issue">Feedwater Quality Issue</SelectItem>
                  <SelectItem value="Operator Shutdown">Operator Shutdown</SelectItem>
                  <SelectItem value="Other">Other (specify below)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Free-text for Other */}
            {offlineReason === 'Other' && (
              <div>
                <Label className="text-[11px] text-muted-foreground">Specify reason <span className="text-red-500">*</span></Label>
                <Input
                  value={offlineReasonOther}
                  onChange={e => setOfflineReasonOther(e.target.value)}
                  placeholder="Describe the reason…"
                  className="mt-0.5 border-red-200 dark:border-red-700"
                />
              </div>
            )}

            {/* Offline start / end times */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <Label className="text-[11px] text-muted-foreground">
                  Offline Since <span className="text-red-500">*</span>
                </Label>
                <Input
                  type="datetime-local"
                  value={offlineStart}
                  onChange={e => setOfflineStart(e.target.value)}
                  className="mt-0.5 w-full min-w-[200px] border-red-200 dark:border-red-700"
                />
              </div>
              <div>
                <Label className="text-[11px] text-muted-foreground">
                  Back Online At
                  <span className="ml-1 text-[10px] font-normal text-muted-foreground">(leave blank if still offline)</span>
                </Label>
                <Input
                  type="datetime-local"
                  value={offlineEnd}
                  onChange={e => setOfflineEnd(e.target.value)}
                  className="mt-0.5 w-full min-w-[200px] border-red-200 dark:border-red-700"
                />
              </div>
            </div>

            {/* Status banner */}
            {!offlineEnd && offlineStart && (
              <div className="flex items-center gap-2 text-[11px] text-red-700 dark:text-red-400 bg-red-100 dark:bg-red-900/30 rounded px-2.5 py-1.5">
                <span className="inline-block h-2 w-2 rounded-full bg-red-500 animate-pulse shrink-0" />
                Train is currently offline — RO parameters cannot be logged until it comes back online.
              </div>
            )}
            {offlineEnd && offlineStart && (
              <div className="flex items-center gap-2 text-[11px] text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/30 rounded px-2.5 py-1.5">
                <span className="inline-block h-2 w-2 rounded-full bg-emerald-500 shrink-0" />
                Offline period recorded — you may now log RO parameters for the resumed period.
              </div>
            )}
          </div>
        )}

        <div>
          <Label>Reading Date &amp; Time</Label>
          <Input type="datetime-local" value={dt} onChange={(e) => setDt(e.target.value)}
            className="h-10 w-full sm:max-w-[260px] min-w-[220px]" />
        </div>
        {plant && (
          <div className="text-[11px] text-muted-foreground">
            Backwash mode: <span className="font-semibold">{isSynchronized ? 'Synchronized (Whole Train at Once)' : 'Independent (Per Unit)'}</span>
          </div>
        )}
      </Card>

      {train && (
        <>
          {/* ── Offline gate: lock all parameter inputs when train is offline with no end time ── */}
          {isOfflineBlocked && (
            <Card className="p-4 border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/20">
              <div className="flex items-start gap-3">
                <span className="text-2xl leading-none mt-0.5">🔒</span>
                <div>
                  <p className="text-sm font-semibold text-red-700 dark:text-red-400">Train is currently offline</p>
                  <p className="text-xs text-red-600 dark:text-red-400 mt-1">
                    No RO parameters can be logged while the train is offline and no "Back Online At" time has been entered.
                    Enter the time the train came back online above, or mark the train as Online to continue logging.
                  </p>
                </div>
              </div>
            </Card>
          )}

          {!isOfflineBlocked && (
          <>
          {isSynchronized && (
            <Card className="p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Checkbox id="sync-bw" checked={syncBwOn} onCheckedChange={(c) => setSyncBwOn(!!c)} />
                <Label htmlFor="sync-bw" className="text-sm font-semibold cursor-pointer">Train Backwash Performed?</Label>
              </div>
              {syncBwOn && (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div>
                      <Label className="text-[11px] text-muted-foreground">Started</Label>
                      <Input type="datetime-local" value={syncBwStart} onChange={(e) => setSyncBwStart(e.target.value)} className="w-full min-w-[220px]" />
                    </div>
                    <div>
                      <Label className="text-[11px] text-muted-foreground">Ended</Label>
                      <Input type="datetime-local" value={syncBwEnd} onChange={(e) => setSyncBwEnd(e.target.value)} className="w-full min-w-[220px]" />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div>
                      <Label className="text-[11px] text-muted-foreground">Meter Reading Start</Label>
                      <Input type="number" step="any" value={syncMeterStart}
                        onChange={(e) => setSyncMeterStart(e.target.value)}
                        placeholder="From Previous Backwash End" />
                    </div>
                    <div>
                      <Label className="text-[11px] text-muted-foreground">Meter Reading End</Label>
                      <Input type="number" step="any" value={syncMeterEnd} onChange={(e) => setSyncMeterEnd(e.target.value)} />
                    </div>
                  </div>
                  <p className="text-[10px] text-muted-foreground">All AFM/MMF Units Share These Values During Backwash. Start Value Pre-Filled From Previous Backwash End — Edit If Needed.</p>
                </>
              )}
            </Card>
          )}

          {train.num_afm > 0 && (
            <Card className="p-3 space-y-2">
              <h4 className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">AFM/MMF Units ({train.num_afm})</h4>
              <div className="space-y-2">
                {Array.from({ length: train.num_afm }, (_, i) => i + 1).map((u) => {
                  const row = afmmf[u] ?? { unit: u, bw: false, bwStart: '', bwEnd: '', meterStart: '', meterEnd: '', pressureIn: '', pressureOut: '' };
                  const pIn = row.pressureIn ? +row.pressureIn : null;
                  const pOut = row.pressureOut ? +row.pressureOut : null;
                  const afmDp = pIn !== null && pOut !== null ? (pIn - pOut).toFixed(2) : '';
                  const dpWarn = afmDp && +afmDp >= 40;
                  // backwash ongoing? in synchronized mode it's the train-wide checkbox; in independent it's per-unit
                  const bwOngoing = isSynchronized ? syncBwOn : row.bw;
                  const prevEnd = prevMeterEndByUnit[u];
                  const meterStartValue = row.meterStart !== '' ? row.meterStart : (prevEnd != null ? String(prevEnd) : '');
                  return (
                    <div key={u} className="border rounded-md p-2 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-sm font-medium">AFM/MMF {u}</div>
                        {!isSynchronized && (
                          <div className="flex items-center gap-2">
                            <Checkbox id={`bw-${u}`} checked={row.bw} onCheckedChange={(c) => setAfmmfField(u, { bw: !!c })} />
                            <Label htmlFor={`bw-${u}`} className="text-xs cursor-pointer">Backwash On</Label>
                          </div>
                        )}
                      </div>

                      {bwOngoing ? (
                        // Backwash ongoing → show meter start/end (+ time for independent mode); pressure hidden
                        <div className="space-y-2 bg-muted/30 rounded p-2">
                          {!isSynchronized && (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                              <div>
                                <Label className="text-[11px] text-muted-foreground">Started</Label>
                                <Input type="datetime-local" value={row.bwStart}
                                  onChange={(e) => setAfmmfField(u, { bwStart: e.target.value })}
                                  className="w-full min-w-[220px]" />
                              </div>
                              <div>
                                <Label className="text-[11px] text-muted-foreground">Ended</Label>
                                <Input type="datetime-local" value={row.bwEnd}
                                  onChange={(e) => setAfmmfField(u, { bwEnd: e.target.value })}
                                  className="w-full min-w-[220px]" />
                              </div>
                            </div>
                          )}
                          {isSynchronized ? (
                            <p className="text-[10px] text-muted-foreground">
                              Train-Wide Backwash {syncBwStart || '—'} → {syncBwEnd || '—'} · Meter {syncMeterStart || '—'} → {syncMeterEnd || '—'}
                            </p>
                          ) : (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                              <div>
                                <Label className="text-[11px] text-muted-foreground">Meter Reading Start</Label>
                                <Input type="number" step="any" value={meterStartValue}
                                  onChange={(e) => setAfmmfField(u, { meterStart: e.target.value })}
                                  placeholder={prevEnd != null ? String(prevEnd) : 'From Previous Backwash End'} />
                                {prevEnd != null && (
                                  <p className="text-[10px] text-muted-foreground mt-0.5">Previous End: {prevEnd} (Editable)</p>
                                )}
                              </div>
                              <div>
                                <Label className="text-[11px] text-muted-foreground">Meter Reading End</Label>
                                <Input type="number" step="any" value={row.meterEnd}
                                  onChange={(e) => setAfmmfField(u, { meterEnd: e.target.value })} />
                              </div>
                            </div>
                          )}
                        </div>
                      ) : (
                        // No backwash → always-visible pressure In/Out (per unit)
                        <div className="grid grid-cols-3 gap-2">
                          <div>
                            <Label className="text-[11px] text-muted-foreground">Pressure In (psi)</Label>
                            <Input type="number" step="any" value={row.pressureIn}
                              onChange={(e) => setAfmmfField(u, { pressureIn: e.target.value })} />
                          </div>
                          <div>
                            <Label className="text-[11px] text-muted-foreground">Pressure Out (psi)</Label>
                            <Input type="number" step="any" value={row.pressureOut}
                              onChange={(e) => setAfmmfField(u, { pressureOut: e.target.value })} />
                          </div>
                          <div>
                            <Label className="text-[11px] text-muted-foreground">ΔPressure</Label>
                            <ComputedInput value={afmDp} className={dpWarn ? 'border-danger text-danger font-semibold' : 'text-foreground font-medium'} />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {train.num_booster_pumps > 0 && (() => {
            // Shared psi/Hz mode toggle — applies to all pumps at once
            const anyPsi = Object.values(boosters).some(b => b.psiMode !== false);
            const globalPsiMode = Object.keys(boosters).length === 0 ? true : anyPsi;
            const setGlobalMode = (psi: boolean) => {
              const next: typeof boosters = {};
              Array.from({ length: train.num_booster_pumps }, (_, i) => i + 1).forEach(u => {
                const b = boosters[u] || { hz: '', target: '', amp: '', psiMode: true };
                next[u] = { ...b, psiMode: psi, hz: '', target: '' };
              });
              setBoosters(next);
            };
            return (
              <Card className="p-3 space-y-2.5">
                {/* Header row: title left, psi/Hz toggle right */}
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-foreground">
                    Booster Pumps ({train.num_booster_pumps})
                  </h4>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground">Target</span>
                    <div className="flex rounded-full border border-border overflow-hidden text-[11px] font-semibold">
                      <button
                        type="button"
                        onClick={() => setGlobalMode(true)}
                        className={cn(
                          'px-3 py-1 transition-colors',
                          globalPsiMode
                            ? 'bg-teal-700 text-white'
                            : 'bg-background text-muted-foreground hover:bg-muted'
                        )}
                      >psi</button>
                      <button
                        type="button"
                        onClick={() => setGlobalMode(false)}
                        className={cn(
                          'px-3 py-1 transition-colors',
                          !globalPsiMode
                            ? 'bg-teal-700 text-white'
                            : 'bg-background text-muted-foreground hover:bg-muted'
                        )}
                      >Hz</button>
                    </div>
                  </div>
                </div>

                {/* Column headers */}
                <div className="grid grid-cols-[72px_1fr_1fr_1fr] gap-x-3 gap-y-0 items-end">
                  <div />
                  <div className="text-[11px] text-muted-foreground font-medium text-center">psi</div>
                  <div className="text-[11px] text-muted-foreground font-medium text-center">Hz</div>
                  <div className="text-[11px] text-muted-foreground font-medium text-center">Amperage (A)</div>
                </div>

                {/* Pump rows */}
                <div className="space-y-2">
                  {Array.from({ length: train.num_booster_pumps }, (_, i) => i + 1).map((u) => {
                    const b = boosters[u] || { hz: '', target: '', amp: '', psiMode: true };
                    const psiMode = b.psiMode !== false;
                    const setB = (patch: Partial<typeof b>) =>
                      setBoosters({ ...boosters, [u]: { ...b, ...patch } });
                    return (
                      <div key={u} className="grid grid-cols-[72px_1fr_1fr_1fr] gap-x-3 items-center">
                        <span className="text-sm font-semibold text-foreground">Pump {u}</span>
                        {/* psi input */}
                        <Input
                          type="number" step="any"
                          value={psiMode ? b.target : ''}
                          disabled={!psiMode}
                          placeholder={psiMode ? 'Enter psi' : '—'}
                          className={cn(
                            'text-center placeholder:text-[10px] placeholder:text-muted-foreground/40 rounded-lg',
                            !psiMode && 'opacity-35 cursor-not-allowed bg-muted/30'
                          )}
                          onChange={(e) => setB({ target: e.target.value })}
                        />
                        {/* Hz input */}
                        <Input
                          type="number" step="any"
                          value={!psiMode ? b.hz : ''}
                          disabled={psiMode}
                          placeholder={!psiMode ? 'Enter Hz' : '—'}
                          className={cn(
                            'text-center placeholder:text-[10px] placeholder:text-muted-foreground/40 rounded-lg',
                            psiMode && 'opacity-35 cursor-not-allowed bg-muted/30'
                          )}
                          onChange={(e) => setB({ hz: e.target.value })}
                        />
                        {/* Amperage */}
                        <Input
                          type="number" step="any"
                          value={b.amp}
                          placeholder="Enter A"
                          className="text-center placeholder:text-[10px] placeholder:text-muted-foreground/40 rounded-lg"
                          onChange={(e) => setB({ amp: e.target.value })}
                        />
                      </div>
                    );
                  })}
                </div>

                {/* Mode hint */}
                <p className="text-[9px] text-muted-foreground/50 italic">
                  {globalPsiMode ? 'psi mode — Hz column locked. Tap psi/Hz to switch.' : 'Hz mode — psi column locked. Tap psi/Hz to switch.'}
                </p>
              </Card>
            );
          })()}

          <Card className="p-3 space-y-2">
            <h4 className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">High-Pressure Pump</h4>
            <div>
              <Label className="text-[11px] text-muted-foreground">HPP Target Pressure (psi)</Label>
              <Input type="number" step="any" value={hppTarget} onChange={(e) => setHppTarget(e.target.value)} />
            </div>
          </Card>

          {train.num_filter_housings > 0 && (
            <Card className="p-3 space-y-2">
              <h4 className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">Filter Housings ({train.num_filter_housings})</h4>
              {Array.from({ length: train.num_filter_housings }, (_, i) => i + 1).map((u) => {
                const inP = +(housings[u]?.inP ?? '');
                const outP = +(housings[u]?.outP ?? '');
                const housingDp = housings[u]?.inP && housings[u]?.outP ? (inP - outP).toFixed(2) : '';
                return (
                  <div key={u} className="grid grid-cols-4 gap-2 items-center">
                    <div className="text-xs font-medium self-center">Housing {u}</div>
                    <div>
                      <Label className="text-[11px] text-muted-foreground">In (psi)</Label>
                      <Input type="number" step="any" value={housings[u]?.inP ?? ''}
                        onChange={(e) => setHousings({ ...housings, [u]: { ...(housings[u] || { outP: '' }), inP: e.target.value } })} />
                    </div>
                    <div>
                      <Label className="text-[11px] text-muted-foreground">Out (psi)</Label>
                      <Input type="number" step="any" value={housings[u]?.outP ?? ''}
                        onChange={(e) => setHousings({ ...housings, [u]: { ...(housings[u] || { inP: '' }), outP: e.target.value } })} />
                    </div>
                    <div>
                      <Label className="text-[11px] text-muted-foreground">ΔPressure</Label>
                      <ComputedInput value={housingDp} className="text-foreground font-medium" />
                    </div>
                  </div>
                );
              })}
              <div className="pt-2">
                <Label className="text-[11px] text-muted-foreground">Bag Filters Changed Today</Label>
                <Input type="number" min="0" value={bagsChanged} onChange={(e) => setBagsChanged(e.target.value)} />
              </div>
            </Card>
          )}

          {/* RO Vessel Section — tri-column process flow: Feed → Permeate → Reject */}
          <Card className="p-3 space-y-3">
            <h4 className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">RO Vessel</h4>

            {/* Column headers */}
            <div className="grid grid-cols-3 gap-2">
              <div className="flex items-center gap-1.5 rounded-md bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 px-2 py-1.5">
                <span className="h-2 w-2 rounded-full bg-blue-500 shrink-0" />
                <span className="text-[11px] font-semibold text-blue-700 dark:text-blue-300">Feed / Raw</span>
              </div>
              <div className="flex items-center gap-1.5 rounded-md bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 px-2 py-1.5">
                <span className="h-2 w-2 rounded-full bg-emerald-500 shrink-0" />
                <span className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">Permeate / Product</span>
              </div>
              <div className="flex items-center gap-1.5 rounded-md bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 px-2 py-1.5">
                <span className="h-2 w-2 rounded-full bg-amber-500 shrink-0" />
                <span className="text-[11px] font-semibold text-amber-700 dark:text-amber-300">Reject / Concentrate</span>
              </div>
            </div>

            {/* ── Water Meter ─────────────────────────────────────────────── */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70 px-0.5">Water Meter</p>
                <p className="text-[10px] text-muted-foreground/60 italic">Leave one stream blank — it will be inferred</p>
              </div>
              {/* Auto-computed duration from datetime diff */}
              <div className="flex items-center gap-2 mb-1">
                <Label className="text-[11px] text-muted-foreground shrink-0">Duration (min)</Label>
                <ComputedInput
                  value={autoDurationMin != null ? String(autoDurationMin) : ''}
                  className="h-7 text-xs w-28"
                />
                {autoDurationMin == null && (
                  <span className="text-[10px] text-muted-foreground/60 italic">— no prior reading found</span>
                )}
              </div>
              {/* current / prev (auto) / Δ / flow columns */}
              <div className="grid grid-cols-3 gap-2">
                {/* Feed */}
                <div className="space-y-1">
                  <div>
                    <Label className="text-[11px] text-muted-foreground">Prev reading (auto)</Label>
                    <ComputedInput value={prevFeedMeter != null ? String(prevFeedMeter) : ''} className="text-foreground font-medium" />
                  </div>
                  <div>
                    <Label className="text-[11px] text-muted-foreground">Feed Meter Reading</Label>
                    <Input type="number" step="any" {...f('feed_meter_curr')} placeholder="Input current feed reading" className="placeholder:text-[10px] placeholder:text-muted-foreground/50" />
                  </div>
                  <div>
                    <Label className={cn('text-[11px]', feedInferred ? 'text-blue-600 dark:text-blue-400' : 'text-muted-foreground')}>
                      Feed Volume{feedInferred ? ' (inferred)' : ''} (m³)
                    </Label>
                    <ComputedInput value={feedVol != null ? String(feedVol) : ''} className={feedInferred ? 'border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 font-medium' : 'text-foreground font-medium'} />
                  </div>
                  <div>
                    <Label className="text-[11px] text-muted-foreground">Feed Flowrate (m³/hr)</Label>
                    <ComputedInput value={feedFlowMeter != null ? String(feedFlowMeter) : ''} className="text-foreground font-medium" />
                  </div>
                </div>
                {/* Permeate */}
                <div className="space-y-1">
                  <div>
                    <Label className="text-[11px] text-muted-foreground">Prev reading (auto)</Label>
                    <ComputedInput value={prevPermMeter != null ? String(prevPermMeter) : ''} className="text-foreground font-medium" />
                  </div>
                  <div>
                    <Label className="text-[11px] text-muted-foreground">Permeate Meter Reading</Label>
                    <Input type="number" step="any" {...f('permeate_meter_curr')} placeholder="Input current permeate reading" className="placeholder:text-[10px] placeholder:text-muted-foreground/50" />
                  </div>
                  <div>
                    <Label className={cn('text-[11px]', permInferred ? 'text-blue-600 dark:text-blue-400' : 'text-muted-foreground')}>
                      Permeate Volume{permInferred ? ' (inferred)' : ''} (m³)
                    </Label>
                    <ComputedInput value={permVol != null ? String(permVol) : ''} className={permInferred ? 'border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 font-medium' : 'text-foreground font-medium'} />
                  </div>
                  <div>
                    <Label className="text-[11px] text-muted-foreground">Permeate Flowrate (m³/hr)</Label>
                    <ComputedInput value={permFlowMeter != null ? String(permFlowMeter) : ''} className="text-foreground font-medium" />
                  </div>
                </div>
                {/* Reject */}
                <div className="space-y-1">
                  <div>
                    <Label className="text-[11px] text-muted-foreground">Prev reading (auto)</Label>
                    <ComputedInput value={prevRejMeter != null ? String(prevRejMeter) : ''} className="text-foreground font-medium" />
                  </div>
                  <div>
                    <Label className="text-[11px] text-muted-foreground">Reject Meter Reading</Label>
                    <Input type="number" step="any" {...f('reject_meter_curr')} placeholder="Input current reject reading" className="placeholder:text-[10px] placeholder:text-muted-foreground/50" />
                  </div>
                  <div>
                    <Label className={cn('text-[11px]', rejInferred ? 'text-blue-600 dark:text-blue-400' : 'text-muted-foreground')}>
                      Reject Volume{rejInferred ? ' (inferred)' : ''} (m³)
                    </Label>
                    <ComputedInput value={rejVol != null ? String(rejVol) : ''} className={rejInferred ? 'border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 font-medium' : 'text-foreground font-medium'} />
                  </div>
                  <div>
                    <Label className="text-[11px] text-muted-foreground">Reject Flowrate (m³/hr)</Label>
                    <ComputedInput value={rejFlowMeter != null ? String(rejFlowMeter) : ''} className="text-foreground font-medium" />
                  </div>
                </div>
              </div>
            </div>

            {/* ── Pressure row ────────────────────────────────────────────── */}
            <div className="space-y-0.5">
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70 px-0.5">Pressure (psi)</p>
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1.5">
                  <div>
                    <Label className="text-[11px] text-muted-foreground">Suction</Label>
                    <Input type="number" step="any" {...f('suction_pressure_psi')}
                      placeholder="Suction pressure" className="placeholder:text-[10px] placeholder:text-muted-foreground/50" />
                  </div>
                  <div>
                    <Label className="text-[11px] text-muted-foreground">Feed</Label>
                    <Input type="number" step="any" {...f('feed_pressure_psi')}
                      placeholder="Feed pressure" className="placeholder:text-[10px] placeholder:text-muted-foreground/50" />
                  </div>
                </div>
                <div className="flex flex-col justify-end">
                  <Label className="text-[11px] text-muted-foreground">ΔP (feed − reject)</Label>
                  <ComputedInput value={dp ?? ''} className={dpAlert ? 'border-danger text-danger font-semibold' : 'text-foreground font-medium'} />
                </div>
                <div className="flex flex-col justify-end">
                  <Label className="text-[11px] text-muted-foreground">Reject</Label>
                  <Input type="number" step="any" {...f('reject_pressure_psi')}
                    placeholder="Reject pressure" className="placeholder:text-[10px] placeholder:text-muted-foreground/50" />
                </div>
              </div>
            </div>

            {/* ── EM flow override ────────────────────────────────────────── */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70 px-0.5">
                  Electromagnetic Flowmeter (m³/hr)
                </p>
                <p className="text-[10px] text-muted-foreground/60 italic">
                  {emEntered === 0 && 'Enter any two — third auto-computes'}
                  {emEntered === 1 && 'Enter one more — third will be computed'}
                  {emEntered === 2 && 'One value computed from the other two'}
                  {emEntered === 3 && 'All three manually entered'}
                </p>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {/* Feed EM */}
                <div className="space-y-1">
                  <Label className={cn('text-[11px]', emFeedInferred ? 'text-blue-600 dark:text-blue-400' : 'text-muted-foreground')}>
                    Feed Flowrate{emFeedInferred ? ' (computed)' : ''}
                  </Label>
                  {emFeedInferred ? (
                    <ComputedInput
                      value={effFeedFlow != null ? String(effFeedFlow) : ''}
                      className="border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 font-semibold"
                    />
                  ) : (
                    <Input type="number" step="any" {...f('feed_flow')}
                      placeholder={feedFlowMeter != null ? `≈ ${feedFlowMeter} (meter)` : 'EM reading'}
                      className="placeholder:text-[10px] placeholder:text-muted-foreground/50" />
                  )}
                </div>
                {/* Permeate EM */}
                <div className="space-y-1">
                  <Label className={cn('text-[11px]', emPermInferred ? 'text-blue-600 dark:text-blue-400' : 'text-muted-foreground')}>
                    Permeate Flowrate{emPermInferred ? ' (computed)' : ''}
                  </Label>
                  {emPermInferred ? (
                    <ComputedInput
                      value={effPermFlow != null ? String(effPermFlow) : ''}
                      className="border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 font-semibold"
                    />
                  ) : (
                    <Input type="number" step="any" {...f('permeate_flow')}
                      placeholder={permFlowMeter != null ? `≈ ${permFlowMeter} (meter)` : 'EM reading'}
                      className="placeholder:text-[10px] placeholder:text-muted-foreground/50" />
                  )}
                  <div className="mt-1">
                    <Label className={cn('text-[11px]', recWarn ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')}>
                      Recovery %{recWarn ? ' ⚠' : ''}
                    </Label>
                    <ComputedInput value={recovery != null ? String(recovery) : ''} className={recWarn ? 'border-warn text-warn-foreground font-semibold' : 'text-foreground font-medium'} />
                  </div>
                </div>
                {/* Reject EM */}
                <div className="space-y-1">
                  <Label className={cn('text-[11px]', emRejInferred ? 'text-blue-600 dark:text-blue-400' : 'text-muted-foreground')}>
                    Reject Flowrate{emRejInferred ? ' (computed)' : ''}
                  </Label>
                  {emRejInferred ? (
                    <ComputedInput
                      value={effRejFlow != null ? String(effRejFlow) : ''}
                      className="border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 font-semibold"
                    />
                  ) : (
                    <Input type="number" step="any" {...f('reject_flow')}
                      placeholder={rejFlowMeter != null ? `≈ ${rejFlowMeter} (meter)` : 'EM reading'}
                      className="placeholder:text-[10px] placeholder:text-muted-foreground/50" />
                  )}
                </div>
              </div>
            </div>

            {/* ── TDS row ──────────────────────────────────────────────────── */}
            <div className="space-y-0.5">
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70 px-0.5">TDS (ppm)</p>
              <div className="grid grid-cols-3 gap-2">
                <div><Label className="text-[11px] text-muted-foreground">Feed TDS</Label><Input type="number" step="any" {...f('feed_tds')} /></div>
                <div><Label className="text-[11px] text-muted-foreground">Permeate TDS</Label><Input type="number" step="any" {...f('permeate_tds')} /></div>
                <div><Label className="text-[11px] text-muted-foreground">Reject TDS</Label><Input type="number" step="any" {...f('reject_tds')} /></div>
              </div>
              {/* Rejection + Salt Passage in their own row below TDS inputs */}
              <div className="grid grid-cols-2 gap-2 pt-1">
                <div>
                  <Label className="text-[11px] text-muted-foreground">Rejection %</Label>
                  <ComputedInput value={rejection ?? ''} className="text-foreground font-medium" />
                </div>
                <div>
                  <Label className="text-[11px] text-muted-foreground">Salt Passage %</Label>
                  <ComputedInput value={saltPassage ?? ''} className="text-foreground font-medium" />
                </div>
              </div>
            </div>

            {/* ── pH row ───────────────────────────────────────────────────── */}
            <div className="space-y-0.5">
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70 px-0.5">pH</p>
              <div className="grid grid-cols-3 gap-2">
                <div><Label className="text-[11px] text-muted-foreground">Feed pH</Label><Input type="number" step="any" {...f('feed_ph')} /></div>
                <div><Label className="text-[11px] text-muted-foreground">Permeate pH</Label><Input type="number" step="any" {...f('permeate_ph')} className={phWarn ? 'border-warn' : ''} /></div>
                <div><Label className="text-[11px] text-muted-foreground">Reject pH</Label><Input type="number" step="any" {...f('reject_ph')} /></div>
              </div>
            </div>

            {/* ── Product quality / ambient ────────────────────────────────── */}
            <div className="space-y-0.5">
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70 px-0.5">Product Quality</p>
              <div className="grid grid-cols-2 gap-2">
                <div><Label className="text-[11px] text-muted-foreground">Product Turbidity (NTU)</Label><Input type="number" step="any" {...f('turbidity_ntu')} /></div>
                <div><Label className="text-[11px] text-muted-foreground">Product Temperature (°C)</Label><Input type="number" step="any" {...f('temperature_c')} /></div>
              </div>
            </div>
          </Card>

          {/* ── Power Meter ──────────────────────────────────────────────────── */}
          <Card className="p-3 space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">Power Meter</h4>
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/70">
                <span>Duration:</span>
                <span className="font-mono font-medium">{autoDurationMin != null ? `${autoDurationMin} min` : '—'}</span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-[11px] text-muted-foreground">Prev reading (kWh) — auto</Label>
                <ComputedInput value={prevPowerMeter != null ? String(prevPowerMeter) : ''} className="text-foreground font-medium" />
              </div>
              <div><Label className="text-[11px] text-muted-foreground">Current reading (kWh)</Label><Input type="number" step="any" {...f('power_meter_curr')} /></div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <Label className="text-[11px] text-muted-foreground">Δ Consumption (kWh)</Label>
                <ComputedInput value={pwrDelta ?? ''} className="text-foreground font-medium" />
              </div>
              <div>
                <Label className="text-[11px] text-muted-foreground">Avg power (kW)</Label>
                <ComputedInput value={pwrKw ?? ''} className="text-foreground font-medium" />
              </div>
              <div>
                <Label className="text-[11px] text-muted-foreground">Specific energy (kWh/m³)</Label>
                <ComputedInput value={secEnergy ?? ''} className="text-foreground font-medium" />
              </div>
            </div>
          </Card>

          <Card className="p-3 space-y-2">
            <Label className="text-[11px] text-muted-foreground">Remarks</Label>
            <Textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Any observations..." />
          </Card>

          <Button onClick={submit} className="w-full h-12 text-base">Save Pre-Treatment & RO Reading</Button>
          </>
          )}
        </>
      )}

      {!train && plantId && (
        <Card className="p-4 text-center text-xs text-muted-foreground">Select a train to log pre-treatment and RO data</Card>
      )}
    </div>
  );
}

// ─── CIP Volumetric & Analytics ───────────────────────────────────────────────
// Per-vessel flow rate — two methods:
//   A) Water Meter Delta:  Q = ΔV / Δt   (ΔV = curr−prev m³, Δt in hr)
//   B) Manual Bucket Test: Q = V_bucket / t_fill  (e.g. 20 L ÷ seconds → L/min → m³/hr)
// Comparative analytics: Δ volume recovery, Δ TDS, Δ cost/efficiency (pre vs post CIP)

// ─── Per-vessel flow row ──────────────────────────────────────────────────────
type VesselFlowMethod = 'meter' | 'manual';
type VesselFlowRow = {
  id: number;
  method: VesselFlowMethod;
  // meter delta
  prevMeter: string; currMeter: string;
  prevTime: string;  currTime: string;
  // manual bucket
  bucketVol: string;   // L
  fillTimeSec: string; // seconds
};

function VesselFlowCard({ row, onChange }: { row: VesselFlowRow; onChange: (patch: Partial<VesselFlowRow>) => void }) {
  // ── Meter method calcs ────────────────────────────────────────────────────
  const deltaV_m3 = (row.currMeter !== '' && row.prevMeter !== '')
    ? +((+row.currMeter) - (+row.prevMeter)).toFixed(4) : null;
  const deltaT_hr = useMemo(() => {
    if (!row.prevTime || !row.currTime) return null;
    const diff = (new Date(row.currTime).getTime() - new Date(row.prevTime).getTime()) / 3600000;
    return diff > 0 ? +diff.toFixed(4) : null;
  }, [row.prevTime, row.currTime]);
  const qMeter = (deltaV_m3 !== null && deltaT_hr !== null && deltaT_hr > 0)
    ? +((deltaV_m3) / deltaT_hr).toFixed(4) : null;

  // ── Manual bucket calcs ───────────────────────────────────────────────────
  // Q (L/min) = bucketVol(L) / fillTime(s) × 60
  // Q (m³/hr) = Q(L/min) / 1000 × 60
  const bVol = +row.bucketVol || 0;
  const bSec = +row.fillTimeSec || 0;
  const qLperMin  = (bVol > 0 && bSec > 0) ? +((bVol / bSec) * 60).toFixed(3) : null;
  const qManual   = qLperMin !== null ? +((qLperMin / 1000) * 60).toFixed(4) : null;

  const Q = row.method === 'meter' ? qMeter : qManual;
  const hasResult = Q !== null;

  return (
    <div className={cn(
      'rounded-xl border-2 p-3 space-y-2.5 transition-colors',
      hasResult ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50/30 dark:bg-emerald-950/20' : 'border-border bg-muted/10'
    )}>
      {/* Vessel label + method toggle */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-xs font-bold text-foreground">Vessel {row.id}</span>
        <div className="flex rounded-full border border-border overflow-hidden text-[10px] font-semibold">
          <button type="button" onClick={() => onChange({ method: 'meter' })}
            className={cn('px-2.5 py-0.5 transition-colors',
              row.method === 'meter' ? 'bg-teal-700 text-white' : 'bg-background text-muted-foreground hover:bg-muted')}>
            📟 Meter
          </button>
          <button type="button" onClick={() => onChange({ method: 'manual' })}
            className={cn('px-2.5 py-0.5 transition-colors',
              row.method === 'manual' ? 'bg-teal-700 text-white' : 'bg-background text-muted-foreground hover:bg-muted')}>
            🪣 Bucket
          </button>
        </div>
      </div>

      {/* ── Method A: Water Meter Delta ─────────────────────────────── */}
      {row.method === 'meter' && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-1.5">
            <div>
              <Label className="text-[10px] text-muted-foreground">Prev meter (m³)</Label>
              <Input type="number" step="any" value={row.prevMeter}
                onChange={e => onChange({ prevMeter: e.target.value })}
                placeholder="e.g. 102.40" className="h-8 text-xs" />
            </div>
            <div>
              <Label className="text-[10px] text-muted-foreground">Curr meter (m³)</Label>
              <Input type="number" step="any" value={row.currMeter}
                onChange={e => onChange({ currMeter: e.target.value })}
                placeholder="e.g. 108.75" className="h-8 text-xs" />
            </div>
            <div>
              <Label className="text-[10px] text-muted-foreground">Prev date & time</Label>
              <Input type="datetime-local" value={row.prevTime}
                onChange={e => onChange({ prevTime: e.target.value })}
                className="h-8 text-[10px]" />
            </div>
            <div>
              <Label className="text-[10px] text-muted-foreground">Curr date & time</Label>
              <Input type="datetime-local" value={row.currTime}
                onChange={e => onChange({ currTime: e.target.value })}
                className="h-8 text-[10px]" />
            </div>
          </div>
          {/* ΔV + Δt inline chips */}
          <div className="flex gap-1.5 flex-wrap">
            <span className={cn('text-[10px] px-2 py-0.5 rounded-full border font-mono-num',
              deltaV_m3 !== null ? 'border-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300'
                                 : 'border-border bg-muted/30 text-muted-foreground')}>
              ΔV = {deltaV_m3 !== null ? `${deltaV_m3} m³` : '—'}
            </span>
            <span className={cn('text-[10px] px-2 py-0.5 rounded-full border font-mono-num',
              deltaT_hr !== null ? 'border-blue-300 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                                 : 'border-border bg-muted/30 text-muted-foreground')}>
              Δt = {deltaT_hr !== null ? `${deltaT_hr} hr` : '—'}
            </span>
          </div>
        </div>
      )}

      {/* ── Method B: Manual Bucket Test ────────────────────────────── */}
      {row.method === 'manual' && (
        <div className="space-y-2">
          <div className="rounded-md bg-muted/40 border border-border px-2.5 py-1.5 text-[10px] text-muted-foreground leading-relaxed">
            Fill a container to a known volume (e.g. 20 L), measure the time in seconds.
            <span className="font-mono ml-1 text-foreground">Q = V ÷ t × 60 (L/min)</span>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <div>
              <Label className="text-[10px] text-muted-foreground">Container volume (L)</Label>
              <Input type="number" step="any" value={row.bucketVol}
                onChange={e => onChange({ bucketVol: e.target.value })}
                placeholder="20" className="h-8 text-xs" />
            </div>
            <div>
              <Label className="text-[10px] text-muted-foreground">Fill time (seconds)</Label>
              <Input type="number" step="any" value={row.fillTimeSec}
                onChange={e => onChange({ fillTimeSec: e.target.value })}
                placeholder="e.g. 45" className="h-8 text-xs" />
            </div>
          </div>
          {/* Intermediate L/min chip */}
          {qLperMin !== null && (
            <span className="inline-block text-[10px] px-2 py-0.5 rounded-full border border-blue-300 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-mono-num">
              {qLperMin} L/min
            </span>
          )}
        </div>
      )}

      {/* ── Q result strip ───────────────────────────────────────────── */}
      <div className={cn(
        'rounded-lg px-3 py-2 flex items-center justify-between',
        hasResult
          ? 'bg-emerald-100 dark:bg-emerald-950/50 border border-emerald-300 dark:border-emerald-700'
          : 'bg-muted/20 border border-dashed border-border'
      )}>
        <div>
          <p className="text-[9px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">Flow Rate Q</p>
          <p className="text-[9px] text-muted-foreground font-mono">
            {row.method === 'meter' ? 'Q = ΔV ÷ Δt' : 'Q = V ÷ t × 60 ÷ 1000 × 60'}
          </p>
        </div>
        <div className="text-right">
          <p className={cn('text-lg font-bold font-mono-num leading-none',
            hasResult ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground/30')}>
            {hasResult ? Q : '—'}
          </p>
          {hasResult && <p className="text-[9px] text-muted-foreground">m³/hr</p>}
        </div>
      </div>
    </div>
  );
}

function CIPVolumetric({ numVessels = 15 }: { numVessels?: number }) {
  // ── Per-vessel flow state ─────────────────────────────────────────────────
  const makeRow = (id: number): VesselFlowRow => ({
    id, method: 'meter',
    prevMeter: '', currMeter: '', prevTime: '', currTime: '',
    bucketVol: '20', fillTimeSec: '',
  });
  const [vesselRows, setVesselRows] = useState<VesselFlowRow[]>(
    Array.from({ length: numVessels }, (_, i) => makeRow(i + 1))
  );
  const [expandedVessel, setExpandedVessel] = useState<number | null>(null);
  const [globalMethod, setGlobalMethod] = useState<VesselFlowMethod>('meter');

  const patchRow = (id: number, patch: Partial<VesselFlowRow>) =>
    setVesselRows(rows => rows.map(r => r.id === id ? { ...r, ...patch } : r));

  const applyGlobalMethod = (m: VesselFlowMethod) => {
    setGlobalMethod(m);
    setVesselRows(rows => rows.map(r => ({ ...r, method: m })));
  };

  // ── Volumetric flow Q = ΔV / Δt state (Tab 2 — global) ──────────────────
  const [qPrevMeter, setQPrevMeter] = useState('');
  const [qCurrMeter, setQCurrMeter] = useState('');
  const [qPrevTime,  setQPrevTime]  = useState('');
  const [qCurrTime,  setQCurrTime]  = useState('');

  // ── Comparative analytics state ──────────────────────────────────────────
  const [preCipVol,  setPreCipVol]  = useState('');
  const [postCipVol, setPostCipVol] = useState('');
  const [preCipTds,  setPreCipTds]  = useState('');
  const [postCipTds, setPostCipTds] = useState('');
  const [preCipKpi,  setPreCipKpi]  = useState('');
  const [postCipKpi, setPostCipKpi] = useState('');

  // ── Active section tab ────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<'vessel' | 'flow' | 'compare'>('vessel');

  // ── Q = ΔV / Δt calc (Tab 2) ─────────────────────────────────────────────
  const deltaV = (qCurrMeter !== '' && qPrevMeter !== '')
    ? +((+qCurrMeter) - (+qPrevMeter)).toFixed(4) : null;
  const deltaT_hr = useMemo(() => {
    if (!qPrevTime || !qCurrTime) return null;
    const diff = (new Date(qCurrTime).getTime() - new Date(qPrevTime).getTime()) / 3600000;
    return diff > 0 ? +diff.toFixed(4) : null;
  }, [qPrevTime, qCurrTime]);
  const flowQ = (deltaV !== null && deltaT_hr !== null && deltaT_hr > 0)
    ? +((deltaV) / deltaT_hr).toFixed(4) : null;

  // ── Comparative analytics calc ────────────────────────────────────────────
  const deltaVolRecovery = (postCipVol !== '' && preCipVol !== '')
    ? +((+postCipVol) - (+preCipVol)).toFixed(4) : null;
  const deltaTds = (postCipTds !== '' && preCipTds !== '')
    ? +((+postCipTds) - (+preCipTds)).toFixed(2) : null;
  const deltaKpi = (postCipKpi !== '' && preCipKpi !== '')
    ? +((+postCipKpi) - (+preCipKpi)).toFixed(2) : null;

  const deltaColor = (val: number | null, lowerIsBetter = false) => {
    if (val === null) return 'text-muted-foreground';
    const good = lowerIsBetter ? val < 0 : val > 0;
    return good ? 'text-emerald-600 dark:text-emerald-400' : val === 0 ? 'text-muted-foreground' : 'text-red-500 dark:text-red-400';
  };
  const deltaSign = (val: number | null) => val === null ? '—' : val > 0 ? `+${val}` : `${val}`;

  const TABS = [
    { key: 'vessel',  label: 'Per-Vessel Flow' },
    { key: 'flow',    label: 'Flow Q=ΔV/Δt'    },
    { key: 'compare', label: 'Comparative'      },
  ] as const;

  return (
    <Card className="p-3 space-y-3">
      {/* ── Header ──────────────────────────────────────────────────── */}
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground">Volumetric & Analytics</h4>
        <p className="text-[10px] text-muted-foreground mt-0.5">Per-vessel flow rate · Global Q=ΔV/Δt · Pre/Post CIP comparison</p>
      </div>

      {/* ── Section tab pills ────────────────────────────────────────── */}
      <div className="flex gap-1.5 flex-wrap">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setActiveTab(t.key)}
            className={cn(
              'text-[11px] px-3 py-1 rounded-full border font-medium transition-colors',
              activeTab === t.key
                ? 'bg-emerald-600 text-white border-emerald-600'
                : 'border-border bg-muted/40 text-muted-foreground hover:bg-muted'
            )}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ══ TAB 1 — Per-Vessel Flow Rate ════════════════════════════ */}
      {activeTab === 'vessel' && (
        <div className="space-y-3">
          {/* Global method switcher */}
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-[11px] text-muted-foreground font-medium">All vessels:</span>
            <div className="flex rounded-full border border-border overflow-hidden text-[11px] font-semibold">
              <button type="button" onClick={() => applyGlobalMethod('meter')}
                className={cn('px-3 py-1 transition-colors',
                  globalMethod === 'meter' ? 'bg-teal-700 text-white' : 'bg-background text-muted-foreground hover:bg-muted')}>
                📟 Water Meter
              </button>
              <button type="button" onClick={() => applyGlobalMethod('manual')}
                className={cn('px-3 py-1 transition-colors',
                  globalMethod === 'manual' ? 'bg-teal-700 text-white' : 'bg-background text-muted-foreground hover:bg-muted')}>
                🪣 Bucket Test
              </button>
            </div>
            <span className="text-[10px] text-muted-foreground/60 italic">or switch per vessel ↓</span>
          </div>

          {/* Formula hint */}
          <div className="rounded-md bg-muted/30 border border-border px-3 py-1.5 text-[10px] text-muted-foreground font-mono space-y-0.5">
            {globalMethod === 'meter'
              ? <><span className="text-foreground font-semibold">Q = ΔV ÷ Δt</span>  ·  ΔV = curr − prev meter (m³)  ·  Δt = elapsed time (hr)</>
              : <><span className="text-foreground font-semibold">Q = V_bucket ÷ t_fill</span>  ·  e.g. 20 L ÷ 45 s → L/min → m³/hr</>
            }
          </div>

          {/* Vessel list — accordion */}
          <div className="space-y-2">
            {vesselRows.map(row => {
              const isOpen = expandedVessel === row.id;
              // Quick Q preview for collapsed state
              const prevM = +row.prevMeter, currM = +row.currMeter;
              const dV = (row.currMeter && row.prevMeter) ? currM - prevM : null;
              const dT = (row.prevTime && row.currTime)
                ? (new Date(row.currTime).getTime() - new Date(row.prevTime).getTime()) / 3600000 : null;
              const qPreview_meter = (dV !== null && dT !== null && dT > 0) ? +(dV / dT).toFixed(3) : null;
              const bV = +row.bucketVol, bT = +row.fillTimeSec;
              const qPreview_manual = (bV > 0 && bT > 0) ? +((bV / bT * 60 / 1000 * 60)).toFixed(3) : null;
              const qPreview = row.method === 'meter' ? qPreview_meter : qPreview_manual;

              return (
                <div key={row.id} className={cn(
                  'rounded-xl border transition-colors overflow-hidden',
                  isOpen ? 'border-emerald-300 dark:border-emerald-700' : 'border-border'
                )}>
                  {/* Accordion header */}
                  <button
                    type="button"
                    onClick={() => setExpandedVessel(isOpen ? null : row.id)}
                    className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-muted/30 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-foreground">Vessel {row.id}</span>
                      <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full border font-medium',
                        row.method === 'meter'
                          ? 'border-teal-300 bg-teal-50 dark:bg-teal-950/40 text-teal-700 dark:text-teal-300'
                          : 'border-amber-300 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300')}>
                        {row.method === 'meter' ? '📟 Meter' : '🪣 Bucket'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {qPreview !== null ? (
                        <span className="text-xs font-bold font-mono-num text-emerald-600 dark:text-emerald-400">
                          {qPreview} m³/hr
                        </span>
                      ) : (
                        <span className="text-[10px] text-muted-foreground/50">not set</span>
                      )}
                      <span className="text-muted-foreground/50 text-xs">{isOpen ? '▲' : '▼'}</span>
                    </div>
                  </button>
                  {/* Expanded vessel card */}
                  {isOpen && (
                    <div className="px-2 pb-2">
                      <VesselFlowCard row={row} onChange={patch => patchRow(row.id, patch)} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* All-vessel Q summary strip */}
          {vesselRows.some(r => {
            if (r.method === 'meter') {
              const dV = r.currMeter && r.prevMeter ? +r.currMeter - +r.prevMeter : null;
              const dT = r.prevTime && r.currTime ? (new Date(r.currTime).getTime() - new Date(r.prevTime).getTime()) / 3600000 : null;
              return dV !== null && dT !== null && dT > 0;
            }
            return +r.bucketVol > 0 && +r.fillTimeSec > 0;
          }) && (
            <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 p-2.5">
              <p className="text-[9px] text-emerald-700 dark:text-emerald-400 font-bold uppercase tracking-wide mb-1.5">Flow Summary — All Vessels</p>
              <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5">
                {vesselRows.map(r => {
                  let q: number | null = null;
                  if (r.method === 'meter') {
                    const dV = r.currMeter && r.prevMeter ? +r.currMeter - +r.prevMeter : null;
                    const dT = r.prevTime && r.currTime ? (new Date(r.currTime).getTime() - new Date(r.prevTime).getTime()) / 3600000 : null;
                    q = (dV !== null && dT !== null && dT > 0) ? +(dV / dT).toFixed(3) : null;
                  } else {
                    const bV = +r.bucketVol, bT = +r.fillTimeSec;
                    q = (bV > 0 && bT > 0) ? +((bV / bT * 60 / 1000 * 60)).toFixed(3) : null;
                  }
                  return (
                    <div key={r.id} className="text-center">
                      <p className="text-[9px] text-muted-foreground">V{r.id}</p>
                      <p className={cn('text-xs font-bold font-mono-num',
                        q !== null ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground/40')}>
                        {q !== null ? q : '—'}
                      </p>
                    </div>
                  );
                })}
              </div>
              <p className="text-[9px] text-muted-foreground/50 mt-1.5">m³/hr per vessel</p>
            </div>
          )}
        </div>
      )}

      {/* ══ TAB 2 — Volumetric Flow Q = ΔV / Δt ════════════════════ */}
      {activeTab === 'flow' && (
        <div className="space-y-3">
          {/* Formula card */}
          <div className="rounded-lg bg-muted/40 border border-border px-3 py-2 space-y-0.5">
            <p className="text-[11px] font-semibold text-foreground font-mono">Q = ΔV ÷ Δt</p>
            <p className="text-[10px] text-muted-foreground">ΔV = Curr meter − Prev meter (m³) &nbsp;·&nbsp; Δt = elapsed time (hr)</p>
          </div>

          {/* Meter readings */}
          <div className="space-y-1.5">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Meter Readings (m³)</p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-[11px] text-muted-foreground">Previous reading</Label>
                <Input type="number" step="any" value={qPrevMeter} onChange={e => setQPrevMeter(e.target.value)}
                  placeholder="e.g. 1024.50" className="h-9 text-sm" />
              </div>
              <div>
                <Label className="text-[11px] text-muted-foreground">Current reading</Label>
                <Input type="number" step="any" value={qCurrMeter} onChange={e => setQCurrMeter(e.target.value)}
                  placeholder="e.g. 1087.30" className="h-9 text-sm" />
              </div>
            </div>
            {/* ΔV result */}
            <div className={cn('rounded-md border px-3 py-2 flex items-center justify-between',
              deltaV !== null ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800'
                             : 'bg-muted/30 border-border')}>
              <span className="text-[11px] text-muted-foreground font-medium">ΔV (volume produced)</span>
              <span className={cn('text-sm font-bold font-mono-num', deltaV !== null ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground')}>
                {deltaV !== null ? `${deltaV} m³` : '—'}
              </span>
            </div>
          </div>

          {/* Time interval */}
          <div className="space-y-1.5">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Time Interval</p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-[11px] text-muted-foreground">Previous date & time</Label>
                <Input type="datetime-local" value={qPrevTime} onChange={e => setQPrevTime(e.target.value)} className="h-9 text-xs" />
              </div>
              <div>
                <Label className="text-[11px] text-muted-foreground">Current date & time</Label>
                <Input type="datetime-local" value={qCurrTime} onChange={e => setQCurrTime(e.target.value)} className="h-9 text-xs" />
              </div>
            </div>
            {/* Δt result */}
            <div className={cn('rounded-md border px-3 py-2 flex items-center justify-between',
              deltaT_hr !== null ? 'bg-muted/40 border-border' : 'bg-muted/20 border-border')}>
              <span className="text-[11px] text-muted-foreground font-medium">Δt (elapsed)</span>
              <span className="text-sm font-bold font-mono-num text-foreground">
                {deltaT_hr !== null ? `${deltaT_hr} hr` : '—'}
              </span>
            </div>
          </div>

          {/* Q result — hero strip */}
          <div className={cn(
            'rounded-xl border-2 p-3 flex items-center justify-between gap-3',
            flowQ !== null
              ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-400 dark:border-emerald-700'
              : 'bg-muted/20 border-dashed border-border'
          )}>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                Volumetric Flow Rate
              </p>
              <p className="text-[9px] text-muted-foreground font-mono">Q = ΔV ÷ Δt</p>
            </div>
            <div className="text-right">
              <p className={cn('text-2xl font-bold font-mono-num leading-none',
                flowQ !== null ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground/40')}>
                {flowQ !== null ? flowQ : '—'}
              </p>
              {flowQ !== null && <p className="text-[10px] text-muted-foreground mt-0.5">m³/hr</p>}
            </div>
          </div>
        </div>
      )}

      {/* ══ TAB 3 — Comparative Analytics ═══════════════════════════ */}
      {activeTab === 'compare' && (
        <div className="space-y-3">
          <p className="text-[10px] text-muted-foreground">Enter pre‑CIP and post‑CIP values — deltas compute automatically.</p>

          {/* ── Δ Volume Recovery ─────────────────────────────────── */}
          <div className="rounded-lg border border-border p-3 space-y-2">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
              <p className="text-[11px] font-semibold text-foreground uppercase tracking-wide">Δ Volume Recovery</p>
            </div>
            <p className="text-[10px] text-muted-foreground -mt-1">Post‑CIP Volume − Pre‑CIP Volume (m³)</p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-[11px] text-muted-foreground">Pre-CIP Volume (m³)</Label>
                <Input type="number" step="any" value={preCipVol} onChange={e => setPreCipVol(e.target.value)}
                  placeholder="e.g. 180.5" className="h-8 text-sm" />
              </div>
              <div>
                <Label className="text-[11px] text-muted-foreground">Post-CIP Volume (m³)</Label>
                <Input type="number" step="any" value={postCipVol} onChange={e => setPostCipVol(e.target.value)}
                  placeholder="e.g. 215.0" className="h-8 text-sm" />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-md bg-muted/30 px-3 py-2">
              <span className="text-[11px] text-muted-foreground font-medium">Δ Volume Recovery</span>
              <span className={cn('text-base font-bold font-mono-num', deltaColor(deltaVolRecovery))}>
                {deltaSign(deltaVolRecovery)}{deltaVolRecovery !== null ? ' m³' : ''}
              </span>
            </div>
          </div>

          {/* ── Δ Water Quality (TDS) ─────────────────────────────── */}
          <div className="rounded-lg border border-border p-3 space-y-2">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />
              <p className="text-[11px] font-semibold text-foreground uppercase tracking-wide">Δ Water Quality</p>
            </div>
            <p className="text-[10px] text-muted-foreground -mt-1">Post‑CIP Product TDS − Pre‑CIP Product TDS (ppm) — lower is better</p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-[11px] text-muted-foreground">Pre-CIP TDS (ppm)</Label>
                <Input type="number" step="any" value={preCipTds} onChange={e => setPreCipTds(e.target.value)}
                  placeholder="e.g. 45" className="h-8 text-sm" />
              </div>
              <div>
                <Label className="text-[11px] text-muted-foreground">Post-CIP TDS (ppm)</Label>
                <Input type="number" step="any" value={postCipTds} onChange={e => setPostCipTds(e.target.value)}
                  placeholder="e.g. 28" className="h-8 text-sm" />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-md bg-muted/30 px-3 py-2">
              <span className="text-[11px] text-muted-foreground font-medium">Δ TDS</span>
              <span className={cn('text-base font-bold font-mono-num', deltaColor(deltaTds, true))}>
                {deltaSign(deltaTds)}{deltaTds !== null ? ' ppm' : ''}
              </span>
            </div>
          </div>

          {/* ── Δ Cost Impact / Efficiency KPI ───────────────────── */}
          <div className="rounded-lg border border-border p-3 space-y-2">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
              <p className="text-[11px] font-semibold text-foreground uppercase tracking-wide">Δ Cost Impact</p>
            </div>
            <p className="text-[10px] text-muted-foreground -mt-1">Post‑CIP Efficiency KPI − Pre‑CIP Efficiency KPI (kWh/m³)</p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-[11px] text-muted-foreground">Pre-CIP KPI (kWh/m³)</Label>
                <Input type="number" step="any" value={preCipKpi} onChange={e => setPreCipKpi(e.target.value)}
                  placeholder="e.g. 0.85" className="h-8 text-sm" />
              </div>
              <div>
                <Label className="text-[11px] text-muted-foreground">Post-CIP KPI (kWh/m³)</Label>
                <Input type="number" step="any" value={postCipKpi} onChange={e => setPostCipKpi(e.target.value)}
                  placeholder="e.g. 0.62" className="h-8 text-sm" />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-md bg-muted/30 px-3 py-2">
              <span className="text-[11px] text-muted-foreground font-medium">Δ Efficiency KPI</span>
              <span className={cn('text-base font-bold font-mono-num', deltaColor(deltaKpi, true))}>
                {deltaSign(deltaKpi)}{deltaKpi !== null ? ' kWh/m³' : ''}
              </span>
            </div>
          </div>

          {/* ── Summary strip ────────────────────────────────────── */}
          {(deltaVolRecovery !== null || deltaTds !== null || deltaKpi !== null) && (
            <div className="rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 p-3 space-y-1.5">
              <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">CIP Impact Summary</p>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div>
                  <p className="text-[9px] text-muted-foreground uppercase tracking-wide">Δ Volume</p>
                  <p className={cn('text-sm font-bold font-mono-num', deltaColor(deltaVolRecovery))}>
                    {deltaSign(deltaVolRecovery)}{deltaVolRecovery !== null ? ' m³' : ''}
                  </p>
                </div>
                <div>
                  <p className="text-[9px] text-muted-foreground uppercase tracking-wide">Δ TDS</p>
                  <p className={cn('text-sm font-bold font-mono-num', deltaColor(deltaTds, true))}>
                    {deltaSign(deltaTds)}{deltaTds !== null ? ' ppm' : ''}
                  </p>
                </div>
                <div>
                  <p className="text-[9px] text-muted-foreground uppercase tracking-wide">Δ KPI</p>
                  <p className={cn('text-sm font-bold font-mono-num', deltaColor(deltaKpi, true))}>
                    {deltaSign(deltaKpi)}{deltaKpi !== null ? '' : ''}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function CIPLog() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [plantId, setPlantId] = useState('');
  const [trainId, setTrainId] = useState('');
  const [v, setV] = useState({ start: '', end: '', sls: '', hcl: '', caustic: '', remarks: '' });

  const { data: trains } = useQuery({
    queryKey: ['cip-trains', plantId],
    queryFn: async () => plantId ? (await supabase.from('ro_trains').select('*').eq('plant_id', plantId)).data ?? [] : [],
    enabled: !!plantId,
  });
  const { data: history } = useQuery({
    queryKey: ['cip-history', trainId, plantId],
    queryFn: async () => plantId
      ? (await supabase.from('cip_logs')
          .select('*,ro_trains(train_number)')
          .eq('plant_id', plantId)
          .order('start_datetime', { ascending: false })
          .limit(10)).data ?? []
      : [],
    enabled: !!plantId,
  });
  const { data: cipPrices } = useQuery({
    queryKey: ['chem-current-prices-cip'],
    queryFn: async () => {
      const today = format(new Date(), 'yyyy-MM-dd');
      const { data } = await supabase.from('chemical_prices').select('*').lte('effective_date', today).order('effective_date', { ascending: false });
      const map: Record<string, number> = {};
      (data ?? []).forEach((p: any) => { if (!(p.chemical_name in map)) map[p.chemical_name] = p.unit_price; });
      return map;
    },
  });

  const selectedTrain = useMemo(() => trains?.find((t: any) => t.id === trainId), [trains, trainId]);
  const numVessels = selectedTrain?.num_vessels ?? 15;

  // Live computed values
  const causticKg  = +v.caustic || 0;
  const hclL       = +v.hcl     || 0;
  const slsG       = +v.sls     || 0;
  const totalMassKg   = causticKg + slsG / 1000;
  const totalVolumeL  = hclL;
  const liveCost =
    causticKg * (cipPrices?.['Caustic Soda'] ?? 0) +
    hclL      * (cipPrices?.['HCl']          ?? 0) +
    (slsG / 1000) * (cipPrices?.['SLS']      ?? 0);

  const formDuration = v.start && v.end
    ? Math.round((new Date(v.end).getTime() - new Date(v.start).getTime()) / 60000)
    : null;

  const getHistoryCost = (c: any) =>
    (c.caustic_soda_kg || 0) * (cipPrices?.['Caustic Soda'] ?? 0) +
    (c.hcl_l           || 0) * (cipPrices?.['HCl']          ?? 0) +
    ((c.sls_g || 0) / 1000)  * (cipPrices?.['SLS']          ?? 0);

  const getChemType = (c: any) => {
    const parts: string[] = [];
    if (c.caustic_soda_kg > 0) parts.push('Caustic Alkaline');
    if (c.hcl_l > 0)           parts.push('Acid HCl');
    if (c.sls_g > 0)           parts.push('Anti Scalant');
    return parts.join(' + ') || '—';
  };

  const lastCip = history?.[0];
  const lastCipCost = lastCip ? getHistoryCost(lastCip) : null;
  const comparisonPct = lastCipCost && liveCost
    ? (((liveCost - lastCipCost) / lastCipCost) * 100).toFixed(0)
    : null;

  const submit = async () => {
    if (!trainId) { toast.error('Select a train'); return; }
    const { error } = await supabase.from('cip_logs').insert({
      train_id: trainId, plant_id: plantId,
      start_datetime: v.start ? new Date(v.start).toISOString() : null,
      end_datetime:   v.end   ? new Date(v.end).toISOString()   : null,
      sls_g: v.sls ? +v.sls : null, hcl_l: v.hcl ? +v.hcl : null, caustic_soda_kg: v.caustic ? +v.caustic : null,
      conducted_by: user?.id, remarks: v.remarks || null,
    });
    if (error) { toast.error(error.message); return; }
    toast.success('CIP logged'); qc.invalidateQueries();
    clearForm();
  };
  const clearForm = () => setV({ start: '', end: '', sls: '', hcl: '', caustic: '', remarks: '' });

  const trainStatusLabel = selectedTrain?.status === 'Running'
    ? 'Online - Optimal Health'
    : selectedTrain?.status ?? '';
  const trainStatusColor = selectedTrain?.status === 'Running'
    ? 'text-emerald-500'
    : selectedTrain?.status === 'Maintenance'
    ? 'text-amber-500'
    : 'text-red-500';

  // ── CIP Summary block (reused in both sidebar and mobile bottom bar) ─────────
  const CIPSummaryContent = () => (
    <>
      <div>
        <p className="text-[9px] text-teal-300 uppercase tracking-wide font-medium">Total Chemical Cost:</p>
        <p className="text-xl font-bold font-mono-num leading-tight">₱ {fmtNum(liveCost, 2)}</p>
      </div>
      <div>
        <p className="text-[9px] text-teal-300 uppercase tracking-wide font-medium">Total Dosed Mass:</p>
        <p className="text-sm font-semibold font-mono-num">{fmtNum(totalMassKg, 3)} kg</p>
      </div>
      <div>
        <p className="text-[9px] text-teal-300 uppercase tracking-wide font-medium">Total Dosed Volume:</p>
        <p className="text-sm font-semibold font-mono-num">{fmtNum(totalVolumeL, 2)} L</p>
      </div>
      {comparisonPct != null && (
        <div>
          <p className="text-[9px] text-teal-300 uppercase tracking-wide font-medium">vs Last CIP:</p>
          <p className={cn('text-sm font-semibold', +comparisonPct <= 0 ? 'text-emerald-400' : 'text-amber-400')}>
            {+comparisonPct > 0 ? '+' : ''}{comparisonPct}% Chemical Use
          </p>
        </div>
      )}
    </>
  );

  return (
    <div className="space-y-2.5">
      {/* ── Plant + Train row ──────────────────────────────────────────── */}
      <Card className="p-3 space-y-2.5">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-[11px] text-muted-foreground">Plant</Label>
            <PlantPicker value={plantId} onChange={(p) => { setPlantId(p); setTrainId(''); }} />
          </div>
          <div>
            <Label className="text-[11px] text-muted-foreground">Train</Label>
            <Select value={trainId} onValueChange={setTrainId}>
              <SelectTrigger><SelectValue placeholder="Select train" /></SelectTrigger>
              <SelectContent>
                {trains?.map((t: any) => <SelectItem key={t.id} value={t.id}>Train {t.train_number}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        {selectedTrain && (
          <div className="flex items-center gap-2 pt-0.5">
            <span className="text-sm font-bold">Train {selectedTrain.train_number}</span>
            <span className={cn('text-xs font-medium', trainStatusColor)}>({trainStatusLabel})</span>
          </div>
        )}
      </Card>

      {/* ── Main + Sidebar layout: stacked on mobile, side-by-side on md+ ─ */}
      <div className="flex flex-col md:flex-row gap-2.5 items-start">

        {/* Main content */}
        <div className="flex-1 min-w-0 space-y-2.5">

          {/* Dosing & Time */}
          <Card className="p-3 space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground">Dosing & Time</h4>
            <div className="grid grid-cols-2 gap-2">
              {/* Caustic Soda */}
              <div className={cn('rounded-lg border-2 p-2 space-y-1.5 transition-colors',
                v.caustic ? 'border-teal-400 bg-teal-50/40 dark:bg-teal-950/30' : 'border-border bg-muted/20')}>
                <div className="flex items-center gap-1.5">
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-teal-100 dark:bg-teal-900 text-[9px] font-bold text-teal-700 dark:text-teal-300">A</span>
                  <span className="text-xs font-semibold">Caustic Soda (kg)</span>
                </div>
                <div className="flex items-center gap-1">
                  <Input type="number" step="any" value={v.caustic}
                    onChange={e => setV({ ...v, caustic: e.target.value })}
                    className="h-7 text-sm flex-1" placeholder="0" />
                  <span className="text-[11px] text-muted-foreground shrink-0">kg</span>
                </div>
                <div className="h-0.5 rounded-full bg-muted overflow-hidden">
                  <div className={cn('h-full rounded-full bg-teal-400 transition-all', v.caustic ? 'w-1/2' : 'w-0')} />
                </div>
              </div>
              {/* HCl */}
              <div className={cn('rounded-lg border-2 p-2 space-y-1.5 transition-colors',
                v.hcl ? 'border-amber-400 bg-amber-50/40 dark:bg-amber-950/30' : 'border-border bg-muted/20')}>
                <div className="flex items-center gap-1.5">
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-100 dark:bg-amber-900 text-[9px] font-bold text-amber-700 dark:text-amber-300">A</span>
                  <span className="text-xs font-semibold">HCl (L)</span>
                </div>
                <div className="flex items-center gap-1">
                  <Input type="number" step="any" value={v.hcl}
                    onChange={e => setV({ ...v, hcl: e.target.value })}
                    className="h-7 text-sm flex-1" placeholder="0" />
                  <span className="text-[11px] text-muted-foreground shrink-0">L</span>
                </div>
                <div className="h-0.5 rounded-full bg-muted overflow-hidden">
                  <div className={cn('h-full rounded-full bg-amber-400 transition-all', v.hcl ? 'w-1/2' : 'w-0')} />
                </div>
              </div>
              {/* SLS */}
              <div className={cn('rounded-lg border-2 p-2 space-y-1.5 transition-colors',
                v.sls ? 'border-yellow-400 bg-yellow-50/40 dark:bg-yellow-950/30' : 'border-border bg-muted/20')}>
                <div className="flex items-center gap-1.5">
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-yellow-100 dark:bg-yellow-900 text-[8px] font-bold text-yellow-700 dark:text-yellow-300">SO₃</span>
                  <span className="text-xs font-semibold">SLS (g)</span>
                </div>
                <div className="flex items-center gap-1">
                  <Input type="number" step="any" value={v.sls}
                    onChange={e => setV({ ...v, sls: e.target.value })}
                    className="h-7 text-sm flex-1" placeholder="0" />
                  <span className="text-[11px] text-muted-foreground shrink-0">g</span>
                </div>
                <div className="h-0.5 rounded-full bg-muted overflow-hidden">
                  <div className={cn('h-full rounded-full bg-yellow-400 transition-all', v.sls ? 'w-1/2' : 'w-0')} />
                </div>
              </div>
            </div>
            {/* Datetime pickers */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-[11px] text-muted-foreground">Start D&T</Label>
                <Input type="datetime-local" value={v.start}
                  onChange={e => setV({ ...v, start: e.target.value })}
                  className="w-full text-xs h-8" />
              </div>
              <div>
                <Label className="text-[11px] text-muted-foreground">End D&T</Label>
                <Input type="datetime-local" value={v.end}
                  onChange={e => setV({ ...v, end: e.target.value })}
                  className="w-full text-xs h-8" />
              </div>
            </div>
            {formDuration != null && formDuration > 0 && (
              <p className="text-[10px] text-muted-foreground">
                Duration: <span className="font-semibold text-foreground">{formDuration} min</span>
              </p>
            )}
          </Card>

          {/* Remarks & Prediction */}
          <Card className="p-3 space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground">Remarks & Prediction</h4>
            <div>
              <Label className="text-[11px] text-muted-foreground">Remarks</Label>
              <Textarea value={v.remarks} onChange={e => setV({ ...v, remarks: e.target.value })}
                placeholder="Any observations..." className="text-xs min-h-[60px] resize-none" />
            </div>
            <div className="rounded-lg border border-emerald-300 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/40 p-2 space-y-0.5">
              <p className="text-[10px] font-semibold text-emerald-700 dark:text-emerald-400 uppercase tracking-wide">
                Predicted Recovery Post-CIP:
              </p>
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-bold text-emerald-600 dark:text-emerald-400">+3% est.</span>
                <span className="text-emerald-500 text-base">↑</span>
              </div>
            </div>
          </Card>

          {/* Volumetric Calculator */}
          <CIPVolumetric numVessels={numVessels} />

          {/* CIP History table */}
          <Card className="p-3 space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                CIP History {selectedTrain ? `— Train ${selectedTrain.train_number}` : ''}
              </h4>
              <ExportButton table="cip_logs" label="Export" />
            </div>
            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground border-b border-border">
                    <th className="text-left py-1.5 pr-2 font-semibold">Date</th>
                    <th className="text-left py-1.5 pr-2 font-semibold">Duration</th>
                    <th className="text-left py-1.5 pr-2 font-semibold">Chemical Type</th>
                    <th className="text-right py-1.5 font-semibold">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {history?.map((c: any) => {
                    const dur = c.start_datetime && c.end_datetime
                      ? Math.round((new Date(c.end_datetime).getTime() - new Date(c.start_datetime).getTime()) / 60000)
                      : null;
                    const hCost = getHistoryCost(c);
                    return (
                      <tr key={c.id} className="border-b border-border/40 hover:bg-muted/30 transition-colors">
                        <td className="py-1.5 pr-2 font-mono-num text-[11px]">
                          {c.start_datetime ? format(new Date(c.start_datetime), 'MM/dd/yy') : '—'}
                        </td>
                        <td className="py-1.5 pr-2 text-muted-foreground">
                          {dur != null && dur > 0 ? `${dur} min` : '—'}
                        </td>
                        <td className="py-1.5 pr-2">{getChemType(c)}</td>
                        <td className="py-1.5 text-right font-mono-num">
                          {cipPrices ? `₱ ${fmtNum(hCost, 2)}` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                  {!history?.length && (
                    <tr>
                      <td colSpan={4} className="py-4 text-center text-muted-foreground">No CIP records yet</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        {/* ── Sidebar: hidden on mobile (shown below instead), visible md+ ── */}
        <div className="hidden md:block w-48 shrink-0">
          <div className="rounded-xl bg-teal-900 dark:bg-teal-950 text-white p-3 space-y-3 sticky top-2">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-teal-200">CIP Summary</p>
              <p className="text-[9px] text-teal-400">(Live Calc)</p>
            </div>
            <div className="space-y-2.5"><CIPSummaryContent /></div>
            <div className="border-t border-teal-700/60 pt-2.5 space-y-2">
              <Button onClick={submit} className="w-full h-8 text-xs bg-white text-teal-900 hover:bg-teal-50 font-semibold shadow-none border-0">Save CIP</Button>
              <Button variant="ghost" onClick={clearForm} className="w-full h-8 text-xs text-teal-300 hover:text-white hover:bg-teal-800">Clear Form</Button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Mobile summary bar (visible only on mobile) ─────────────────── */}
      <div className="md:hidden rounded-xl bg-teal-900 dark:bg-teal-950 text-white p-3 space-y-2.5">
        <p className="text-[11px] font-bold uppercase tracking-wider text-teal-200">CIP Summary <span className="text-teal-400 font-normal">(Live)</span></p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          <CIPSummaryContent />
        </div>
        <div className="grid grid-cols-2 gap-2 pt-1">
          <Button variant="ghost" onClick={clearForm} className="h-9 text-xs text-teal-300 hover:text-white hover:bg-teal-800 border border-teal-700">Clear Form</Button>
          <Button onClick={submit} className="h-9 text-xs bg-white text-teal-900 hover:bg-teal-50 font-semibold shadow-none border-0">Save CIP</Button>
        </div>
      </div>
    </div>
  );
}

// ─── Chemical Dosing Tab ──────────────────────────────────────────────────────

function ToggleSwitch({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex items-center gap-1.5 focus-visible:outline-none group">
      <div className={cn(
        'relative w-9 h-5 rounded-full transition-colors duration-200',
        active ? 'bg-teal-600' : 'bg-muted-foreground/30'
      )}>
        <div className={cn(
          'absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200',
          active ? 'translate-x-4' : 'translate-x-0.5'
        )} />
      </div>
      <span className={cn('text-sm font-medium transition-colors', active ? 'text-teal-700 dark:text-teal-400' : 'text-muted-foreground group-hover:text-foreground')}>
        {label}
      </span>
    </button>
  );
}

function ChemicalDosing() {
  const [active, setActive] = useState<'dosing' | 'inventory'>('dosing');
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-4">
        <ToggleSwitch label="Dosing"    active={active === 'dosing'}    onClick={() => setActive('dosing')} />
        <ToggleSwitch label="Inventory" active={active === 'inventory'} onClick={() => setActive('inventory')} />
      </div>
      <div>
        {active === 'dosing'    && <ChemDosingForm />}
        {active === 'inventory' && <ChemInventory />}
      </div>
    </div>
  );
}

function ChemPlantPick({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data: plants } = usePlants();
  const { selectedPlantId } = useAppStore();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (selectedPlantId && !value) onChange(selectedPlantId); }, [selectedPlantId]);
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger><SelectValue placeholder="Plant" /></SelectTrigger>
      <SelectContent>{plants?.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
    </Select>
  );
}

// ── Chemical card helper ─────────────────────────────────────────────────────
function ChemCard({
  name, icon, value, onChange, unit, accent = 'default', inputProps = {},
}: {
  name: string; icon: React.ReactNode; value: string;
  onChange: (v: string) => void; unit: string;
  accent?: 'teal' | 'amber' | 'olive' | 'default';
  inputProps?: React.InputHTMLAttributes<HTMLInputElement>;
}) {
  const hasVal = value !== '' && +value !== 0;
  const borders: Record<string, string> = {
    teal:    'border-teal-400 bg-teal-50/40 dark:bg-teal-950/30',
    amber:   'border-amber-400 bg-amber-50/40 dark:bg-amber-950/30',
    olive:   'border-yellow-500 bg-yellow-50/40 dark:bg-yellow-950/30',
    default: 'border-primary/30 bg-primary/5',
  };
  const bars: Record<string, string> = {
    teal: 'bg-teal-400', amber: 'bg-amber-400', olive: 'bg-yellow-400', default: 'bg-primary/60',
  };
  return (
    <div className={cn('rounded-lg border-2 p-2 space-y-1.5 transition-colors', hasVal ? borders[accent] : 'border-border bg-muted/10')}>
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-xs font-semibold leading-tight">{name}</span>
      </div>
      <div className="relative">
        <Input type="number" step="any" value={value} onChange={e => onChange(e.target.value)}
          placeholder="Inputs" className="h-8 text-sm pr-7 placeholder:text-[10px] placeholder:text-muted-foreground/50"
          {...inputProps} />
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground pointer-events-none">{unit}</span>
      </div>
      <div className="h-0.5 rounded-full bg-muted overflow-hidden">
        <div className={cn('h-full rounded-full transition-all duration-300', bars[accent], hasVal ? 'w-1/2' : 'w-0')} />
      </div>
    </div>
  );
}

function ChemDosingForm() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const { data: plants } = usePlants();
  const [plantId, setPlantId] = useState('');
  const [dt, setDt] = useState(format(new Date(), "yyyy-MM-dd'T'HH:mm"));
  const [v, setV] = useState({
    chlorine_kg: '', smbs_kg: '', anti_scalant_l: '', soda_ash_kg: '',
    free_chlorine_reagent_pcs: '0',
  });
  const [samples, setSamples] = useState<Array<{ id: string; point: string; ppm: string }>>([]);

  useEffect(() => {
    const n = Math.max(0, Math.min(20, +v.free_chlorine_reagent_pcs || 0));
    setSamples((prev) => {
      const next = [...prev];
      while (next.length < n) {
        next.push({
          id: (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
            ? crypto.randomUUID()
            : `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          point: '', ppm: '',
        });
      }
      while (next.length > n) next.pop();
      return next;
    });
  }, [v.free_chlorine_reagent_pcs]);

  const { data: prices } = useQuery({
    queryKey: ['chem-current-prices'],
    queryFn: async () => {
      const today = format(new Date(), 'yyyy-MM-dd');
      const { data } = await supabase.from('chemical_prices').select('*').lte('effective_date', today).order('effective_date', { ascending: false });
      const map: Record<string, number> = {};
      (data ?? []).forEach((p: any) => { if (!(p.chemical_name in map)) map[p.chemical_name] = p.unit_price; });
      return map;
    },
  });

  const cost = DOSING_KEYS.reduce((s, c) => {
    const qty = +(v as any)[c.key] || 0;
    const price = prices?.[c.name] ?? 0;
    return s + qty * price;
  }, 0);

  // Sidebar live sums
  const totalMassKg  = (+v.chlorine_kg || 0) + (+v.smbs_kg || 0) + (+v.soda_ash_kg || 0);
  const totalVolumeL = +v.anti_scalant_l || 0;
  const freePcs      = +v.free_chlorine_reagent_pcs || 0;

  const plantName = plants?.find(p => p.id === plantId)?.name ?? '';

  const clearAll = () => setV({ chlorine_kg: '', smbs_kg: '', anti_scalant_l: '', soda_ash_kg: '', free_chlorine_reagent_pcs: '0' });

  const submit = async () => {
    if (!plantId) { toast.error('Select plant'); return; }
    const validResiduals = samples.filter((s) => s.ppm !== '').map((s) => +s.ppm);
    const avgResidual = validResiduals.length ? validResiduals.reduce((a, b) => a + b, 0) / validResiduals.length : null;
    const { data: inserted, error } = await supabase.from('chemical_dosing_logs').insert({
      plant_id: plantId, log_datetime: new Date(dt).toISOString(),
      chlorine_kg: +v.chlorine_kg || 0, smbs_kg: +v.smbs_kg || 0,
      anti_scalant_l: +v.anti_scalant_l || 0, soda_ash_kg: +v.soda_ash_kg || 0,
      free_chlorine_reagent_pcs: +v.free_chlorine_reagent_pcs || 0,
      product_water_free_cl_ppm: avgResidual,
      calculated_cost: +cost.toFixed(2), recorded_by: user?.id,
    }).select('id').single();
    if (error || !inserted) { toast.error(error?.message ?? 'Save failed'); return; }
    if (samples.length > 0) {
      const sampleRows = samples.map((s, i) => ({
        dosing_log_id: inserted.id, plant_id: plantId, sample_index: i + 1,
        sampling_point: s.point || null, residual_ppm: s.ppm ? +s.ppm : null,
      }));
      await supabase.from('chemical_residual_samples').insert(sampleRows);
    }
    toast.success('Dosing logged');
    clearAll(); setSamples([]);
    qc.invalidateQueries();
  };

  // Shared summary content used in both sidebar and mobile bar
  const DosingMobileSummary = () => (
    <>
      <div>
        <p className="text-[9px] text-teal-300 uppercase tracking-wide font-medium">Total Mass (kg):</p>
        <p className="text-xl font-bold font-mono-num leading-tight">{fmtNum(totalMassKg, 2)}</p>
      </div>
      <div>
        <p className="text-[9px] text-teal-300 uppercase tracking-wide font-medium">Total Volume (L):</p>
        <p className="text-base font-bold font-mono-num">{fmtNum(totalVolumeL, 2)}</p>
      </div>
      <div>
        <p className="text-[9px] text-teal-300 uppercase tracking-wide font-medium">Free Cl Test PCS:</p>
        <p className="text-base font-bold font-mono-num">{freePcs}</p>
      </div>
      <div>
        <p className="text-[9px] text-teal-300 uppercase tracking-wide font-medium">Calculated Cost:</p>
        <p className="text-xl font-bold leading-tight">₱ {fmtNum(cost, 2)}</p>
      </div>
    </>
  );

  return (
    <div className="space-y-2.5">
      {/* ── Main + Sidebar: stacked mobile, side-by-side md+ ─────────── */}
      <div className="flex flex-col md:flex-row gap-2.5 items-start">

        {/* ── Main Content ─────────────────────────────────────────────── */}
        <div className="flex-1 min-w-0 space-y-3">

          {/* Plant header card */}
          <Card className="p-3 space-y-2">
            {plantName && (
              <div className="flex items-center gap-2 pb-1">
                <span className="text-base">🏭</span>
                <h3 className="text-sm font-bold uppercase tracking-wide">{plantName} — RO Operations Plant</h3>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-[11px] text-muted-foreground">Plant</Label>
                <ChemPlantPick value={plantId} onChange={setPlantId} />
              </div>
              <div>
                <Label className="text-[11px] text-muted-foreground">Date & time</Label>
                <Input type="datetime-local" value={dt} onChange={e => setDt(e.target.value)} />
              </div>
            </div>
          </Card>

          {/* Mass-Based Dosing Group */}
          <div className="space-y-1.5">
            <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground px-0.5">Mass-Based Dosing Group</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <ChemCard
                name="Chlorine (kg)"
                icon={<span className="inline-flex items-center justify-center w-6 h-6 text-[9px] font-bold font-mono bg-gray-100 dark:bg-gray-800 rounded text-gray-600 dark:text-gray-300">Cl₂</span>}
                value={v.chlorine_kg} onChange={val => setV({ ...v, chlorine_kg: val })}
                unit="kg" accent="teal"
              />
              <ChemCard
                name="SMBS (kg)"
                icon={<span className="inline-flex items-center justify-center w-6 h-6 text-[8px] font-bold font-mono bg-gray-100 dark:bg-gray-800 rounded text-gray-600 dark:text-gray-300">S₂O₅</span>}
                value={v.smbs_kg} onChange={val => setV({ ...v, smbs_kg: val })}
                unit="kg" accent="default"
              />
              <ChemCard
                name="Soda Ash (kg)"
                icon={<span className="inline-flex items-center justify-center w-6 h-6 text-[7px] font-bold font-mono bg-gray-100 dark:bg-gray-800 rounded text-gray-600 dark:text-gray-300">Na₂CO₃</span>}
                value={v.soda_ash_kg} onChange={val => setV({ ...v, soda_ash_kg: val })}
                unit="kg" accent="default"
              />
            </div>
          </div>

          {/* Volume-Based + Ancillary row */}
          <div className="space-y-1.5">
            <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground px-0.5">Volume-Based & Ancillary</p>
            <div className="grid grid-cols-2 gap-2">
              <ChemCard
                name="Anti Scalant (L)"
                icon={<span className="text-base leading-none">🚛</span>}
                value={v.anti_scalant_l} onChange={val => setV({ ...v, anti_scalant_l: val })}
                unit="L" accent="olive"
              />
              <ChemCard
                name="Free Cl Reagent (pcs)"
                icon={<span className="text-base leading-none">🧪</span>}
                value={v.free_chlorine_reagent_pcs}
                onChange={val => setV({ ...v, free_chlorine_reagent_pcs: val })}
                unit="pcs" accent="default"
                inputProps={{ min: '0', max: '20' }}
              />
            </div>
          </div>

          {/* Residual samples */}
          {samples.length > 0 && (
            <Card className="p-3 space-y-2 border-t">
              <h4 className="text-xs font-semibold uppercase text-muted-foreground">Product Cl Residual Samples</h4>
              {samples.map((s, i) => (
                <div key={s.id} className="grid grid-cols-[20px_1fr_80px] gap-2 items-end">
                  <div className="text-xs font-mono-num pt-2 text-muted-foreground">#{i + 1}</div>
                  <div>
                    <Label className="text-xs">Sampling point</Label>
                    <Input value={s.point} placeholder="e.g. Tank outlet"
                      onChange={(e) => setSamples(samples.map((x) => x.id === s.id ? { ...x, point: e.target.value } : x))} />
                  </div>
                  <div>
                    <Label className="text-xs">ppm</Label>
                    <Input type="number" step="any" value={s.ppm}
                      onChange={(e) => setSamples(samples.map((x) => x.id === s.id ? { ...x, ppm: e.target.value } : x))} />
                  </div>
                </div>
              ))}
            </Card>
          )}
        </div>

        {/* ── Right Sidebar — hidden on mobile ─────────────────────────── */}
        <div className="hidden md:block w-48 shrink-0">
          <div className="rounded-xl bg-teal-900 dark:bg-teal-950 text-white p-3 space-y-3 sticky top-2">
            <p className="text-[11px] font-bold uppercase tracking-wider text-teal-200">Dosing Summary</p>
            <div className="space-y-2.5"><DosingMobileSummary /></div>
            <div className="border-t border-teal-700/60 pt-2 space-y-2">
              <button onClick={clearAll} className="w-full text-xs text-teal-300 hover:text-white underline underline-offset-2 transition-colors">Clear All</button>
              <Button onClick={submit} className="w-full h-8 text-xs bg-white text-teal-900 hover:bg-teal-50 font-semibold shadow-none border-0">Save Dosing</Button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Mobile summary bar — visible only on mobile ───────────────── */}
      <div className="md:hidden rounded-xl bg-teal-900 dark:bg-teal-950 text-white p-3 space-y-2.5">
        <p className="text-[11px] font-bold uppercase tracking-wider text-teal-200">Dosing Summary <span className="text-teal-400 font-normal">(Live)</span></p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          <DosingMobileSummary />
        </div>
        <div className="grid grid-cols-2 gap-2 pt-1">
          <button onClick={clearAll} className="h-9 text-xs text-teal-300 hover:text-white border border-teal-700 rounded-md transition-colors">Clear All</button>
          <Button onClick={submit} className="h-9 text-xs bg-white text-teal-900 hover:bg-teal-50 font-semibold shadow-none border-0">Save Dosing</Button>
        </div>
      </div>
    </div>
  );
}

function ChemInventory() {
  const { isManager } = useAuth();
  const { selectedPlantId } = useAppStore();
  const { data: plants } = usePlants();
  const ids = selectedPlantId ? [selectedPlantId] : plants?.map(p => p.id) ?? [];

  const { data: stockRows } = useQuery({
    queryKey: ['chem-stock-computed', ids],
    queryFn: async () => {
      if (!ids.length) return [];
      const [{ data: deliveries }, { data: dosing }, { data: plantsData }] = await Promise.all([
        supabase.from('chemical_deliveries').select('plant_id,chemical_name,quantity,unit').in('plant_id', ids),
        supabase.from('chemical_dosing_logs').select('plant_id,chlorine_kg,smbs_kg,anti_scalant_l,soda_ash_kg').in('plant_id', ids),
        supabase.from('plants').select('id,name').in('id', ids),
      ]);
      const plantName = new Map((plantsData ?? []).map((p: any) => [p.id, p.name]));
      const map = new Map<string, { plant_id: string; plant_name: string; chemical_name: string; unit: string; received: number; used: number }>();
      const key = (p: string, c: string) => `${p}::${c}`;
      (deliveries ?? []).forEach((d: any) => {
        const k = key(d.plant_id, d.chemical_name);
        const cur = map.get(k) ?? { plant_id: d.plant_id, plant_name: plantName.get(d.plant_id) ?? '', chemical_name: d.chemical_name, unit: d.unit, received: 0, used: 0 };
        cur.received += +d.quantity || 0;
        map.set(k, cur);
      });
      const dosingMap: Array<[string, string]> = [['Chlorine', 'kg'], ['SMBS', 'kg'], ['Anti Scalant', 'L'], ['Soda Ash', 'kg']];
      const dosingKeyMap: Record<string, string> = { 'Chlorine': 'chlorine_kg', 'SMBS': 'smbs_kg', 'Anti Scalant': 'anti_scalant_l', 'Soda Ash': 'soda_ash_kg' };
      (dosing ?? []).forEach((row: any) => {
        for (const [name, unit] of dosingMap) {
          const usedQty = +row[dosingKeyMap[name]] || 0;
          if (!usedQty) continue;
          const k = key(row.plant_id, name);
          const cur = map.get(k) ?? { plant_id: row.plant_id, plant_name: plantName.get(row.plant_id) ?? '', chemical_name: name, unit, received: 0, used: 0 };
          cur.used += usedQty;
          map.set(k, cur);
        }
      });
      return Array.from(map.values()).map((r) => ({ ...r, current: r.received - r.used }));
    },
    enabled: ids.length > 0,
  });

  const { data: thresholds } = useQuery({
    queryKey: ['chem-thresholds', ids],
    queryFn: async () => ids.length
      ? (await supabase.from('chemical_inventory').select('plant_id,chemical_name,low_stock_threshold').in('plant_id', ids)).data ?? []
      : [],
    enabled: ids.length > 0,
  });

  const thresholdMap = useMemo(() => {
    const m = new Map<string, number>();
    (thresholds ?? []).forEach((t: any) => m.set(`${t.plant_id}::${t.chemical_name}`, +t.low_stock_threshold || 0));
    return m;
  }, [thresholds]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs text-muted-foreground">Stock = Deliveries − Dosing usage</p>
        <div className="flex gap-2">
          <ExportButton table="chemical_deliveries" label="Deliveries" />
          <ExportButton table="chemical_dosing_logs" label="Dosing" />
          {isManager && <AddStockDialog />}
        </div>
      </div>
      {stockRows?.map((c) => {
        const threshold = thresholdMap.get(`${c.plant_id}::${c.chemical_name}`) ?? 10;
        const ratio = threshold ? (c.current / (threshold * 4)) * 100 : 0;
        return (
          <Card key={`${c.plant_id}::${c.chemical_name}`} className="p-3">
            <div className="flex justify-between text-sm">
              <div>
                <div className="font-medium">{c.chemical_name}</div>
                <div className="text-xs text-muted-foreground">{c.plant_name}</div>
                <div className="text-[10px] text-muted-foreground font-mono-num">
                  +{fmtNum(c.received, 1)} / -{fmtNum(c.used, 1)} {c.unit}
                </div>
              </div>
              <div className="text-right">
                <div className="font-mono-num text-base">{fmtNum(c.current, 1)} {c.unit}</div>
                {c.current < threshold && <StatusPill tone="danger">Low stock</StatusPill>}
              </div>
            </div>
            <Progress value={Math.max(0, Math.min(100, ratio))} className="mt-2 h-1.5" />
          </Card>
        );
      })}
      {!stockRows?.length && <Card className="p-4 text-center text-xs text-muted-foreground">No stock yet — log a delivery to begin tracking.</Card>}
    </div>
  );
}

function AddStockDialog() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [plantId, setPlantId] = useState('');
  const [name, setName] = useState('');
  const [customName, setCustomName] = useState('');
  const [unit, setUnit] = useState('kg');
  const [customUnit, setCustomUnit] = useState('');
  const [qty, setQty] = useState('');
  const [supplier, setSupplier] = useState('');
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [remarks, setRemarks] = useState('');

  const submit = async () => {
    const finalName = name === '__custom__' ? customName.trim() : name;
    const finalUnit = unit === '__custom__' ? customUnit.trim() : unit;
    if (!plantId || !finalName || !qty || !finalUnit) { toast.error('Plant, chemical, unit and quantity required'); return; }
    const { error } = await supabase.from('chemical_deliveries').insert({
      plant_id: plantId, chemical_name: finalName, quantity: +qty, unit: finalUnit,
      supplier: supplier || null, delivery_date: date, remarks: remarks || null, recorded_by: user?.id,
    });
    if (error) { toast.error(error.message); return; }
    const { data: existing } = await supabase.from('chemical_inventory')
      .select('id').eq('plant_id', plantId).eq('chemical_name', finalName).maybeSingle();
    if (!existing) {
      await supabase.from('chemical_inventory').insert({
        plant_id: plantId, chemical_name: finalName, unit: finalUnit, current_stock: 0, low_stock_threshold: 10,
      });
    }
    toast.success('Stock received'); setOpen(false);
    setName(''); setCustomName(''); setQty(''); setSupplier(''); setRemarks(''); setCustomUnit('');
    qc.invalidateQueries({ queryKey: ['chem-stock-computed'] });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">+ Add stock</Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Receive chemical delivery</DialogTitle></DialogHeader>
        <div className="space-y-2">
          <div><Label>Plant</Label><ChemPlantPick value={plantId} onChange={setPlantId} /></div>
          <div>
            <Label>Chemical</Label>
            <Select value={name} onValueChange={(v) => { setName(v); const k = KNOWN_CHEMICALS.find((x) => x.name === v); if (k) setUnit(k.defaultUnit); }}>
              <SelectTrigger><SelectValue placeholder="Pick chemical" /></SelectTrigger>
              <SelectContent>
                {KNOWN_CHEMICALS.map((c) => <SelectItem key={c.name} value={c.name}>{c.name}</SelectItem>)}
                <SelectItem value="__custom__">+ Custom…</SelectItem>
              </SelectContent>
            </Select>
            {name === '__custom__' && (
              <Input className="mt-2" placeholder="Custom chemical name" value={customName} onChange={(e) => setCustomName(e.target.value)} />
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Quantity</Label>
              <Input type="number" step="any" value={qty} onChange={(e) => setQty(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">Unit</Label>
              <Select value={unit} onValueChange={setUnit}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CHEM_UNITS.filter(u => u !== '__custom__').map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}
                  <SelectItem value="__custom__">+ Custom…</SelectItem>
                </SelectContent>
              </Select>
              {unit === '__custom__' && (
                <Input className="mt-2" placeholder="e.g. drum" value={customUnit} onChange={(e) => setCustomUnit(e.target.value)} />
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div><Label className="text-xs">Supplier</Label><Input value={supplier} onChange={(e) => setSupplier(e.target.value)} /></div>
            <div><Label className="text-xs">Delivery date</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          </div>
          <div><Label className="text-xs">Remarks</Label><Input value={remarks} onChange={(e) => setRemarks(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit}>Save delivery</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
