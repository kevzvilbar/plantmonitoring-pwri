import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Upload, FileSpreadsheet, Loader2, Sparkles, CheckCircle2, XCircle,
  AlertTriangle, Edit3, ChevronDown, ChevronUp, Info,
} from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { usePlants } from '@/hooks/usePlants';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Progress } from '@/components/ui/progress';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types — mirror the backend ai_import_service contract
// ---------------------------------------------------------------------------

type Target =
  | 'wells' | 'locators' | 'ro_trains'
  | 'well_readings' | 'locator_readings' | 'ro_train_readings' | 'power_readings'
  | 'skip' | 'unknown';

interface TableAnalysis {
  source: string;
  headers: string[];
  target: Target;
  entity_name: string | null;
  confidence: number;
  column_mapping: Record<string, string>;
  anomalies: string[];
  rationale: string;
  sample_rows: string[][];
  row_count: number;
}

interface AnalyzeResponse {
  analysis_id: string;
  filename: string;
  wellmeter_detected: boolean;
  ai_provider: 'openai' | 'rule-based';
  ai_model: string | null;
  tables: TableAnalysis[];
}

interface SyncSummary {
  created: { wells: number; locators: number; ro_trains: number };
  inserted: {
    well_readings: number; locator_readings: number;
    ro_train_readings: number; power_readings: number;
  };
  skipped: { source: string; reason: string }[];
  rejected: { source: string; target: string }[];
}

interface SyncResponse {
  ok: boolean;
  analysis_id: string;
  status: 'pending' | 'synced' | 'rejected' | 'partial';
  summary: SyncSummary;
}

// Decision the user makes per table — kept in component state.
interface Decision {
  action: 'sync' | 'reject';
  target: Target;
  entity_name: string;
  column_mapping: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TARGET_OPTIONS: { value: Target; label: string; group: 'entity' | 'reading' | 'meta' }[] = [
  { value: 'wells',             label: 'Wells (entity)',         group: 'entity' },
  { value: 'locators',          label: 'Locators (entity)',      group: 'entity' },
  { value: 'ro_trains',         label: 'RO Trains (entity)',     group: 'entity' },
  { value: 'well_readings',     label: 'Well Readings',          group: 'reading' },
  { value: 'locator_readings',  label: 'Locator Readings',       group: 'reading' },
  { value: 'ro_train_readings', label: 'RO Train Readings',      group: 'reading' },
  { value: 'power_readings',    label: 'Power Readings',         group: 'reading' },
  { value: 'skip',              label: 'Skip — not data',        group: 'meta' },
  { value: 'unknown',           label: 'Unknown — needs review', group: 'meta' },
];

const REASON_TEMPLATES: { label: string; value: string }[] = [
  { label: 'Routine import',     value: 'Routine import of plant data' },
  { label: 'Onboarding',         value: 'New plant onboarding — bulk import' },
  { label: 'Backfill',           value: 'Historical backfill of missing readings' },
  { label: 'Correction',         value: 'Correcting previously-imported data' },
  { label: 'Test upload',        value: 'Test upload — please mark for review' },
];

// Confidence band → tone
function confTone(c: number) {
  if (c >= 0.75) return { bar: 'bg-emerald-500', text: 'text-emerald-700 dark:text-emerald-300', label: 'High' };
  if (c >= 0.5)  return { bar: 'bg-amber-500',   text: 'text-amber-700 dark:text-amber-300',     label: 'Medium' };
  return            { bar: 'bg-rose-500',    text: 'text-rose-700 dark:text-rose-300',       label: 'Low' };
}

const TARGET_BADGE: Record<Target, string> = {
  wells:             'bg-sky-100 text-sky-800 border-sky-300 dark:bg-sky-900/30 dark:text-sky-200',
  locators:          'bg-violet-100 text-violet-800 border-violet-300 dark:bg-violet-900/30 dark:text-violet-200',
  ro_trains:         'bg-indigo-100 text-indigo-800 border-indigo-300 dark:bg-indigo-900/30 dark:text-indigo-200',
  well_readings:     'bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-900/30 dark:text-emerald-200',
  locator_readings:  'bg-teal-100 text-teal-800 border-teal-300 dark:bg-teal-900/30 dark:text-teal-200',
  ro_train_readings: 'bg-cyan-100 text-cyan-800 border-cyan-300 dark:bg-cyan-900/30 dark:text-cyan-200',
  power_readings:    'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-900/30 dark:text-amber-200',
  skip:              'bg-zinc-100 text-zinc-700 border-zinc-300 dark:bg-zinc-800 dark:text-zinc-300',
  unknown:           'bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-900/30 dark:text-rose-200',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AIImportPanel({
  onHandoffWellmeter,
  externalFile,
  onFileChange,
}: {
  /** Hand the current file to the legacy Wellmeter parser and switch tabs. */
  onHandoffWellmeter?: (file: File) => void;
  /** Lifted file state — when present the parent owns the upload so we can
   *  hand it off to the legacy parser without forcing a re-upload. */
  externalFile?: File | null;
  onFileChange?: (file: File | null) => void;
}) {
  const { data: plants } = usePlants();
  const [internalFile, setInternalFile] = useState<File | null>(null);
  const file = externalFile !== undefined ? externalFile : internalFile;
  const setFile = useCallback((f: File | null) => {
    if (onFileChange) onFileChange(f);
    else setInternalFile(f);
  }, [onFileChange]);
  const [plantId, setPlantId] = useState<string>('');
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [reason, setReason] = useState('Routine import of plant data');
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResponse | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const inputRef = useRef<HTMLInputElement>(null);

  const onChooseFile = useCallback((f: File | null) => {
    setFile(f);
    setResult(null);
    setDecisions({});
    setSyncResult(null);
    setExpanded({});
  }, [setFile]);

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) onChooseFile(f);
  }, [onChooseFile]);

  const backendUrl = (import.meta.env.REACT_APP_BACKEND_URL as string) || '';
  const backendConfigured = !!backendUrl;

  // --------------------------- Analyze ------------------------------------
  const runAnalyze = useCallback(async () => {
    if (!file) return;
    if (!backendUrl) {
      toast.error('Backend URL not configured. Set REACT_APP_BACKEND_URL in your GitHub Secrets and redeploy.');
      return;
    }
    setAnalyzing(true);
    setSyncResult(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      if (!token) throw new Error('Sign in required.');
      const fd = new FormData();
      fd.append('file', file);
      const base = backendUrl;
      const qs = plantId ? `?plant_id=${encodeURIComponent(plantId)}` : '';
      const res = await fetch(`${base}/api/import/ai-analyze${qs}`, {
        method: 'POST', body: fd, headers: { Authorization: `Bearer ${token}` },
      });
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        const text = await res.text();
        if (res.status === 404) throw new Error('Import API not found — is the backend running?');
        if (res.status === 401 || res.status === 403) throw new Error('Not authorised — please sign in again.');
        if (res.status >= 500) throw new Error(`Server error (${res.status}) — check backend logs.`);
        throw new Error(`Unexpected response (${res.status}): ${text.slice(0, 120)}`);
      }
      const json = await res.json();
      if (!res.ok) {
        throw new Error(typeof json?.detail === 'string' ? json.detail : `HTTP ${res.status}`);
      }
      const data = json as AnalyzeResponse;
      setResult(data);
      // Seed default decisions: AI suggestion is auto-approved unless target=unknown/skip
      const seed: Record<string, Decision> = {};
      for (const t of data.tables) {
        seed[t.source] = {
          action: t.target === 'unknown' || t.target === 'skip' ? 'reject' : 'sync',
          target: t.target,
          entity_name: t.entity_name ?? '',
          column_mapping: { ...t.column_mapping },
        };
      }
      setDecisions(seed);
      toast.success(`Analyzed ${data.tables.length} table(s) using ${data.ai_provider}`);
      if (data.wellmeter_detected) {
        toast('Looks like a wellmeter file — the legacy parser may give better row-level results.', {
          icon: 'ℹ️',
        });
      }
    } catch (e: any) {
      toast.error(`Analyze failed: ${e.message || e}`);
    } finally {
      setAnalyzing(false);
    }
  }, [file, plantId]);

  // --------------------------- Sync ---------------------------------------
  const reasonValid = reason.trim().length >= 5;
  const syncCount = useMemo(
    () => Object.values(decisions).filter((d) => d.action === 'sync' && d.target !== 'skip' && d.target !== 'unknown').length,
    [decisions],
  );
  const rejectCount = useMemo(
    () => Object.values(decisions).filter((d) => d.action === 'reject' || d.target === 'skip' || d.target === 'unknown').length,
    [decisions],
  );
  const needsPlant = useMemo(
    () => Object.values(decisions).some((d) => d.action === 'sync' && d.target !== 'skip' && d.target !== 'unknown'),
    [decisions],
  );
  // Allow reject-only commits (otherwise an analysis can be left `pending`
  // forever and reject decisions are never recorded in the audit log).
  const hasAnyDecision = syncCount > 0 || rejectCount > 0;
  const canSync = !!result && reasonValid && hasAnyDecision && (!needsPlant || !!plantId) && !syncing;

  const runSync = useCallback(async () => {
    if (!result || !canSync) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      if (!token) throw new Error('Sign in required.');
      const body = {
        reason: reason.trim(),
        plant_id: plantId || null,
        decisions: Object.entries(decisions).map(([source, d]) => ({
          source, action: d.action, target: d.target,
          entity_name: d.entity_name, column_mapping: d.column_mapping,
        })),
      };
      const base = backendUrl;
      const res = await fetch(
        `${base}/api/import/ai-sync/${encodeURIComponent(result.analysis_id)}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const syncContentType = res.headers.get('content-type') ?? '';
      if (!syncContentType.includes('application/json')) {
        const text = await res.text();
        if (res.status === 404) throw new Error('Sync API not found — is the backend running?');
        if (res.status === 401 || res.status === 403) throw new Error('Not authorised — please sign in again.');
        if (res.status >= 500) throw new Error(`Server error (${res.status}) — check backend logs.`);
        throw new Error(`Unexpected response (${res.status}): ${text.slice(0, 120)}`);
      }
      const json = await res.json();
      if (!res.ok) {
        throw new Error(typeof json?.detail === 'string' ? json.detail : `HTTP ${res.status}`);
      }
      const data = json as SyncResponse;
      setSyncResult(data);
      const totalCreated = data.summary.created.wells + data.summary.created.locators + data.summary.created.ro_trains;
      const totalInserted = Object.values(data.summary.inserted).reduce((s, n) => s + (+n || 0), 0);
      toast.success(`Sync ${data.status} — ${totalCreated} entit${totalCreated === 1 ? 'y' : 'ies'}, ${totalInserted} reading row(s)`);
    } catch (e: any) {
      toast.error(`Sync failed: ${e.message || e}`);
    } finally {
      setSyncing(false);
    }
  }, [result, canSync, reason, plantId, decisions]);

  const updateDecision = (source: string, patch: Partial<Decision>) => {
    setDecisions((m) => ({ ...m, [source]: { ...m[source], ...patch } }));
  };

  const toggleExpanded = (source: string) =>
    setExpanded((m) => ({ ...m, [source]: !m[source] }));

  // --------------------------- Render -------------------------------------
  return (
    <div className="space-y-3" data-testid="ai-import-panel">
      {/* Step 1 — upload + plant */}
      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Sparkles className="h-4 w-4 text-amber-500" />
          <h2 className="text-sm font-semibold">AI Universal Import</h2>
          <Badge variant="outline" className="text-[10px]">beta</Badge>
        </div>

        {!backendConfigured && (
          <div className="mb-3 rounded-md border border-amber-400/60 bg-amber-50 dark:bg-amber-950/20 p-3 flex items-start gap-2 text-xs">
            <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-amber-800 dark:text-amber-300">Backend not connected</p>
              <p className="text-amber-700 dark:text-amber-400 mt-0.5">
                AI Import requires the Python backend to be running and reachable.
                Set the <code className="bg-amber-100 dark:bg-amber-900/40 px-1 rounded">REACT_APP_BACKEND_URL</code> environment variable
                (e.g. via GitHub Secrets) to your deployed backend URL to enable this feature.
              </p>
            </div>
          </div>
        )}
        <div
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
          className={cn(
            'border-2 border-dashed rounded-lg p-6 text-center transition-colors',
            file ? 'border-amber-500/50 bg-amber-500/5' : 'border-muted-foreground/20 hover:border-amber-500/40',
          )}
        >
          <FileSpreadsheet className="h-10 w-10 mx-auto text-muted-foreground" />
          <p className="mt-2 text-sm">
            {file ? <span className="font-medium">{file.name}</span> : 'Drop any plant data file here'}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Accepts .xlsx, .xlsm, .csv, .txt, .docx — AI ignores column-header order
          </p>
          <div className="mt-2 flex gap-2 justify-center flex-wrap">
            <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()} data-testid="ai-import-browse-btn">
              <Upload className="h-3.5 w-3.5 mr-1" /> Browse
            </Button>
            <Button size="sm" onClick={runAnalyze} disabled={!file || analyzing} data-testid="ai-import-analyze-btn">
              {analyzing
                ? <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Analyzing…</>
                : <><Sparkles className="h-3.5 w-3.5 mr-1" /> Analyze with AI</>}
            </Button>
            {file && <Button size="sm" variant="ghost" onClick={() => onChooseFile(null)}>Clear</Button>}
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.xlsm,.csv,.txt,.tsv,.docx"
            className="hidden"
            onChange={(e) => onChooseFile(e.target.files?.[0] ?? null)}
          />
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-[260px_1fr] items-end">
          <div>
            <Label className="text-xs">Target plant <span className="text-muted-foreground">(needed before sync)</span></Label>
            <Select value={plantId} onValueChange={setPlantId}>
              <SelectTrigger className="mt-1"><SelectValue placeholder="Pick a plant…" /></SelectTrigger>
              <SelectContent>
                {(plants ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {result && result.wellmeter_detected && onHandoffWellmeter && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs flex items-start gap-2">
              <Info className="h-3.5 w-3.5 mt-0.5 text-amber-600 shrink-0" />
              <div className="flex-1">
                Looks like a wellmeter tri-block file — the dedicated{' '}
                <button
                  onClick={() => file && onHandoffWellmeter(file)}
                  disabled={!file}
                  className="underline text-amber-700 dark:text-amber-300 font-medium disabled:opacity-50"
                >
                  Wellmeter Parser
                </button>{' '}
                gives better row-level coverage (defective / blend / shutoff detection).
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Step 2 — review per-table decisions */}
      {result && (
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <h2 className="text-sm font-semibold">Review AI suggestions</h2>
              <p className="text-[11px] text-muted-foreground">
                {result.tables.length} table(s) detected · provider: {result.ai_provider}
                {result.ai_model ? ` (${result.ai_model})` : ''}
              </p>
            </div>
            <Badge variant="outline" className="text-[10px]" data-testid="ai-import-pending-count">
              {syncCount} marked to sync
            </Badge>
          </div>

          <div className="space-y-2">
            {result.tables.map((t) => {
              const d = decisions[t.source];
              if (!d) return null;
              const tone = confTone(t.confidence);
              const isExpanded = !!expanded[t.source];
              const willSync = d.action === 'sync' && d.target !== 'skip' && d.target !== 'unknown';
              return (
                <Card
                  key={t.source}
                  className={cn(
                    'p-3 border-l-4 transition-colors',
                    willSync
                      ? 'border-l-emerald-500/70 bg-emerald-50/30 dark:bg-emerald-950/10'
                      : 'border-l-zinc-300/70 bg-muted/20 opacity-95',
                  )}
                  data-testid={`ai-import-table-${t.source}`}
                >
                  {/* Header row */}
                  <div className="flex items-start justify-between gap-2 flex-wrap">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <FileSpreadsheet className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="font-medium text-sm truncate">{t.source}</span>
                        <Badge className={cn('text-[10px] border', TARGET_BADGE[d.target])} variant="outline">
                          {TARGET_OPTIONS.find((o) => o.value === d.target)?.label ?? d.target}
                        </Badge>
                        <span className="text-[11px] text-muted-foreground">{t.row_count} rows</span>
                      </div>
                      {t.rationale && (
                        <p className="text-[11px] text-muted-foreground mt-0.5 italic line-clamp-1">
                          {t.rationale}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <div className="text-right">
                        <div className={cn('text-[10px] font-medium', tone.text)}>
                          {tone.label} · {(t.confidence * 100).toFixed(0)}%
                        </div>
                        <div className="w-20 h-1.5 bg-muted rounded-full overflow-hidden mt-0.5">
                          <div className={cn('h-full', tone.bar)} style={{ width: `${(t.confidence * 100).toFixed(0)}%` }} />
                        </div>
                      </div>
                      <Switch
                        checked={d.action === 'sync'}
                        onCheckedChange={(v) => updateDecision(t.source, { action: v ? 'sync' : 'reject' })}
                        data-testid={`ai-import-sync-toggle-${t.source}`}
                      />
                    </div>
                  </div>

                  {/* Editable fields */}
                  <div className="grid gap-2 mt-2 sm:grid-cols-[180px_1fr_auto] items-end">
                    <div>
                      <Label className="text-[10px] text-muted-foreground">Target module</Label>
                      <Select
                        value={d.target}
                        onValueChange={(v) => updateDecision(t.source, { target: v as Target })}
                      >
                        <SelectTrigger className="h-8 text-xs mt-0.5">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {TARGET_OPTIONS.map((o) => (
                            <SelectItem key={o.value} value={o.value} className="text-xs">
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-[10px] text-muted-foreground">Entity name (well / locator / RO train)</Label>
                      <Input
                        className="h-8 text-xs mt-0.5"
                        value={d.entity_name}
                        onChange={(e) => updateDecision(t.source, { entity_name: e.target.value })}
                        disabled={d.target === 'skip' || d.target === 'unknown' || d.target === 'power_readings'}
                        placeholder={d.target === 'power_readings' ? 'n/a — power readings are plant-wide' : 'e.g. Well 1'}
                        data-testid={`ai-import-entity-${t.source}`}
                      />
                    </div>
                    <Button
                      size="sm" variant="ghost"
                      className="h-8 text-[11px]"
                      onClick={() => toggleExpanded(t.source)}
                      data-testid={`ai-import-expand-${t.source}`}
                    >
                      {isExpanded ? <ChevronUp className="h-3 w-3 mr-0.5" /> : <ChevronDown className="h-3 w-3 mr-0.5" />}
                      {isExpanded ? 'Hide details' : 'Details'}
                    </Button>
                  </div>

                  {/* Anomalies always visible */}
                  {t.anomalies.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {t.anomalies.map((a, i) => (
                        <span
                          key={`${t.source}-anomaly-${i}-${a.slice(0, 20)}`}
                          className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300 dark:bg-amber-900/30 dark:text-amber-200"
                        >
                          <AlertTriangle className="h-2.5 w-2.5" /> {a}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Expanded: column mapping + sample rows */}
                  {isExpanded && (
                    <div className="mt-3 space-y-3">
                      <div>
                        <Label className="text-[10px] text-muted-foreground flex items-center gap-1">
                          <Edit3 className="h-3 w-3" /> Column mapping
                          <span className="text-[9px] text-muted-foreground/70">(our_field → source_header)</span>
                        </Label>
                        <ColumnMappingEditor
                          headers={t.headers}
                          mapping={d.column_mapping}
                          onChange={(m) => updateDecision(t.source, { column_mapping: m })}
                          target={d.target}
                        />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Sample rows ({Math.min(t.sample_rows.length, 5)} of {t.row_count})</Label>
                        <div className="mt-0.5 rounded-md border overflow-x-auto max-w-full">
                          <table className="w-full text-[10px]">
                            <thead className="bg-muted/50">
                              <tr>
                                {t.headers.map((h, i) => (
                                  <th key={`${t.source}-h-${i}-${h || 'col'}`} className="px-1.5 py-1 text-left font-medium whitespace-nowrap">{h || `col${i + 1}`}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {t.sample_rows.slice(0, 5).map((r, ri) => (
                                <tr key={`${t.source}-row-${ri}`} className="border-t">
                                  {r.map((c, ci) => (
                                    <td key={`${t.source}-r${ri}-c${ci}`} className="px-1.5 py-0.5 whitespace-nowrap text-muted-foreground">
                                      {c || '—'}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>

          {/* Reason + audit preview + sync actions */}
          <Card className="p-3 bg-muted/30 space-y-2">
            <div className="flex items-center justify-between flex-wrap gap-1">
              <Label className="text-[11px] text-muted-foreground">
                Reason <span className="text-danger">*</span>{' '}
                <span className="text-[10px]">(min 5 chars — recorded in audit log)</span>
              </Label>
              {!reasonValid && reason.length > 0 && (
                <span className="text-[10px] text-danger">need {5 - reason.trim().length} more</span>
              )}
            </div>
            <div className="flex flex-wrap gap-1">
              {REASON_TEMPLATES.map((r) => (
                <button
                  key={r.label} type="button"
                  onClick={() => setReason(r.value)}
                  className={cn(
                    'text-[10px] rounded-full px-2 py-0.5 border transition-colors',
                    reason.trim() === r.value
                      ? 'bg-amber-500/20 border-amber-500/50 text-amber-800 dark:text-amber-200'
                      : 'bg-card hover:bg-muted/50 border-border text-muted-foreground',
                  )}
                  data-testid={`ai-import-reason-template-${r.label}`}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              maxLength={500}
              className="text-xs resize-none"
              data-testid="ai-import-reason"
            />

            <div className="rounded-md bg-card border border-border/60 px-2 py-1.5 text-[10px] font-mono text-muted-foreground space-y-0.5">
              <div className="text-[9px] uppercase tracking-wider text-muted-foreground/70">audit log preview</div>
              {Object.entries(decisions).filter(([, d]) => d.action === 'sync' && d.target !== 'skip' && d.target !== 'unknown').slice(0, 6).map(([source, d]) => (
                <div key={source} className="truncate">
                  <span className="text-foreground">[IMPORT]</span> {source} → {d.target}
                  {d.entity_name ? ` (${d.entity_name})` : ''}
                </div>
              ))}
              {Object.entries(decisions).filter(([, d]) => d.action === 'reject' || d.target === 'skip' || d.target === 'unknown').slice(0, 4).map(([source, d]) => (
                <div key={source} className="truncate text-rose-600 dark:text-rose-400">
                  <span>[IMPORT-REJECT]</span> {source} → {d.target}
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-2 flex-wrap">
              <Button size="sm" variant="outline" onClick={() => {
                setDecisions((m) => Object.fromEntries(
                  Object.entries(m).map(([k, v]) => [k, { ...v, action: 'reject' }]),
                ));
              }}>
                <XCircle className="h-3.5 w-3.5 mr-1" /> Reject all
              </Button>
              <Button
                size="sm"
                onClick={runSync}
                disabled={!canSync}
                data-testid="ai-import-sync-btn"
              >
                {syncing
                  ? <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Syncing…</>
                  : syncCount > 0
                    ? <><CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Approve & Sync ({syncCount})</>
                    : <><XCircle className="h-3.5 w-3.5 mr-1" /> Record rejections ({rejectCount})</>}
              </Button>
            </div>
            {needsPlant && !plantId && (
              <p className="text-[10px] text-danger text-right">Pick a target plant before syncing.</p>
            )}
          </Card>
        </Card>
      )}

      {/* Step 3 — sync summary */}
      {syncResult && (
        <Card className="p-4 border-emerald-500/40 bg-emerald-50/30 dark:bg-emerald-950/10" data-testid="ai-import-summary">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            <h3 className="text-sm font-semibold">
              Sync {syncResult.status} — analysis {syncResult.analysis_id.slice(0, 8)}…
            </h3>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <SummaryTile label="Wells created" value={syncResult.summary.created.wells} />
            <SummaryTile label="Locators created" value={syncResult.summary.created.locators} />
            <SummaryTile label="RO trains created" value={syncResult.summary.created.ro_trains} />
            <SummaryTile label="Reading rows inserted" value={
              Object.values(syncResult.summary.inserted).reduce((s, n) => s + (+n || 0), 0)
            } />
          </div>
          {syncResult.summary.skipped.length > 0 && (
            <div className="mt-3">
              <Label className="text-[10px] text-muted-foreground">Skipped ({syncResult.summary.skipped.length})</Label>
              <ul className="mt-0.5 text-[11px] space-y-0.5 list-disc ml-5 text-amber-700 dark:text-amber-300">
                {syncResult.summary.skipped.map((s, i) => (
                  <li key={`skipped-${s.source ?? 'unknown'}-${i}`}><strong>{s.source || '—'}:</strong> {s.reason}</li>
                ))}
              </ul>
            </div>
          )}
          {syncResult.summary.rejected.length > 0 && (
            <div className="mt-2 text-[11px] text-muted-foreground">
              Rejected: {syncResult.summary.rejected.map((r) => r.source).join(', ')}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SummaryTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-card border p-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="text-base font-semibold">{value}</div>
    </div>
  );
}

function ColumnMappingEditor({
  headers, mapping, onChange, target,
}: {
  headers: string[];
  mapping: Record<string, string>;
  onChange: (m: Record<string, string>) => void;
  target: Target;
}) {
  // Suggest the canonical fields the backend recognises per target.
  const fields = useMemo<string[]>(() => {
    if (target === 'wells' || target === 'locators' || target === 'ro_trains') {
      return ['name', 'address'];
    }
    if (target === 'well_readings') return ['date', 'initial', 'final', 'volume'];
    if (target === 'locator_readings') return ['date', 'volume'];
    if (target === 'ro_train_readings') return ['date', 'volume'];
    if (target === 'power_readings') return ['date', 'kwh'];
    return [];
  }, [target]);

  if (fields.length === 0) {
    return (
      <p className="text-[10px] text-muted-foreground italic mt-0.5">
        No mapping needed for this target.
      </p>
    );
  }

  const update = (field: string, source: string) => {
    const next = { ...mapping };
    if (source === '__none__') delete next[field];
    else next[field] = source;
    onChange(next);
  };

  return (
    <div className="grid gap-1 mt-1 sm:grid-cols-2">
      {fields.map((f) => (
        <div key={f} className="flex items-center gap-1.5 text-[11px]">
          <span className="w-16 text-muted-foreground shrink-0">{f}</span>
          <span className="text-muted-foreground">→</span>
          <Select value={mapping[f] ?? '__none__'} onValueChange={(v) => update(f, v)}>
            <SelectTrigger className="h-7 text-[11px] flex-1">
              <SelectValue placeholder="—" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__" className="text-[11px] text-muted-foreground">— none —</SelectItem>
              {headers.map((h, i) => (
                <SelectItem key={`mapping-opt-${i}-${h || 'col'}`} value={h || `col${i + 1}`} className="text-[11px]">
                  {h || `col${i + 1}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ))}
    </div>
  );
}
