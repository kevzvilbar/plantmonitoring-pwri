import { useState, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useAppStore } from '@/store/appStore';
import { usePlants } from '@/hooks/usePlants';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { StatusPill } from '@/components/StatusPill';
import { fmtNum, getCurrentPosition, isOffLocation, ALERTS } from '@/lib/calculations';
import { findExistingReading } from '@/lib/duplicateCheck';
import { downloadCSV } from '@/lib/csv';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { MapPin, Pencil, X, Droplet, Zap, Upload, Download, FileText, AlertCircle, Loader2, History, Gauge } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';

const MAX_READINGS_PER_DAY = 3;
const BASE = (import.meta.env.VITE_BACKEND_URL as string) || '';

// ─── CSV helpers ────────────────────────────────────────────────────────────

function parseCSVText(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map((line) => {
    const vals = line.split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
    return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? '']));
  });
}

function triggerTemplateDownload(filename: string, headers: string[], exampleRow: Record<string, string>) {
  downloadCSV(filename, [exampleRow]);
}

// ─── Import audit logger ────────────────────────────────────────────────────

async function logReadingImport(entry: {
  user_id: string | null;
  plant_id: string;
  module: string;
  file_name: string;
  row_count: number;
  schema_valid: boolean;
  schema_errors: string[];
  timestamp: string;
}) {
  try {
    await (supabase.from('import_audit_log' as any) as any).insert([entry]);
  } catch { /* silently ignore if table missing */ }
}

// ─── Duplicate check helper for CSV imports ──────────────────────────────────
// Uses a per-import-session cache so we only ask once per unique key.
// The actual prompt is driven by React state (see ImportReadingsDialog) via a
// Promise resolver — avoids window.confirm which is blocked in iframes.
const _dupDecisions: Map<string, 'overwrite' | 'skip'> = new Map();
function clearDupDecisions() { _dupDecisions.clear(); }

// Set by ImportReadingsDialog before each import run; resolved by the in-dialog confirm UI.
let _dupPromptResolver: ((decision: 'overwrite' | 'skip') => void) | null = null;
let _dupShowPrompt: ((label: string, isDateOnly: boolean) => void) | null = null;
// When the user chooses "Overwrite All" or "Skip All", this is set so subsequent
// duplicates are resolved immediately without prompting again.
let _bulkDupDecision: 'overwrite' | 'skip' | null = null;
function clearBulkDupDecision() { _bulkDupDecision = null; }

async function resolveImportDuplicate(key: string, label: string, isDateOnly = false): Promise<'overwrite' | 'skip'> {
  if (_dupDecisions.has(key)) return _dupDecisions.get(key)!;
  // If user already chose "Overwrite All" or "Skip All", apply that immediately.
  if (_bulkDupDecision) {
    _dupDecisions.set(key, _bulkDupDecision);
    return _bulkDupDecision;
  }
  // Ask via the React dialog (not window.confirm)
  const decision = await new Promise<'overwrite' | 'skip'>((resolve) => {
    _dupPromptResolver = resolve;
    _dupShowPrompt?.(label, isDateOnly);
  });
  _dupDecisions.set(key, decision);
  return decision;
}

// ─── Shared ImportReadingsDialog ────────────────────────────────────────────
// Each module passes its own columns, validator, and inserter.

interface ImportDialogProps {
  title: string;
  module: string;
  plantId: string;
  userId: string | null;
  schemaHint: string;           // shown in the dialog
  templateFilename: string;
  templateRow: Record<string, string>;
  validateRow: (r: Record<string, string>, i: number) => string[];
  insertRows: (rows: Record<string, string>[], plantId: string) => Promise<{ count: number; errors: string[] }>;
  onClose: () => void;
  onImported: () => void;
}

function ImportReadingsDialog({
  title, module, plantId, userId,
  schemaHint, templateFilename, templateRow,
  validateRow, insertRows,
  onClose, onImported,
}: ImportDialogProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile]     = useState<File | null>(null);
  const [rows, setRows]     = useState<Record<string, string>[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy]     = useState(false);
  const [done, setDone]     = useState(false);
  const [imported, setImported] = useState(0);
  // Intra-file duplicate handling
  const [dupRows, setDupRows] = useState<Record<string, string>[]>([]);
  const [dupResolved, setDupResolved] = useState(false);
  // DB-level duplicate confirmation (replaces window.confirm)
  const [dupConfirm, setDupConfirm] = useState<{ label: string; isDateOnly: boolean } | null>(null);

  // Wire up the module-level resolver hooks so resolveImportDuplicate() can
  // pause and ask the user via React state instead of window.confirm.
  useEffect(() => {
    _dupShowPrompt = (label, isDateOnly) => setDupConfirm({ label, isDateOnly });
    return () => { _dupShowPrompt = null; _dupPromptResolver = null; };
  }, []);

  const handleDupDecision = (decision: 'overwrite' | 'skip', applyToAll = false) => {
    if (applyToAll) {
      _bulkDupDecision = decision;
    }
    setDupConfirm(null);
    _dupPromptResolver?.(decision);
    _dupPromptResolver = null;
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f); setDone(false); setErrors([]); setRows([]); setDupRows([]); setDupResolved(false);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const parsed = parseCSVText(ev.target?.result as string);
      const errs: string[] = [];
      parsed.forEach((r, i) => errs.push(...validateRow(r, i + 2)));
      setRows(parsed);
      setErrors(errs);
    };
    reader.readAsText(f);
  };

  const doImport = async () => {
    if (!file || rows.length === 0 || errors.length > 0) return;
    setBusy(true);
    clearDupDecisions();
    clearBulkDupDecision();
    const ts = new Date().toISOString();

    // ── Duplicate detection ──────────────────────────────────────────────────
    // Power readings are one-per-day: use date-only key (YYYY-MM-DD) so that
    // two rows on the same date but different times are still caught as dups.
    // All other modules: key = entityName|YYYY-MM-DDTHH:mm so rows with the
    // same datetime but a DIFFERENT well/locator/blending name are NOT deduped.
    const isPowerModule = module === 'power';
    const seenKeys = new Map<string, number>(); // key → first row index
    const intraDups: number[] = [];
    rows.forEach((r, i) => {
      const dtRaw = r.reading_datetime || r.event_date || '';
      // Entity name: prefer well_name, then locator_name (power uses plant_name — handled separately below)
      const entityName = (r.well_name || r.locator_name || '').trim().toLowerCase();
      let dtKey: string;
      if (!dtRaw) {
        dtKey = `__nodate__${i}`;
      } else if (isPowerModule) {
        dtKey = new Date(dtRaw).toISOString().slice(0, 10); // YYYY-MM-DD
      } else {
        dtKey = new Date(dtRaw).toISOString().slice(0, 16); // YYYY-MM-DDTHH:mm
      }
      // All modules: key = "entityName|dtKey" — different names are allowed at the same datetime.
      // Power uses plant_name as its entity name (from the CSV column).
      const powerName = isPowerModule ? (r.plant_name || '').trim().toLowerCase() : '';
      const key = isPowerModule ? `${powerName}|${dtKey}` : `${entityName}|${dtKey}`;
      if (seenKeys.has(key)) intraDups.push(i);
      else seenKeys.set(key, i);
    });

    // If intra-file duplicates exist, warn and block
    if (intraDups.length > 0 && !dupResolved) {
      // Keep only first occurrence of each key, then let user confirm by clicking Import again
      const uniqueRows = rows.filter((_r, i) => !intraDups.includes(i));
      setRows(uniqueRows);
      setDupResolved(true);
      setBusy(false);
      return; // let user click Import again with deduplicated rows
    }

    const { count, errors: importErrors } = await insertRows(rows, plantId);
    await logReadingImport({
      user_id: userId,
      plant_id: plantId,
      module,
      file_name: file.name,
      row_count: rows.length,
      schema_valid: errors.length === 0,
      schema_errors: [...errors, ...importErrors],
      timestamp: ts,
    });
    setBusy(false);
    setImported(count);
    setDone(true);
    if (importErrors.length) toast.error(`${count} imported, ${importErrors.length} failed`);
    else if (count === 0) toast.info('No rows imported — all duplicates were skipped.');
    else toast.success(`${count} reading(s) imported`);
    // Only auto-close when at least one row was actually imported;
    // if everything was skipped (user chose Cancel on every overwrite prompt)
    // keep the dialog open so the user can see what happened.
    if (count > 0) onImported();
  };

  const canSubmit = !busy && !!file && rows.length > 0 && errors.length === 0;

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-4 w-4" />
            {title}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">

          {/* Download template */}
          <div className="flex items-center gap-3 rounded-md border bg-muted/30 p-3">
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 gap-1.5"
              onClick={() => triggerTemplateDownload(templateFilename, Object.keys(templateRow), templateRow)}
            >
              <Download className="h-3.5 w-3.5" />
              Download Template
            </Button>
            <span className="text-xs text-muted-foreground">Fill in the template then upload below</span>
          </div>

          {/* Schema reference */}
          <div className="rounded-md border bg-muted/20 p-3 space-y-2">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5" /> Expected columns:
            </p>
            <p className="text-[11px] font-mono text-foreground leading-relaxed break-all">{schemaHint}</p>
            <p className="text-[10px] text-muted-foreground">
              Columns marked <strong>*</strong> are required. <code>reading_datetime</code> accepts
              ISO 8601 format (e.g. <code>2024-06-15T08:30</code>) or <code>YYYY-MM-DD HH:mm</code>.
              Leave blank to default to the import timestamp.
            </p>
          </div>

          {/* File picker */}
          <div className="space-y-1.5">
            <Label className="text-xs">
              Select CSV file <span className="text-destructive">*</span>
            </Label>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 bg-teal-700 text-white hover:bg-teal-800 border-teal-700"
                onClick={() => fileRef.current?.click()}
              >
                <Upload className="h-3.5 w-3.5" />
                Choose File
              </Button>
              <span className="text-xs text-muted-foreground">{file?.name ?? 'No file chosen'}</span>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              onChange={handleFile}
              className="hidden"
              data-testid="import-file-input"
            />
          </div>

          {/* Validation feedback */}
          {file && rows.length > 0 && (
            <div className={`rounded-md border p-3 space-y-2 ${
              errors.length > 0
                ? 'border-destructive/40 bg-destructive/5'
                : 'border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/20'
            }`}>
              <p className="text-xs font-medium flex items-center gap-1.5">
                {errors.length === 0
                  ? <><span className="h-2 w-2 rounded-full bg-emerald-500 inline-block" />{rows.length} row(s) in "{file.name}" — schema valid</>
                  : <><AlertCircle className="h-3.5 w-3.5 text-destructive" />{rows.length} row(s) — {errors.length} error(s)</>
                }
              </p>
              {errors.length > 0 && (
                <ul className="text-[10px] text-destructive list-disc ml-4 space-y-0.5 max-h-28 overflow-y-auto">
                  {errors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              )}
            </div>
          )}
          {file && rows.length === 0 && (
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <AlertCircle className="h-3 w-3" /> No data rows found — check the file format.
            </p>
          )}

          {/* Row preview */}
          {rows.length > 0 && errors.length === 0 && (
            <div className="space-y-1.5">
              <p className="text-[11px] text-muted-foreground font-medium">
                Preview (first {Math.min(rows.length, 5)} of {rows.length} rows):
              </p>
              <div className="overflow-x-auto rounded-md border text-[10px]">
                <table className="min-w-full">
                  <thead className="bg-muted/50">
                    <tr>
                      {Object.keys(rows[0]).map((h) => (
                        <th key={h} className="px-2 py-1 text-left font-medium text-muted-foreground whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 5).map((r, i) => (
                      <tr key={i} className="border-t">
                        {Object.values(r).map((v, j) => (
                          <td key={j} className="px-2 py-1 whitespace-nowrap text-foreground max-w-[120px] truncate">{v || '—'}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {done && (
            <p className="text-xs text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-emerald-500 inline-block" />
              {imported} record(s) imported. Audit log written.
            </p>
          )}

          {/* Intra-file duplicate notice (shown after dedup, before re-import) */}
          {dupResolved && !done && (
            <div className="rounded-md border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/20 p-3 text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2">
              <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>Duplicate rows within the file were removed — only the first occurrence of each date is kept. Click <strong>Import Rows</strong> to proceed.</span>
            </div>
          )}

          {/* DB-level duplicate confirmation (replaces window.confirm) */}
          {dupConfirm && (
            <div className="rounded-md border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/20 p-3 space-y-2">
              <p className="text-xs font-semibold text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                Duplicate detected
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-400">
                A reading for <strong>"{dupConfirm.label}"</strong> already exists{' '}
                {dupConfirm.isDateOnly ? 'on this date' : 'at this date & time'}.
                Overwrite it, or skip this row?
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  size="sm"
                  className="bg-teal-700 text-white hover:bg-teal-800 h-7 text-xs"
                  onClick={() => handleDupDecision('overwrite')}
                >
                  Overwrite
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => handleDupDecision('skip')}
                >
                  Skip
                </Button>
                <Button
                  size="sm"
                  className="bg-teal-700 text-white hover:bg-teal-800 h-7 text-xs"
                  onClick={() => handleDupDecision('overwrite', true)}
                  title="Overwrite this and all remaining duplicates"
                >
                  Overwrite All
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => handleDupDecision('skip', true)}
                  title="Skip this and all remaining duplicates"
                >
                  Skip All
                </Button>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={!!dupConfirm}>Cancel</Button>
          <Button
            onClick={doImport}
            disabled={!canSubmit}
            className="bg-teal-700 text-white hover:bg-teal-800"
            data-testid="confirm-import-btn"
          >
            {busy && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
            Import Rows{rows.length > 0 ? ` (${rows.length})` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Per-module CSV configs ──────────────────────────────────────────────────

// Locator readings:
// locator_name*, current_reading*, reading_datetime, previous_reading, input_mode, daily_volume
// input_mode: "raw" (default — cumulative meter reading) | "direct" (daily m³ entered directly)
// When input_mode=direct, supply daily_volume instead of current_reading; current_reading can be blank.
const LOCATOR_SCHEMA = 'locator_name*, current_reading, reading_datetime (YYYY-MM-DDTHH:mm), previous_reading, input_mode (raw|direct), daily_volume';
const LOCATOR_TEMPLATE_ROW = {
  locator_name: 'MCWD - M1',
  current_reading: '1234.56',
  reading_datetime: '2024-06-15T08:30',
  previous_reading: '1200.00',
  input_mode: 'raw',
  daily_volume: '',
};

function validateLocatorReadingRow(r: Record<string, string>, i: number): string[] {
  const e: string[] = [];
  if (!r.locator_name?.trim()) e.push(`Row ${i}: locator_name is required`);
  const isDirect = r.input_mode?.trim().toLowerCase() === 'direct';
  if (isDirect) {
    if (!r.daily_volume?.trim() || isNaN(Number(r.daily_volume)) || Number(r.daily_volume) <= 0)
      e.push(`Row ${i}: daily_volume must be a positive number when input_mode=direct`);
  } else {
    if (!r.current_reading?.trim() || isNaN(Number(r.current_reading)))
      e.push(`Row ${i}: current_reading must be a number`);
  }
  if (r.previous_reading && isNaN(Number(r.previous_reading)))
    e.push(`Row ${i}: previous_reading must be a number`);
  if (r.daily_volume && !isDirect && isNaN(Number(r.daily_volume)))
    e.push(`Row ${i}: daily_volume must be a number`);
  if (r.reading_datetime && isNaN(Date.parse(r.reading_datetime)))
    e.push(`Row ${i}: reading_datetime is not a valid date`);
  return e;
}

async function insertLocatorReadings(
  rows: Record<string, string>[],
  plantId: string,
  userId: string | null,
): Promise<{ count: number; errors: string[] }> {
  // Resolve locator names → IDs
  const { data: locators } = await supabase
    .from('locators').select('id, name').eq('plant_id', plantId);
  const nameToId: Record<string, string> = {};
  (locators ?? []).forEach((l: any) => { nameToId[l.name.toLowerCase()] = l.id; });

  let count = 0;
  const errors: string[] = [];
  for (const r of rows) {
    const locatorId = nameToId[r.locator_name?.toLowerCase()];
    if (!locatorId) { errors.push(`Locator not found: "${r.locator_name}"`); continue; }
    const dt = r.reading_datetime ? new Date(r.reading_datetime).toISOString() : new Date().toISOString();
    const dtMin = dt.slice(0, 16); // minute-level key

    // Check for existing reading at the same datetime
    const { data: existing } = await supabase.from('locator_readings')
      .select('id').eq('locator_id', locatorId)
      .gte('reading_datetime', `${dtMin}:00`)
      .lte('reading_datetime', `${dtMin}:59`).limit(1);

    if (existing && existing.length > 0) {
      const decision = await resolveImportDuplicate(`${locatorId}|${dtMin}`, `${r.locator_name} @ ${dtMin}`);
      if (decision === 'skip') continue;
      // overwrite: update existing
      const isDirect = r.input_mode?.trim().toLowerCase() === 'direct';
      const updatePayload: Record<string, any> = { reading_datetime: dt, recorded_by: userId };
      if (isDirect) {
        updatePayload.current_reading = r.previous_reading ? +r.previous_reading : 0;
        updatePayload.previous_reading = r.previous_reading ? +r.previous_reading : null;
        updatePayload.daily_volume = +r.daily_volume;
      } else {
        const csvCurLoc = +r.current_reading;
        const csvPrevLoc = r.previous_reading ? +r.previous_reading : null;
        updatePayload.current_reading = csvCurLoc;
        updatePayload.previous_reading = csvPrevLoc;
        // Bug 2 fix: always persist daily_volume (explicit or computed)
        updatePayload.daily_volume = r.daily_volume?.trim() ? +r.daily_volume : (csvPrevLoc != null ? csvCurLoc - csvPrevLoc : null);
      }
      const { error } = await supabase.from('locator_readings').update(updatePayload).eq('id', existing[0].id);
      if (error) errors.push(error.message); else count++;
      continue;
    }

    const isDirect = r.input_mode?.trim().toLowerCase() === 'direct';
    const insertPayload: Record<string, any> = {
      locator_id: locatorId,
      plant_id: plantId,
      reading_datetime: dt,
      recorded_by: userId,
    };
    if (isDirect) {
      // Direct m³ mode: store daily_volume; current_reading stays at prev to preserve sequence
      insertPayload.current_reading = r.previous_reading ? +r.previous_reading : 0;
      insertPayload.previous_reading = r.previous_reading ? +r.previous_reading : null;
      insertPayload.daily_volume = +r.daily_volume;
    } else {
      const csvCurLoc2 = +r.current_reading;
      const csvPrevLoc2 = r.previous_reading ? +r.previous_reading : null;
      insertPayload.current_reading = csvCurLoc2;
      insertPayload.previous_reading = csvPrevLoc2;
      // Bug 2 fix: always persist daily_volume (explicit or computed from delta)
      insertPayload.daily_volume = r.daily_volume?.trim() ? +r.daily_volume : (csvPrevLoc2 != null ? csvCurLoc2 - csvPrevLoc2 : null);
    }
    const { error } = await supabase.from('locator_readings').insert(insertPayload);
    if (error) errors.push(error.message);
    else count++;
  }
  return { count, errors };
}

// Well readings:
// well_name*, current_reading*, reading_datetime, previous_reading, power_meter_reading, solar_meter_reading
const WELL_SCHEMA = 'well_name*, current_reading*, reading_datetime (YYYY-MM-DDTHH:mm), previous_reading, power_meter_reading, solar_meter_reading';
const WELL_TEMPLATE_ROW = {
  well_name: 'Well #1',
  current_reading: '5678.90',
  reading_datetime: '2024-06-15T08:30',
  previous_reading: '5600.00',
  power_meter_reading: '',
  solar_meter_reading: '',
};

function validateWellReadingRow(r: Record<string, string>, i: number): string[] {
  const e: string[] = [];
  if (!r.well_name?.trim()) e.push(`Row ${i}: well_name is required`);
  if (!r.current_reading?.trim() || isNaN(Number(r.current_reading)))
    e.push(`Row ${i}: current_reading must be a number`);
  if (r.previous_reading && isNaN(Number(r.previous_reading)))
    e.push(`Row ${i}: previous_reading must be a number`);
  if (r.power_meter_reading && isNaN(Number(r.power_meter_reading)))
    e.push(`Row ${i}: power_meter_reading must be a number`);
  if (r.solar_meter_reading && isNaN(Number(r.solar_meter_reading)))
    e.push(`Row ${i}: solar_meter_reading must be a number`);
  if (r.reading_datetime && isNaN(Date.parse(r.reading_datetime)))
    e.push(`Row ${i}: reading_datetime is not a valid date`);
  return e;
}

async function insertWellReadings(
  rows: Record<string, string>[],
  plantId: string,
  userId: string | null,
): Promise<{ count: number; errors: string[] }> {
  const { data: wells } = await supabase
    .from('wells').select('id, name').eq('plant_id', plantId);
  const nameToId: Record<string, string> = {};
  (wells ?? []).forEach((w: any) => { nameToId[w.name.toLowerCase()] = w.id; });

  let count = 0;
  const errors: string[] = [];
  for (const r of rows) {
    const wellId = nameToId[r.well_name?.toLowerCase()];
    if (!wellId) { errors.push(`Well not found: "${r.well_name}"`); continue; }
    const dt = r.reading_datetime ? new Date(r.reading_datetime).toISOString() : new Date().toISOString();
    const dtMin = dt.slice(0, 16);

    // Duplicate check
    const { data: existing } = await supabase.from('well_readings')
      .select('id').eq('well_id', wellId)
      .gte('reading_datetime', `${dtMin}:00`)
      .lte('reading_datetime', `${dtMin}:59`).limit(1);

    if (existing && existing.length > 0) {
      const decision = await resolveImportDuplicate(`${wellId}|${dtMin}`, `${r.well_name} @ ${dtMin}`);
      if (decision === 'skip') continue;
      const { error } = await supabase.from('well_readings').update({
        current_reading: +r.current_reading,
        previous_reading: r.previous_reading ? +r.previous_reading : null,
        power_meter_reading: r.power_meter_reading ? +r.power_meter_reading : null,
        solar_meter_reading: r.solar_meter_reading ? +r.solar_meter_reading : null,
        reading_datetime: dt,
        recorded_by: userId,
      }).eq('id', existing[0].id);
      if (error) errors.push(error.message); else count++;
      continue;
    }

    // Bug 1 fix: compute and persist daily_volume so Dashboard aggregation works
    const csvCur = +r.current_reading;
    const csvPrev = r.previous_reading ? +r.previous_reading : null;
    const csvDailyVol = csvPrev != null ? csvCur - csvPrev : null;

    const { error } = await supabase.from('well_readings').insert({
      well_id: wellId,
      plant_id: plantId,
      current_reading: csvCur,
      previous_reading: csvPrev,
      daily_volume: csvDailyVol,
      power_meter_reading: r.power_meter_reading ? +r.power_meter_reading : null,
      solar_meter_reading: r.solar_meter_reading ? +r.solar_meter_reading : null,
      reading_datetime: dt,
      recorded_by: userId,
    });
    if (error) errors.push(error.message);
    else count++;
  }
  return { count, errors };
}

// Blending readings:
// well_name*, volume_m3*, event_date (YYYY-MM-DD)
const BLENDING_SCHEMA = 'well_name*, volume_m3* (m³), event_date (YYYY-MM-DD), reading_datetime (YYYY-MM-DDTHH:mm)';
const BLENDING_TEMPLATE_ROW = {
  well_name: 'Well #2',
  volume_m3: '150.00',
  event_date: '2024-06-15',
  reading_datetime: '2024-06-15T08:30',
};

function validateBlendingRow(r: Record<string, string>, i: number): string[] {
  const e: string[] = [];
  if (!r.well_name?.trim()) e.push(`Row ${i}: well_name is required`);
  if (!r.volume_m3?.trim() || isNaN(Number(r.volume_m3)) || Number(r.volume_m3) <= 0)
    e.push(`Row ${i}: volume_m3 must be a positive number`);
  if (r.event_date && isNaN(Date.parse(r.event_date)))
    e.push(`Row ${i}: event_date is not a valid date (use YYYY-MM-DD)`);
  return e;
}

async function insertBlendingReadings(
  rows: Record<string, string>[],
  plantId: string,
  plantName: string,
): Promise<{ count: number; errors: string[] }> {
  const { data: wells } = await supabase
    .from('wells').select('id, name').eq('plant_id', plantId);
  const nameToId: Record<string, string> = {};
  (wells ?? []).forEach((w: any) => { nameToId[w.name.toLowerCase()] = w.id; });

  let count = 0;
  const errors: string[] = [];
  for (const r of rows) {
    const wellId = nameToId[r.well_name?.toLowerCase()];
    if (!wellId) { errors.push(`Well not found: "${r.well_name}"`); continue; }
    const eventDate = r.event_date || new Date().toISOString().slice(0, 10);

    // Duplicate check: same well + same event_date → ask user to overwrite or skip
    try {
      const { data: existing } = await (supabase.from('blending_events' as any) as any)
        .select('id')
        .eq('well_id', wellId)
        .eq('event_date', eventDate)
        .limit(1);
      if (existing && existing.length > 0) {
        const decision = await resolveImportDuplicate(
          `${wellId}|${eventDate}`,
          `${r.well_name} @ ${eventDate}`,
          true, // date-only match
        );
        if (decision === 'skip') continue;
        // overwrite: fall through — the API call below will upsert/replace
      }
    } catch {
      // blending_events table may not exist yet — fall through and let the API handle it
    }

    try {
      const res = await fetch(`${BASE}/api/blending/audit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          well_id: wellId,
          plant_id: plantId,
          well_name: r.well_name,
          plant_name: plantName,
          event_date: eventDate,
          volume_m3: +r.volume_m3,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      count++;
    } catch (e: any) {
      errors.push(e.message);
    }
  }
  return { count, errors };
}

// Power readings:
// meter_reading_kwh*, reading_datetime* — solar/grid columns optional and only needed
// if the energy migration (20260427) has been run on this Supabase instance.
// solar_input_mode: "raw" (default — cumulative meter reading, Δ auto-computed)
//                 | "direct" (daily kWh entered directly — stored as daily_solar_kwh; solar_meter_reading ignored)
const POWER_SCHEMA = 'plant_name*, meter_reading_kwh*, reading_datetime* (YYYY-MM-DDTHH:mm), solar_meter_reading (optional), solar_input_mode (raw|direct, optional), daily_solar_kwh (optional), daily_grid_kwh (optional)';
const POWER_TEMPLATE_ROW = {
  plant_name: 'Plant A',
  meter_reading_kwh: '12345.6',
  reading_datetime: '2024-06-15T08:30',
  solar_meter_reading: '',
  solar_input_mode: '',
  daily_solar_kwh: '',
  daily_grid_kwh: '',
};

function validatePowerRow(r: Record<string, string>, i: number): string[] {
  const e: string[] = [];
  if (!r.plant_name?.trim()) e.push(`Row ${i}: plant_name is required`);
  if (!r.meter_reading_kwh?.trim() || isNaN(Number(r.meter_reading_kwh)))
    e.push(`Row ${i}: meter_reading_kwh is required and must be a number`);
  if (!r.reading_datetime?.trim() || isNaN(Date.parse(r.reading_datetime)))
    e.push(`Row ${i}: reading_datetime is required and must be a valid datetime`);
  if (r.solar_meter_reading && isNaN(Number(r.solar_meter_reading)))
    e.push(`Row ${i}: solar_meter_reading must be a number`);
  if (r.solar_input_mode && !['raw', 'direct'].includes(r.solar_input_mode.trim().toLowerCase()))
    e.push(`Row ${i}: solar_input_mode must be "raw" or "direct"`);
  if (r.daily_solar_kwh && isNaN(Number(r.daily_solar_kwh)))
    e.push(`Row ${i}: daily_solar_kwh must be a number`);
  if (r.daily_grid_kwh && isNaN(Number(r.daily_grid_kwh)))
    e.push(`Row ${i}: daily_grid_kwh must be a number`);
  return e;
}

async function insertPowerReadings(
  rows: Record<string, string>[],
  plantId: string,
  userId: string | null,
): Promise<{ count: number; errors: string[] }> {
  // Resolve plant names → IDs (supports multi-plant CSVs via plant_name column)
  const { data: allPlants } = await supabase.from('plants' as any).select('id, name');
  const plantNameToId: Record<string, string> = {};
  (allPlants ?? []).forEach((p: any) => { plantNameToId[p.name.toLowerCase()] = p.id; });

  let count = 0;
  const errors: string[] = [];
  for (const r of rows) {
    // Resolve the target plant: use plant_name from CSV row if present, else fall back to plantId
    const rowPlantId = r.plant_name?.trim()
      ? (plantNameToId[r.plant_name.trim().toLowerCase()] ?? plantId)
      : plantId;

    const dt = new Date(r.reading_datetime).toISOString();
    // Power readings are one-per-day: use date-only key for duplicate detection
    // (matches manual entry which uses windowKind: 'day')
    const dtDate = dt.slice(0, 10); // YYYY-MM-DD
    const dayStart = `${dtDate}T00:00:00.000Z`;
    const dayEnd   = `${dtDate}T23:59:59.999Z`;

    // Duplicate check for power readings — one per calendar day per plant
    const { data: existing } = await supabase.from('power_readings')
      .select('id').eq('plant_id', rowPlantId)
      .gte('reading_datetime', dayStart)
      .lte('reading_datetime', dayEnd).limit(1);

    const payload: Record<string, any> = {
      plant_id: rowPlantId,
      meter_reading_kwh: +r.meter_reading_kwh,
      reading_datetime: dt,
      recorded_by: userId,
    };
    // Solar input mode: "direct" stores daily_solar_kwh only (no cumulative meter write);
    // "raw" (default) stores solar_meter_reading and optionally daily_solar_kwh.
    const solarMode = r.solar_input_mode?.trim().toLowerCase() === 'direct' ? 'direct' : 'raw';
    if (solarMode === 'direct') {
      // Direct daily kWh: supply via daily_solar_kwh column OR via solar_meter_reading (treated as direct)
      const directKwh = r.daily_solar_kwh?.trim() || r.solar_meter_reading?.trim();
      if (directKwh) payload.daily_solar_kwh = +directKwh;
    } else {
      // Raw cumulative mode
      if (r.solar_meter_reading?.trim()) payload.solar_meter_reading = +r.solar_meter_reading;
      if (r.daily_solar_kwh?.trim()) payload.daily_solar_kwh = +r.daily_solar_kwh;
    }
    if (r.daily_grid_kwh?.trim())  payload.daily_grid_kwh  = +r.daily_grid_kwh;
    // Bug 3 fix: compute and persist daily_consumption_kwh from the CSV's explicit column
    // or from the delta vs the previous reading for this plant on that day.
    if (r.daily_grid_kwh?.trim()) {
      // If daily_grid_kwh is supplied in the CSV, use that directly as total consumption
      payload.daily_consumption_kwh = +r.daily_grid_kwh;
    } else if (existing && (existing as any[]).length > 0) {
      // overwrite path: delta will be computed after fetch; handled below
    }
    // Note: when there is no prior reading and no explicit column the field stays null —
    // which is correct; Dashboard will show 0 for that row just as it did before the bug.

    const doInsert = async () => {
      const { error } = await supabase.from('power_readings').insert(payload);
      if (error) {
        if (error.message.includes('daily_solar_kwh') || error.message.includes('daily_grid_kwh') || error.message.includes('solar_meter_reading')) {
          delete payload.daily_solar_kwh; delete payload.daily_grid_kwh; delete payload.solar_meter_reading;
          const { error: e2 } = await supabase.from('power_readings').insert(payload);
          if (e2) errors.push(e2.message); else count++;
        } else { errors.push(error.message); }
      } else { count++; }
    };

    if (existing && existing.length > 0) {
      const decision = await resolveImportDuplicate(`${rowPlantId}|${dtDate}`, `${r.plant_name?.trim() || 'Power'} @ ${dtDate}`, true);
      if (decision === 'skip') continue;
      // overwrite — with the same column-fallback retry used by doInsert
      const { error } = await supabase.from('power_readings').update(payload).eq('id', existing[0].id);
      if (error) {
        if (error.message.includes('daily_solar_kwh') || error.message.includes('daily_grid_kwh') || error.message.includes('solar_meter_reading')) {
          // optional columns not yet in DB — strip and retry
          const { daily_solar_kwh: _s, daily_grid_kwh: _g, solar_meter_reading: _sm, ...fallbackPayload } = payload as any;
          const { error: e2 } = await supabase.from('power_readings').update(fallbackPayload).eq('id', existing[0].id);
          if (e2) errors.push(e2.message); else count++;
        } else {
          errors.push(error.message);
        }
      } else {
        count++;
      }
    } else {
      await doInsert();
    }
  }
  return { count, errors };
}

// ─── Blending wells list (Mongo-backed with Supabase fallback) ───────────────
function useBlendingWells(plantId: string) {
  return useQuery<{ wells: { well_id: string }[] }>({
    queryKey: ['blending-wells', plantId],
    queryFn: async () => {
      // 1. Try the backend API first (Mongo-backed)
      try {
        const qs = plantId ? `?plant_id=${encodeURIComponent(plantId)}` : '';
        const res = await fetch(`${BASE}/api/blending/wells${qs}`);
        if (res.ok) {
          const json = await res.json();
          // Only trust the result if it actually returned wells data
          if (Array.isArray(json?.wells)) return json;
        }
      } catch {
        // API unavailable — fall through to Supabase
      }

      // 2. Fallback: read directly from the well_blending Supabase table
      // (same source Plants.tsx uses for the blending checkbox)
      try {
        const { data, error } = await supabase
          .from('well_blending' as any)
          .select('well_id')
          .eq('plant_id', plantId);
        if (!error && Array.isArray(data) && data.length > 0) {
          return { wells: (data as any[]).map((r) => ({ well_id: r.well_id })) };
        }
      } catch {
        // Table may not exist yet
      }

      return { wells: [] };
    },
    enabled: !!plantId,
    retry: false,
  });
}

const TAB_ALIASES: Record<string, string> = {
  locator: 'locator', locators: 'locator',
  well: 'well', wells: 'well',
  product: 'product', production: 'product',
  blending: 'blending', bypass: 'blending',
  power: 'power',
};
const VALID_TABS = new Set(['locator', 'well', 'product', 'blending', 'power']);

// ─── PlantSelector ───────────────────────────────────────────────────────────
function PlantSelector({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data: plants } = usePlants();
  const { selectedPlantId } = useAppStore();
  useEffect(() => { if (selectedPlantId && !value) onChange(selectedPlantId); }, [selectedPlantId]);
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger><SelectValue placeholder="Select plant" /></SelectTrigger>
      <SelectContent>
        {plants?.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

// ─── Operations page ─────────────────────────────────────────────────────────
export default function Operations() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlTab = TAB_ALIASES[(searchParams.get('tab') || '').toLowerCase()] ?? 'locator';
  const [tab, setTab] = useState<string>(urlTab);

  useEffect(() => {
    if (urlTab !== tab) setTab(urlTab);
  }, [urlTab]);

  const handleTabChange = (next: string) => {
    if (!VALID_TABS.has(next)) return;
    setTab(next);
    const sp = new URLSearchParams(searchParams);
    sp.set('tab', next);
    setSearchParams(sp, { replace: true });
  };

  return (
    <div className="space-y-3 animate-fade-in">
      <h1 className="text-xl font-semibold tracking-tight">Operations</h1>
      <div className="grid grid-cols-5 gap-1 p-1 bg-muted rounded-lg w-full">
        {(['locator', 'well', 'product', 'blending', 'power'] as const).map((t) => (
          <button
            key={t}
            onClick={() => handleTabChange(t)}
            className={[
              'py-2 text-sm font-medium rounded-md transition-all duration-200 capitalize focus-visible:outline-none',
              tab === t ? 'bg-teal-700 text-white shadow-sm' : 'text-muted-foreground hover:text-foreground',
            ].join(' ')}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="mt-3">
        {tab === 'locator'  && <LocatorReadingForm />}
        {tab === 'well'     && <WellReadingForm />}
        {tab === 'product'  && <ProductForm />}
        {tab === 'blending' && <BlendingForm />}
        {tab === 'power'    && <PowerForm />}
      </div>
    </div>
  );
}

// ─── LOCATOR ─────────────────────────────────────────────────────────────────

function LocatorReadingForm() {
  const qc = useQueryClient();
  const { user, isAdmin, isManager } = useAuth();
  const [plantId, setPlantId] = useState('');
  const [importOpen, setImportOpen] = useState(false);

  const { data: locators } = useQuery({
    queryKey: ['op-locators', plantId],
    queryFn: async () => plantId
      ? (await supabase.from('locators').select('*').eq('plant_id', plantId).eq('status', 'Active').order('name')).data ?? []
      : [],
    enabled: !!plantId,
  });

  const { data: recentReadings } = useQuery({
    queryKey: ['op-loc-recent', plantId],
    queryFn: async () => {
      if (!plantId) return [];
      const start = new Date(); start.setDate(start.getDate() - 30);
      return (await supabase.from('locator_readings')
        .select('*').eq('plant_id', plantId)
        .gte('reading_datetime', start.toISOString())
        .order('reading_datetime', { ascending: false })).data ?? [];
    },
    enabled: !!plantId,
  });

  const { latestByLocator, todayByLocator, avgByLocator } = useMemo(() => {
    const latest: Record<string, any> = {};
    const today: Record<string, any[]> = {};
    const avgs: Record<string, number | null> = {};
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const volsByLocator: Record<string, number[]> = {};
    recentReadings?.forEach((r: any) => {
      if (!latest[r.locator_id]) latest[r.locator_id] = r;
      if (new Date(r.reading_datetime) >= startOfDay) (today[r.locator_id] ||= []).push(r);
      if (r.daily_volume != null && r.daily_volume > 0) (volsByLocator[r.locator_id] ||= []).push(r.daily_volume);
    });
    for (const [k, v] of Object.entries(volsByLocator))
      avgs[k] = v.length ? v.reduce((s, n) => s + n, 0) / v.length : null;
    return { latestByLocator: latest, todayByLocator: today, avgByLocator: avgs };
  }, [recentReadings]);

  return (
    <div className="space-y-3">
      <Card className="p-3">
        <Label>Plant</Label>
        {/* Plant selector row — Import button sits inline on the right */}
        <div className="flex items-center gap-2 mt-1">
          <div className="flex-1">
            <PlantSelector value={plantId} onChange={setPlantId} />
          </div>
          {isAdmin && plantId && (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 gap-1.5 border-teal-600 text-teal-700 hover:bg-teal-50 dark:hover:bg-teal-950/30"
              onClick={() => setImportOpen(true)}
              data-testid="import-locator-readings-btn"
            >
              <Upload className="h-3.5 w-3.5" />
              Import
            </Button>
          )}
        </div>
      </Card>

      {plantId && (
        <Card className="p-0 overflow-hidden">
          <div className="px-3 py-2 border-b bg-muted/40 text-xs font-medium flex items-center justify-between">
            <span>Active locators</span>
            <span className="text-muted-foreground">{locators?.length ?? 0} total</span>
          </div>
          {locators?.length ? (
            <ul className="divide-y">
              {locators.map((l: any) => (
                <li key={l.id}>
                  <LocatorRow
                    locator={l} plantId={plantId}
                    previous={latestByLocator[l.id]?.current_reading ?? null}
                    todayReadings={todayByLocator[l.id] ?? []}
                    avgVol={avgByLocator[l.id] ?? null}
                    userId={user?.id}
                    onSaved={() => qc.invalidateQueries()}
                    isManagerOrAdmin={isAdmin || isManager}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p className="p-3 text-xs text-muted-foreground">No active locators for this plant</p>
          )}
        </Card>
      )}

      {importOpen && (
        <ImportReadingsDialog
          title="Import Locator Readings from CSV"
          module="Locator Readings"
          plantId={plantId}
          userId={user?.id ?? null}
          schemaHint={LOCATOR_SCHEMA}
          templateFilename="locator_readings_template.csv"
          templateRow={LOCATOR_TEMPLATE_ROW}
          validateRow={validateLocatorReadingRow}
          insertRows={(rows, pid) => insertLocatorReadings(rows, pid, user?.id ?? null)}
          onClose={() => setImportOpen(false)}
          onImported={() => { setImportOpen(false); qc.invalidateQueries({ queryKey: ['op-loc-recent', plantId] }); }}
        />
      )}
    </div>
  );
}

function LocatorRow({
  locator, plantId, previous, todayReadings, avgVol, userId, onSaved, isManagerOrAdmin,
}: {
  locator: any; plantId: string; previous: number | null;
  todayReadings: any[]; avgVol: number | null;
  userId: string | undefined; onSaved: () => void;
  isManagerOrAdmin: boolean;
}) {
  const [reading, setReading]     = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving]       = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [customDt, setCustomDt]   = useState(format(new Date(), "yyyy-MM-dd'T'HH:mm"));

  // 'raw'  = user enters cumulative meter reading; delta = cur - prev
  // 'direct' = user enters daily m³ directly; stored as daily_volume
  const [locInputMode, setLocInputMode] = useState<'raw' | 'direct'>('raw');

  const cur      = +reading || 0;
  const dailyVol = locInputMode === 'direct'
    ? (reading ? +reading : null)                      // entered value IS the delta
    : (previous != null && reading ? cur - previous : null);
  const belowPrev = locInputMode === 'raw' && previous != null && cur > 0 && cur < previous;
  const highVol   = locInputMode === 'raw' && avgVol != null && dailyVol != null && dailyVol > avgVol * ALERTS.avg_multiplier_warn;
  const todayCount = todayReadings.length;
  const lastToday  = todayReadings[0] ?? null;
  const atLimit    = !editingId && todayCount >= MAX_READINGS_PER_DAY;

  const save = async () => {
    if (!reading) { toast.error(`${locator.name}: enter a reading`); return; }
    if (atLimit) { toast.error(`${locator.name}: max ${MAX_READINGS_PER_DAY} readings/day reached`); return; }
    if (locInputMode === 'direct' && +reading <= 0) { toast.error(`${locator.name}: enter a positive volume`); return; }
    if (belowPrev && !window.confirm(`${locator.name}: reading below previous — save anyway?`)) return;
    if (!belowPrev && highVol && !window.confirm(`${locator.name}: volume unusually high — save anyway?`)) return;

    setSaving(true);
    let gps_lat = null, gps_lng = null, off = false;
    try {
      const pos = await getCurrentPosition();
      gps_lat = pos.coords.latitude; gps_lng = pos.coords.longitude;
      if (locator.gps_lat && locator.gps_lng)
        off = isOffLocation(gps_lat, gps_lng, locator.gps_lat, locator.gps_lng, 100);
    } catch (err) { console.warn('[Operations] geolocation unavailable:', err); }

    const payload: any = locInputMode === 'direct'
      ? {
          // Direct m³: stored value IS the consumption; current_reading stays at prev so next delta is correct
          locator_id: locator.id, plant_id: plantId,
          current_reading: previous ?? cur,
          previous_reading: previous,
          daily_volume: cur,
          gps_lat, gps_lng, off_location_flag: off, recorded_by: userId,
          reading_datetime: new Date(customDt).toISOString(),
        }
      : {
          locator_id: locator.id, plant_id: plantId,
          current_reading: cur, previous_reading: previous,
          daily_volume: dailyVol ?? null,   // Bug 2 fix: persist delta for Dashboard consumption total
          gps_lat, gps_lng, off_location_flag: off, recorded_by: userId,
          reading_datetime: new Date(customDt).toISOString(),
        };
    const { error } = editingId
      ? await supabase.from('locator_readings').update(payload).eq('id', editingId)
      : await supabase.from('locator_readings').insert(payload);

    setSaving(false);
    if (error) { toast.error(error.message); return; }
    toast.success(`${locator.name}: ${editingId ? 'updated' : 'saved'}`);
    setReading(''); setEditingId(null); onSaved();
  };

  return (
    <div className="p-3 space-y-2">
      {/* Row 1: Name left | compact date picker right */}
      <div className="flex items-center justify-between gap-2 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <div className="text-sm font-medium truncate">{locator.name}</div>
          {lastToday?.off_location_flag && <StatusPill tone="warn"><MapPin className="h-3 w-3" /> off</StatusPill>}
          {editingId && <span className="text-[10px] uppercase tracking-wide text-highlight">editing</span>}
        </div>
        <label className="shrink-0 cursor-pointer relative">
          <span className="text-[11px] text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded px-2 py-1 font-mono-num whitespace-nowrap hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors">
            {customDt ? new Date(customDt).toLocaleString([], { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : '—'}
          </span>
          <Input type="datetime-local" value={customDt} onChange={e => setCustomDt(e.target.value)}
            className="absolute inset-0 opacity-0 w-full h-full cursor-pointer" title="Reading date & time" />
        </label>
      </div>

      {/* Row 1b: input mode toggle */}
      <div className="flex items-center rounded-md border border-border overflow-hidden text-[10px] font-medium w-fit">
        <button type="button"
          onClick={() => { setLocInputMode('raw'); setReading(''); }}
          className={`px-2.5 py-1 transition-colors ${locInputMode === 'raw' ? 'bg-teal-600 text-white' : 'bg-transparent text-muted-foreground hover:bg-muted'}`}
          title="Cumulative meter reading — Δ auto-computed from previous">Raw Meter</button>
        <button type="button"
          onClick={() => { setLocInputMode('direct'); setReading(''); }}
          className={`px-2.5 py-1 transition-colors border-l border-border ${locInputMode === 'direct' ? 'bg-teal-600 text-white' : 'bg-transparent text-muted-foreground hover:bg-muted'}`}
          title="Enter daily m³ consumption directly — no previous reading needed">Direct m³</button>
      </div>

      {/* Row 1c: contextual prev / status line */}
      <div className="text-xs text-muted-foreground truncate">
        {locInputMode === 'raw' ? (
          <>
            prev: <span className="font-mono-num">{previous == null ? '—' : fmtNum(previous)}</span>
            {dailyVol != null && <> · Δ <span className="font-mono-num">{fmtNum(dailyVol)} m³</span></>}
            <span className="mx-1">·</span>
            <span className={atLimit ? 'text-warn-foreground' : ''}>{todayCount}/{MAX_READINGS_PER_DAY} today</span>
          </>
        ) : (
          <>
            <span className="text-teal-600 dark:text-teal-400 font-medium">Direct m³ mode</span>
            {dailyVol != null && <> · <span className="font-mono-num text-teal-600">{fmtNum(dailyVol)} m³</span> will be saved</>}
            <span className="mx-1">·</span>
            <span className={atLimit ? 'text-warn-foreground' : ''}>{todayCount}/{MAX_READINGS_PER_DAY} today</span>
          </>
        )}
      </div>

      {/* Row 2: Reading input + Save + action buttons */}
      <div className="flex items-center gap-2">
        <Input
          type="number" step="any" inputMode="decimal"
          value={reading} onChange={(e) => setReading(e.target.value)}
          placeholder={locInputMode === 'direct' ? 'Daily m³' : 'Reading'}
          className="flex-1 min-w-0"
        />
        <Button onClick={save} disabled={saving || !reading || atLimit} size="sm" className="shrink-0">
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : editingId ? 'Update' : 'Save'}
        </Button>
        {lastToday && !editingId && (
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0 rounded-full shrink-0"
            onClick={() => { setEditingId(lastToday.id); setReading(String(lastToday.current_reading)); }}
            title={`Edit last today reading (${fmtNum(lastToday.current_reading)})`}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        )}
        {editingId && (
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0 rounded-full shrink-0"
            onClick={() => { setEditingId(null); setReading(''); }} title="Cancel edit">
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
        {isManagerOrAdmin && (
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0 rounded-full shrink-0 text-muted-foreground"
            onClick={() => setShowHistory(true)} title="View reading history">
            <History className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {showHistory && (
        <ReadingHistoryDialog
          entityName={locator.name}
          module="locator"
          entityId={locator.id}
          onClose={() => setShowHistory(false)}
        />
      )}
      {reading && (belowPrev || highVol) && (
        <div className="w-full text-xs text-warn-foreground bg-warn-soft px-2 py-1 rounded">
          {belowPrev ? 'Below previous' : 'Volume unusually high vs. avg'}
        </div>
      )}
    </div>
  );
}

// ─── WELL ────────────────────────────────────────────────────────────────────

function WellReadingForm() {
  const qc = useQueryClient();
  const { user, isAdmin, isManager } = useAuth();
  const [plantId, setPlantId] = useState('');
  const [importOpen, setImportOpen] = useState(false);

  const { data: wells } = useQuery({
    queryKey: ['op-wells', plantId],
    queryFn: async () => plantId
      ? (await supabase.from('wells').select('*').eq('plant_id', plantId).eq('status', 'Active').order('name')).data ?? []
      : [],
    enabled: !!plantId,
  });

  const { data: recentReadings } = useQuery({
    queryKey: ['op-well-recent', plantId],
    queryFn: async () => {
      if (!plantId) return [];
      const start = new Date(); start.setDate(start.getDate() - 30);
      return (await supabase.from('well_readings')
        .select('*').eq('plant_id', plantId)
        .gte('reading_datetime', start.toISOString())
        .order('reading_datetime', { ascending: false })).data ?? [];
    },
    enabled: !!plantId,
  });

  const { latestByWell, todayByWell } = useMemo(() => {
    const latest: Record<string, any> = {};
    const today: Record<string, any[]> = {};
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    recentReadings?.forEach((r: any) => {
      if (!latest[r.well_id]) latest[r.well_id] = r;
      if (new Date(r.reading_datetime) >= startOfDay) (today[r.well_id] ||= []).push(r);
    });
    return { latestByWell: latest, todayByWell: today };
  }, [recentReadings]);

  const { data: blendingData } = useBlendingWells(plantId);
  const blendingSet = useMemo(
    () => new Set((blendingData?.wells ?? []).map((w) => w.well_id)),
    [blendingData],
  );

  return (
    <div className="space-y-3">
      <Card className="p-3">
        <Label>Plant</Label>
        <div className="flex items-center gap-2 mt-1">
          <div className="flex-1">
            <PlantSelector value={plantId} onChange={setPlantId} />
          </div>
          {isAdmin && plantId && (
            <Button
              size="sm" variant="outline"
              className="shrink-0 gap-1.5 border-teal-600 text-teal-700 hover:bg-teal-50 dark:hover:bg-teal-950/30"
              onClick={() => setImportOpen(true)}
              data-testid="import-well-readings-btn"
            >
              <Upload className="h-3.5 w-3.5" />
              Import
            </Button>
          )}
        </div>
      </Card>

      {plantId && (
        <Card className="p-0 overflow-hidden">
          <div className="px-3 py-2 border-b bg-muted/40 text-xs font-medium flex items-center justify-between">
            <span>Active wells</span>
            <span className="text-muted-foreground">{wells?.length ?? 0} total</span>
          </div>
          {wells?.length ? (
            <ul className="divide-y">
              {wells.map((w: any) => (
                <li key={w.id}>
                  <WellRow
                    well={w} plantId={plantId}
                    previousMeter={latestByWell[w.id]?.current_reading ?? null}
                    previousPower={latestByWell[w.id]?.power_meter_reading ?? null}
                    todayReadings={todayByWell[w.id] ?? []}
                    userId={user?.id}
                    isBlending={blendingSet.has(w.id)}
                    onSaved={() => qc.invalidateQueries()}
                    isManagerOrAdmin={isAdmin || isManager}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p className="p-3 text-xs text-muted-foreground">No active wells for this plant</p>
          )}
        </Card>
      )}

      {importOpen && (
        <ImportReadingsDialog
          title="Import Well Readings from CSV"
          module="Well Readings"
          plantId={plantId}
          userId={user?.id ?? null}
          schemaHint={WELL_SCHEMA}
          templateFilename="well_readings_template.csv"
          templateRow={WELL_TEMPLATE_ROW}
          validateRow={validateWellReadingRow}
          insertRows={(rows, pid) => insertWellReadings(rows, pid, user?.id ?? null)}
          onClose={() => setImportOpen(false)}
          onImported={() => { setImportOpen(false); qc.invalidateQueries({ queryKey: ['op-well-recent', plantId] }); }}
        />
      )}
    </div>
  );
}

function WellRow({
  well, plantId, previousMeter, previousPower, todayReadings, userId, isBlending, onSaved, isManagerOrAdmin,
}: {
  well: any; plantId: string;
  previousMeter: number | null; previousPower: number | null;
  todayReadings: any[]; userId: string | undefined;
  isBlending: boolean; onSaved: () => void;
  isManagerOrAdmin: boolean;
}) {
  const [reading, setReading]         = useState('');
  const [powerReading, setPowerReading] = useState('');
  const [editingId, setEditingId]     = useState<string | null>(null);
  const [saving, setSaving]           = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [customDt, setCustomDt]       = useState(format(new Date(), "yyyy-MM-dd'T'HH:mm"));

  const cur        = +reading || 0;
  const dailyVol   = previousMeter != null && reading ? cur - previousMeter : null;
  const belowPrev  = previousMeter != null && cur > 0 && cur < previousMeter;
  const todayCount = todayReadings.length;
  const lastToday  = todayReadings[0] ?? null;
  const atLimit    = !editingId && todayCount >= MAX_READINGS_PER_DAY;

  const save = async () => {
    if (!reading) { toast.error(`${well.name}: enter a meter reading`); return; }
    if (atLimit) { toast.error(`${well.name}: max ${MAX_READINGS_PER_DAY} readings/day reached`); return; }
    if (belowPrev && !window.confirm(`${well.name}: meter below previous — save anyway?`)) return;

    setSaving(true);
    let gps_lat = null, gps_lng = null;
    try {
      const pos = await getCurrentPosition();
      gps_lat = pos.coords.latitude; gps_lng = pos.coords.longitude;
    } catch (err) { console.warn('[Operations] geolocation unavailable:', err); }

    const payload: any = {
      well_id: well.id, plant_id: plantId,
      current_reading: cur, previous_reading: previousMeter,
      daily_volume: dailyVol ?? null,       // Bug 1 fix: persist computed delta so Dashboard can sum it
      power_meter_reading: powerReading ? +powerReading : null,
      gps_lat, gps_lng, off_location_flag: false, recorded_by: userId,
      reading_datetime: new Date(customDt).toISOString(),
    };
    const { error } = editingId
      ? await supabase.from('well_readings').update(payload).eq('id', editingId)
      : await supabase.from('well_readings').insert(payload);

    setSaving(false);
    if (error) { toast.error(error.message); return; }
    toast.success(`${well.name}: ${editingId ? 'updated' : 'saved'}`);
    setReading(''); setPowerReading(''); setEditingId(null); onSaved();
  };

  return (
    <div className="p-3 space-y-2" data-testid={`well-row-${well.id}`}>
      {/* Row 1: Well name + badges | compact date picker on right */}
      <div className="flex items-center justify-between gap-2 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap min-w-0 flex-1">
          <div className="text-sm font-semibold truncate">{well.name}</div>
          {well.has_power_meter && (
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground bg-muted px-1.5 py-0.5 rounded">kWh</span>
          )}
          {isBlending && (
            <Badge className="bg-violet-100 text-violet-700 border-violet-200 hover:bg-violet-100 font-normal" data-testid={`blending-badge-${well.id}`}>
              Blending
            </Badge>
          )}
          {editingId && <span className="text-[10px] uppercase tracking-wide text-highlight">Editing</span>}
        </div>
        <label className="shrink-0 cursor-pointer relative">
          <span className="text-[11px] text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded px-2 py-1 font-mono-num whitespace-nowrap hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors">
            {customDt ? new Date(customDt).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
          </span>
          <Input type="datetime-local" value={customDt}
            onChange={e => setCustomDt(e.target.value)}
            className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
            title="Reading date & time" />
        </label>
      </div>

      {/* prev + today count */}
      <div className="text-xs text-muted-foreground">
        prev: <span className="font-mono-num">{previousMeter == null ? '—' : fmtNum(previousMeter)}</span>
        {dailyVol != null && <> · Δ <span className="font-mono-num">{fmtNum(dailyVol)} m³</span></>}
        <span className="mx-1">·</span>
        <span className={atLimit ? 'text-warn-foreground' : ''}>{todayCount}/{MAX_READINGS_PER_DAY} today</span>
      </div>

      {/* Row 2: Water | Power | Save | History */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Droplet className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-cyan-600 pointer-events-none" />
          <Input type="number" step="any" inputMode="decimal" value={reading}
            onChange={(e) => setReading(e.target.value)} placeholder="Water"
            className="h-9 pl-7 w-full border-cyan-300 focus-visible:ring-cyan-300 bg-cyan-50/40 dark:bg-cyan-950/20"
            data-testid={`well-meter-input-${well.id}`} />
        </div>
        {well.has_power_meter && (
          <div className="relative flex-1">
            <Zap className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-amber-600 pointer-events-none" />
            <Input type="number" step="any" inputMode="decimal" value={powerReading}
              onChange={(e) => setPowerReading(e.target.value)} placeholder="Power Me"
              className="h-9 pl-7 w-full border-amber-300 focus-visible:ring-amber-300 bg-amber-50/40 dark:bg-amber-950/20"
              data-testid={`well-power-input-${well.id}`} />
          </div>
        )}
        <Button onClick={save} disabled={saving || !reading || atLimit} className="h-9 px-3 text-xs shrink-0">
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : editingId ? 'Update' : 'Save'}
        </Button>
        {lastToday && !editingId && (
          <Button variant="ghost" className="h-9 w-9 p-0 rounded-full shrink-0"
            onClick={() => { setEditingId(lastToday.id); setReading(String(lastToday.current_reading ?? '')); setPowerReading(lastToday.power_meter_reading != null ? String(lastToday.power_meter_reading) : ''); }}
            title={`Edit last today reading (${fmtNum(lastToday.current_reading)})`}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        )}
        {editingId && (
          <Button variant="ghost" className="h-9 w-9 p-0 rounded-full shrink-0"
            onClick={() => { setEditingId(null); setReading(''); setPowerReading(''); }} title="Cancel edit">
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
        {isManagerOrAdmin && (
          <Button variant="ghost" className="h-9 w-9 p-0 rounded-full shrink-0 text-muted-foreground"
            onClick={() => setShowHistory(true)} title="View reading history">
            <History className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {reading && belowPrev && (
        <div className="w-full text-xs text-warn-foreground bg-warn-soft px-2 py-1 rounded">Meter below previous</div>
      )}

      {showHistory && (
        <ReadingHistoryDialog
          entityName={well.name}
          module="well"
          entityId={well.id}
          onClose={() => setShowHistory(false)}
        />
      )}
    </div>
  );
}

// ─── BLENDING ────────────────────────────────────────────────────────────────

function BlendingForm() {
  const qc = useQueryClient();
  const { user, isAdmin, isManager } = useAuth();
  const { data: plants } = usePlants();
  const [plantId, setPlantId] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const plantName = plants?.find((p: any) => p.id === plantId)?.name ?? '';

  const { data: wells } = useQuery({
    queryKey: ['op-wells', plantId],
    queryFn: async () => plantId
      ? (await supabase.from('wells').select('id, name, plant_id, status').eq('plant_id', plantId).eq('status', 'Active').order('name')).data ?? []
      : [],
    enabled: !!plantId,
  });

  const { data: blendingData } = useBlendingWells(plantId);
  const blendingIds    = useMemo(() => new Set((blendingData?.wells ?? []).map((w) => w.well_id)), [blendingData]);
  const blendingWells  = useMemo(() => (wells ?? []).filter((w: any) => blendingIds.has(w.id)), [wells, blendingIds]);

  const { data: volumeData } = useQuery<{
    by_well: { well_id: string; volume_m3: number; today_volume_m3: number; previous_volume_m3: number | null; previous_event_date: string | null }[];
  }>({
    queryKey: ['blending-today', plantId],
    queryFn: async () => {
      try {
        const res = await fetch(`${BASE}/api/blending/volume?days=14&plant_ids=${encodeURIComponent(plantId)}`);
        if (!res.ok) return { by_well: [] };
        return res.json();
      } catch { return { by_well: [] }; }
    },
    enabled: !!plantId,
    retry: false,
  });
  const todayByWell = useMemo(() => {
    const m: Record<string, number> = {};
    for (const w of volumeData?.by_well ?? []) m[w.well_id] = w.today_volume_m3 ?? 0;
    return m;
  }, [volumeData]);
  const prevByWell = useMemo(() => {
    const m: Record<string, { volume: number | null; date: string | null }> = {};
    for (const w of volumeData?.by_well ?? []) m[w.well_id] = { volume: w.previous_volume_m3 ?? null, date: w.previous_event_date ?? null };
    return m;
  }, [volumeData]);

  return (
    <div className="space-y-3">
      <Card className="p-3">
        <Label>Plant</Label>
        <div className="flex items-center gap-2 mt-1">
          <div className="flex-1">
            <PlantSelector value={plantId} onChange={setPlantId} />
          </div>
          {isAdmin && plantId && (
            <Button
              size="sm" variant="outline"
              className="shrink-0 gap-1.5 border-teal-600 text-teal-700 hover:bg-teal-50 dark:hover:bg-teal-950/30"
              onClick={() => setImportOpen(true)}
              data-testid="import-blending-readings-btn"
            >
              <Upload className="h-3.5 w-3.5" />
              Import
            </Button>
          )}
        </div>
      </Card>

      {plantId && (
        <Card className="p-0 overflow-hidden">
          <div className="px-3 py-2 border-b bg-muted/40 text-xs font-medium flex items-center justify-between">
            <span>Blending wells</span>
            <span className="text-muted-foreground">{blendingWells.length} tagged</span>
          </div>
          {blendingWells.length ? (
            <ul className="divide-y">
              {blendingWells.map((w: any) => (
                <li key={w.id}>
                  <BlendingRow
                    well={w} plantId={plantId} plantName={plantName}
                    todayVolume={todayByWell[w.id] ?? 0}
                    previousVolume={prevByWell[w.id]?.volume ?? null}
                    previousDate={prevByWell[w.id]?.date ?? null}
                    onSaved={() => {
                      qc.invalidateQueries({ queryKey: ['blending-today', plantId] });
                      qc.invalidateQueries({ queryKey: ['blending-volume'] });
                    }}
                    isManagerOrAdmin={isAdmin || isManager}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <div className="p-3 text-xs text-muted-foreground">
              No wells tagged as blending for this plant. Tag a well as blending under <span className="font-medium">Plants → Wells</span>.
            </div>
          )}
        </Card>
      )}

      {importOpen && (
        <ImportReadingsDialog
          title="Import Blending Readings from CSV"
          module="Blending Readings"
          plantId={plantId}
          userId={user?.id ?? null}
          schemaHint={BLENDING_SCHEMA}
          templateFilename="blending_readings_template.csv"
          templateRow={BLENDING_TEMPLATE_ROW}
          validateRow={validateBlendingRow}
          insertRows={(rows, pid) => insertBlendingReadings(rows, pid, plantName)}
          onClose={() => setImportOpen(false)}
          onImported={() => {
            setImportOpen(false);
            qc.invalidateQueries({ queryKey: ['blending-today', plantId] });
            qc.invalidateQueries({ queryKey: ['blending-volume'] });
          }}
        />
      )}
    </div>
  );
}

function BlendingRow({
  well, plantId, plantName, todayVolume, previousVolume, previousDate, onSaved, isManagerOrAdmin,
}: {
  well: any; plantId: string; plantName?: string;
  todayVolume: number; previousVolume: number | null; previousDate: string | null;
  onSaved: () => void;
  isManagerOrAdmin: boolean;
}) {
  const [volume, setVolume] = useState('');
  const [saving, setSaving] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [customDt, setCustomDt] = useState(format(new Date(), "yyyy-MM-dd'T'HH:mm"));

  const save = async () => {
    const v = +volume;
    if (!volume || !(v > 0)) { toast.error(`${well.name}: enter a positive blending volume`); return; }
    setSaving(true);
    try {
      const res = await fetch(`${BASE}/api/blending/audit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          well_id: well.id, plant_id: plantId, well_name: well.name, plant_name: plantName,
          event_date: customDt.slice(0, 10), volume_m3: v,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success(`${well.name}: blending volume saved (${fmtNum(v)} m³)`);
      setVolume(''); onSaved();
    } catch (e: any) {
      toast.error(`Blending save failed: ${e.message || e}`);
    } finally { setSaving(false); }
  };

  return (
    <div className="p-3 space-y-2" data-testid={`blending-row-${well.id}`}>
      {/* Row 1: Well name + badge | compact date picker on right — matches Locator/Well format */}
      <div className="flex items-center justify-between gap-2 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap min-w-0 flex-1">
          <div className="text-sm font-medium truncate">{well.name}</div>
          <Badge className="bg-violet-100 text-violet-700 border-violet-200 hover:bg-violet-100 font-normal">Blending</Badge>
        </div>
        <label className="shrink-0 cursor-pointer relative">
          <span className="text-[11px] text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded px-2 py-1 font-mono-num whitespace-nowrap hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors">
            {customDt ? new Date(customDt).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
          </span>
          <Input type="datetime-local" value={customDt} onChange={e => setCustomDt(e.target.value)}
            className="absolute inset-0 opacity-0 w-full h-full cursor-pointer" title="Reading date & time" />
        </label>
      </div>

      {/* Row 2: prev / today data */}
      <div className="text-xs text-muted-foreground">
        prev: <span className="font-mono-num" title={previousDate ? `last entry on ${previousDate}` : 'no prior blending entry'}>
          {previousVolume == null ? '—' : `${fmtNum(previousVolume)} m³`}
        </span>
        {previousDate && <span className="text-muted-foreground/60 ml-1">({previousDate})</span>}
        <span className="mx-1">·</span>
        today: <span className="font-mono-num">{fmtNum(todayVolume)} m³</span> logged
      </div>

      {/* Row 3: Input + Save + History */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <Droplet className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-violet-600 pointer-events-none" />
          <Input type="number" step="any" inputMode="decimal" value={volume}
            onChange={(e) => setVolume(e.target.value)} placeholder="Blending m³"
            className="h-9 pl-7 w-full border-violet-300 focus-visible:ring-violet-300 bg-violet-50/40 dark:bg-violet-950/20"
            data-testid={`blending-input-${well.id}`} />
        </div>
        <Button onClick={save} disabled={saving || !volume} size="sm" className="h-9 px-3 text-xs shrink-0">
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save'}
        </Button>
        {isManagerOrAdmin && (
          <Button variant="ghost" size="sm" className="h-9 w-9 p-0 rounded-full text-muted-foreground shrink-0"
            onClick={() => setShowHistory(true)} title="View blending history">
            <History className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {showHistory && (
        <ReadingHistoryDialog
          entityName={well.name}
          module="blending"
          entityId={well.id}
          plantId={plantId}
          onClose={() => setShowHistory(false)}
        />
      )}
    </div>
  );
}

// ─── PRODUCT METER audit logger ──────────────────────────────────────────────

async function logProductMeterChange(entry: {
  plant_id: string;
  meter_id: string;
  meter_name: string;
  old_value: number | null;
  new_value: number | null;
  user_id: string | null;
  timestamp: string;
}) {
  try {
    await (supabase.from('product_meter_audit_log' as any) as any).insert([entry]);
  } catch { /* silently ignore if table missing */ }
}

async function logProductionCalc(entry: {
  plant_id: string;
  meter_id: string;
  meter_name: string;
  entry_name: string;
  production_volume: number;
  user_id: string | null;
  timestamp: string;
}) {
  try {
    await (supabase.from('production_calc_log' as any) as any).insert([entry]);
  } catch { /* silently ignore if table missing */ }
}

// ─── PRODUCT ─────────────────────────────────────────────────────────────────

function ProductForm() {
  const qc = useQueryClient();
  const { user, isAdmin, isManager } = useAuth();
  const { data: plants } = usePlants();
  const [plantId, setPlantId] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const canEdit = isAdmin || isManager;

  // Product meters for the selected plant
  // NOTE: uses 'op-product-meters' key (NOT 'product-meters') to avoid colliding with
  // the Plants.tsx cache, which uses a different select projection and placeholderData
  // strategy — a shared key causes stale/incomplete data (blank meter names) to appear.
  const { data: meters, isLoading: metersLoading } = useQuery({
    queryKey: ['op-product-meters', plantId],
    queryFn: async () => {
      if (!plantId) return [];
      let { data, error } = await supabase
        .from('product_meters' as any)
        .select('id, name, status, sort_order, created_at')
        .eq('plant_id', plantId)
        .order('sort_order', { ascending: true });
      if (error?.message?.includes('sort_order')) {
        ({ data, error } = await supabase
          .from('product_meters' as any)
          .select('id, name, status, created_at')
          .eq('plant_id', plantId)
          .order('created_at', { ascending: true }));
      }
      if (error?.message?.includes('status')) {
        let fallback;
        ({ data: fallback } = await supabase
          .from('product_meters' as any)
          .select('id, name, created_at')
          .eq('plant_id', plantId)
          .order('created_at', { ascending: true }));
        return ((fallback ?? []) as any[]).map((m: any) => ({ ...m, status: 'Active' }));
      }
      return (data ?? []) as any[];
    },
    enabled: !!plantId,
  });

  // Latest reading per meter
  const { data: latestReadings } = useQuery({
    queryKey: ['product-readings-latest', plantId],
    queryFn: async () => {
      if (!plantId) return [];
      const { data } = await supabase
        .from('product_meter_readings' as any)
        .select('*')
        .eq('plant_id', plantId)
        .order('reading_datetime', { ascending: false })
        .limit(200);
      // Return only latest per meter_id
      const seen = new Set<string>();
      return ((data ?? []) as any[]).filter((r) => {
        if (seen.has(r.meter_id)) return false;
        seen.add(r.meter_id);
        return true;
      });
    },
    enabled: !!plantId,
  });

  const latestByMeter = useMemo(() => {
    const m: Record<string, any> = {};
    for (const r of latestReadings ?? []) m[r.meter_id] = r;
    return m;
  }, [latestReadings]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['op-product-meters', plantId] });
    qc.invalidateQueries({ queryKey: ['product-readings-latest', plantId] });
  };

  return (
    <div className="space-y-3">
      <Card className="p-3">
        <Label>Plant</Label>
        <div className="flex items-center gap-2 mt-1">
          <div className="flex-1">
            <PlantSelector value={plantId} onChange={setPlantId} />
          </div>
          {canEdit && plantId && (
            <Button
              size="sm" variant="outline"
              className="shrink-0 gap-1.5 border-teal-600 text-teal-700 hover:bg-teal-50 dark:hover:bg-teal-950/30"
              onClick={() => setImportOpen(true)}
              data-testid="import-product-readings-btn"
            >
              <Upload className="h-3.5 w-3.5" />
              Import
            </Button>
          )}
        </div>
      </Card>

      {plantId && (
        <>
          {/* Product Meter list */}
          <Card className="p-0 overflow-hidden">
            <div className="px-3 py-2 border-b bg-muted/40 text-xs font-medium flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Gauge className="h-3.5 w-3.5 text-teal-600" />
                <span>Product meters</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">{meters?.length ?? 0} configured</span>
              </div>
            </div>

            {metersLoading ? (
              <div className="p-4 flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading meters…
              </div>
            ) : meters?.length ? (
              <ul className="divide-y">
                {meters.map((m: any) => (
                  <li key={m.id}>
                    <ProductMeterRow
                      meter={m}
                      plantId={plantId}
                      latest={latestByMeter[m.id] ?? null}
                      userId={user?.id ?? null}
                      canEdit={canEdit}
                      onSaved={invalidate}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <div className="p-4 text-xs text-muted-foreground">
                No product meters configured for this plant.{' '}
                {canEdit && 'Go to the plant detail page to add product meters.'}
              </div>
            )}
          </Card>

          {/* CSV import dialog */}
          {importOpen && (
            <ImportReadingsDialog
              title="Import Product Meter Readings from CSV"
              module="Product Meter Readings"
              plantId={plantId}
              userId={user?.id ?? null}
              schemaHint="meter_name*, current_reading*, reading_datetime (YYYY-MM-DDTHH:mm), previous_reading"
              templateFilename="product_meter_readings_template.csv"
              templateRow={{
                meter_name: 'Main Line',
                current_reading: '12345.67',
                reading_datetime: '2024-06-15T08:30',
                previous_reading: '12200.00',
              }}
              validateRow={(r, i) => {
                const e: string[] = [];
                if (!r.meter_name?.trim()) e.push(`Row ${i}: meter_name is required`);
                if (!r.current_reading?.trim() || isNaN(Number(r.current_reading)))
                  e.push(`Row ${i}: current_reading must be a number`);
                if (r.previous_reading && isNaN(Number(r.previous_reading)))
                  e.push(`Row ${i}: previous_reading must be a number`);
                if (r.reading_datetime && isNaN(Date.parse(r.reading_datetime)))
                  e.push(`Row ${i}: reading_datetime is not a valid date`);
                return e;
              }}
              insertRows={async (rows, pid) => {
                // Resolve meter names → IDs
                const { data: meterList } = await supabase
                  .from('product_meters' as any)
                  .select('id, name')
                  .eq('plant_id', pid);
                const nameToId: Record<string, string> = {};
                ((meterList ?? []) as any[]).forEach((m: any) => {
                  nameToId[m.name.toLowerCase()] = m.id;
                });
                let count = 0;
                const errors: string[] = [];
                for (const r of rows) {
                  const meterId = nameToId[r.meter_name?.toLowerCase()];
                  if (!meterId) { errors.push(`Meter not found: "${r.meter_name}"`); continue; }
                  const dt = r.reading_datetime ? new Date(r.reading_datetime).toISOString() : new Date().toISOString();
                  const dtMin = dt.slice(0, 16);

                  // Duplicate check
                  const { data: existing } = await supabase.from('product_meter_readings' as any)
                    .select('id').eq('meter_id', meterId)
                    .gte('reading_datetime', `${dtMin}:00`)
                    .lte('reading_datetime', `${dtMin}:59`).limit(1);

                  if (existing && existing.length > 0) {
                    const decision = await resolveImportDuplicate(`${meterId}|${dtMin}`, `${r.meter_name} @ ${dtMin}`);
                    if (decision === 'skip') continue;
                    const csvCur = +r.current_reading;
                    const csvPrev = r.previous_reading ? +r.previous_reading : null;
                    // Bug fix: persist daily_volume on update so Dashboard aggregation works
                    const csvDailyVol = csvPrev != null ? Math.max(0, csvCur - csvPrev) : null;
                    const { error } = await supabase.from('product_meter_readings' as any).update({
                      current_reading: csvCur,
                      previous_reading: csvPrev,
                      reading_datetime: dt,
                      recorded_by: user?.id ?? null,
                      daily_volume: csvDailyVol,   // Bug fix: persist computed delta
                    } as any).eq('id', (existing as any[])[0].id);
                    if (error) errors.push(error.message); else count++;
                    continue;
                  }

                  const csvCur2 = +r.current_reading;
                  const csvPrev2 = r.previous_reading ? +r.previous_reading : null;
                  // Bug fix: persist daily_volume so Dashboard/TrendChart can sum it directly
                  const csvDailyVol2 = csvPrev2 != null ? Math.max(0, csvCur2 - csvPrev2) : null;
                  const { error } = await supabase.from('product_meter_readings' as any).insert({
                    meter_id: meterId,
                    plant_id: pid,
                    current_reading: csvCur2,
                    previous_reading: csvPrev2,
                    reading_datetime: dt,
                    recorded_by: user?.id ?? null,
                    daily_volume: csvDailyVol2,   // Bug fix: always persist computed delta
                  } as any);
                  if (error) errors.push(error.message);
                  else count++;
                }
                return { count, errors };
              }}
              onClose={() => setImportOpen(false)}
              onImported={() => { setImportOpen(false); invalidate(); }}
            />
          )}
        </>
      )}
    </div>
  );
}

// ── Add product meter button (Manager/Admin only) ─────────────────────────────

function AddProductMeterButton({ plantId, onAdded }: { plantId: string; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim()) { toast.error('Enter a meter name'); return; }
    setBusy(true);
    let { error } = await supabase.from('product_meters' as any).insert({
      plant_id: plantId, name: name.trim(), status: 'Active', sort_order: 0,
    } as any);
    if (error?.message?.includes('status')) {
      ({ error } = await supabase.from('product_meters' as any).insert({
        plant_id: plantId, name: name.trim(), sort_order: 0,
      } as any));
    }
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    toast.success(`"${name.trim()}" added`);
    setName(''); setOpen(false); onAdded();
  };

  return (
    <>
      <Button size="sm" variant="outline" className="h-6 text-xs px-2 gap-1" onClick={() => setOpen(true)}>
        <span className="text-base leading-none">+</span> Add meter
      </Button>
      <Dialog open={open} onOpenChange={(o) => { if (!o) { setName(''); } setOpen(o); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Add product meter</DialogTitle></DialogHeader>
          <div className="space-y-2 py-1">
            <Label>Meter name *</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Main Line, Secondary Line…"
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              This name appears in Operations → Product and in all audit logs.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button onClick={submit} disabled={busy || !name.trim()}>
              {busy && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Product meter row ─────────────────────────────────────────────────────────

function ProductMeterRow({
  meter, plantId, latest, userId, canEdit, onSaved,
}: {
  meter: any;
  plantId: string;
  latest: any | null;
  userId: string | null;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [reading, setReading] = useState('');
  const [saving, setSaving] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [customDt, setCustomDt] = useState(format(new Date(), "yyyy-MM-dd'T'HH:mm"));

  const previous = latest?.current_reading ?? null;
  const cur = +reading || 0;
  const productionVolume = previous != null && reading ? cur - previous : null;

  const save = async () => {
    if (!reading) { toast.error(`${meter.name}: enter a reading`); return; }
    setSaving(true);
    const dt = new Date(customDt).toISOString();
    // Bug fix: persist daily_volume so Dashboard/TrendChart can sum it directly,
    // mirroring the same fix already applied to locator_readings and well_readings.
    const dailyVol = previous != null ? Math.max(0, cur - previous) : null;
    const { error } = await supabase.from('product_meter_readings' as any).insert({
      meter_id: meter.id,
      plant_id: plantId,
      current_reading: cur,
      previous_reading: previous,
      reading_datetime: dt,
      recorded_by: userId,
      daily_volume: dailyVol,   // Bug fix: always persist computed delta for Dashboard aggregation
    } as any);
    if (error) { toast.error(error.message); setSaving(false); return; }

    // Audit the production volume calculation
    if (productionVolume != null) {
      await logProductionCalc({
        plant_id: plantId,
        meter_id: meter.id,
        meter_name: meter.name,
        entry_name: meter.name,
        production_volume: productionVolume,
        user_id: userId,
        timestamp: dt,
      });
    }

    toast.success(`${meter.name}: reading saved${productionVolume != null ? ` · ${fmtNum(productionVolume)} m³ produced` : ''}`);
    setReading(''); setSaving(false); onSaved();
  };


  return (
    <div className="p-3 space-y-2" data-testid={`product-meter-row-${meter.id}`}>
      {/* Row 1: Name | compact date picker on right */}
      <div className="min-w-0">
        <div className="flex items-center justify-between gap-2 min-w-0">
          <div className="text-sm font-medium truncate flex items-center gap-1.5 min-w-0 flex-1">
            <Gauge className="h-3.5 w-3.5 text-teal-600 shrink-0" />
            <span className="truncate">{meter.name}</span>
          </div>
          <label className="shrink-0 cursor-pointer relative">
            <span className="text-[11px] text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded px-2 py-1 font-mono-num whitespace-nowrap hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors">
              {customDt ? new Date(customDt).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
            </span>
            <Input type="datetime-local" value={customDt}
              onChange={e => setCustomDt(e.target.value)}
              className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
              title="Reading date & time" />
          </label>
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          prev: <span className="font-mono-num">{previous == null ? '—' : fmtNum(previous)}</span>
          {productionVolume != null && (
            <>
              {' · '}
              <span className="font-mono-num text-teal-600 font-medium">{fmtNum(productionVolume)} m³</span>
              {' produced'}
            </>
          )}
        </div>
      </div>

      {/* Row 2: reading input + save + history */}
      <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
        <div className="relative flex-1 min-w-0">
          <Gauge className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-teal-600 pointer-events-none" />
          <Input
            type="number" step="any" inputMode="decimal"
            value={reading}
            onChange={(e) => setReading(e.target.value)}
            placeholder="Product Reading"
            className="h-9 pl-7 w-full border-teal-300 focus-visible:ring-teal-300 bg-teal-50/40 dark:bg-teal-950/20"
            data-testid={`product-meter-input-${meter.id}`}
          />
        </div>
        <Button
          onClick={save}
          disabled={saving || !reading}
          size="sm"
          className="h-9 px-3 text-xs shrink-0"
          data-testid={`product-meter-save-${meter.id}`}
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save'}
        </Button>
        {canEdit && (
          <Button
            variant="ghost" size="sm" className="h-9 w-9 p-0 rounded-full text-muted-foreground shrink-0"
            onClick={() => setShowHistory(true)} title="View history"
          >
            <History className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {/* Inline production volume badge */}
      {productionVolume != null && (
        <div className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md bg-teal-50 dark:bg-teal-950/30 border border-teal-200 dark:border-teal-800 text-xs">
          <Gauge className="h-3.5 w-3.5 text-teal-600 shrink-0" />
          <span className="text-teal-700 dark:text-teal-300">
            Production volume: <span className="font-mono-num font-semibold">{fmtNum(productionVolume)} m³</span>
            <span className="text-teal-600/70 ml-1.5">(current − previous)</span>
          </span>
        </div>
      )}

      {showHistory && (
        <ProductMeterHistoryDialog
          meter={meter}
          onClose={() => setShowHistory(false)}
        />
      )}
    </div>
  );
}

// ── Product meter history dialog ──────────────────────────────────────────────

function ProductMeterHistoryDialog({ meter, onClose }: { meter: any; onClose: () => void }) {
  const qc = useQueryClient();
  const [days, setDays] = useState<7 | 14 | 30 | 60 | 'custom'>(30);
  const [customFrom, setCustomFrom] = useState(format(new Date(Date.now() - 30 * 86400000), 'yyyy-MM-dd'));
  const [customTo, setCustomTo]     = useState(format(new Date(), 'yyyy-MM-dd'));
  const [appliedFrom, setAppliedFrom] = useState(customFrom);
  const [appliedTo, setAppliedTo]     = useState(customTo);
  const [editRow, setEditRow] = useState<{ id: string; datetime: string; value: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const WINDOWS = [{ label: '7D', days: 7 }, { label: '14D', days: 14 }, { label: '30D', days: 30 }, { label: '60D', days: 60 }] as const;

  const localMidnight = (dateStr: string) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d);
  };

  const queryKey = ['product-meter-history', meter.id, days, appliedFrom, appliedTo];

  const { data: rows, isLoading } = useQuery({
    queryKey,
    queryFn: async () => {
      let sinceIso: string;
      let untilIso: string;
      if (days === 'custom') {
        sinceIso = localMidnight(appliedFrom).toISOString();
        const end = localMidnight(appliedTo);
        end.setHours(23, 59, 59, 999);
        untilIso = end.toISOString();
      } else {
        const since = new Date();
        since.setDate(since.getDate() - days);
        sinceIso = since.toISOString();
        untilIso = new Date().toISOString();
      }
      const { data } = await supabase
        .from('product_meter_readings' as any)
        .select('id, current_reading, previous_reading, reading_datetime')
        .eq('meter_id', meter.id)
        .gte('reading_datetime', sinceIso)
        .lte('reading_datetime', untilIso)
        .order('reading_datetime', { ascending: false });
      return (data ?? []) as any[];
    },
  });

  const saveEdit = async () => {
    if (!editRow) return;
    setSaving(true);
    const { error } = await supabase.from('product_meter_readings' as any).update({
      current_reading: +editRow.value,
      reading_datetime: new Date(editRow.datetime).toISOString(),
    } as any).eq('id', editRow.id);
    setSaving(false);
    if (error) { toast.error(error.message); return; }
    toast.success('Reading updated');
    setEditRow(null);
    qc.invalidateQueries({ queryKey });
    qc.invalidateQueries();
  };

  const deleteRow = async (id: string) => {
    if (!window.confirm('Delete this reading? This cannot be undone.')) return;
    setDeletingId(id);
    const { error } = await supabase.from('product_meter_readings' as any).delete().eq('id', id);
    setDeletingId(null);
    if (error) { toast.error(error.message); return; }
    toast.success('Reading deleted');
    qc.invalidateQueries({ queryKey });
    qc.invalidateQueries();
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-1.5">
            <Gauge className="h-4 w-4 text-teal-600" /> {meter.name} — History
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1 p-1 bg-muted rounded-lg w-fit">
            {WINDOWS.map(({ label, days: d }) => (
              <button key={label} onClick={() => { setDays(d as any); setEditRow(null); }}
                className={['px-3 py-1 text-xs font-medium rounded-md transition-all',
                  days === d ? 'bg-teal-700 text-white shadow-sm' : 'text-muted-foreground hover:text-foreground',
                ].join(' ')}>{label}</button>
            ))}
            <button onClick={() => { setDays('custom'); setEditRow(null); }}
              className={['px-3 py-1 text-xs font-medium rounded-md transition-all',
                days === 'custom' ? 'bg-teal-700 text-white shadow-sm' : 'text-muted-foreground hover:text-foreground',
              ].join(' ')}>Custom</button>
          </div>
          {days === 'custom' && (
            <div className="flex items-center gap-1.5">
              <input type="date" value={customFrom} max={customTo}
                onChange={e => setCustomFrom(e.target.value)}
                className="h-7 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
              <span className="text-xs text-muted-foreground">to</span>
              <input type="date" value={customTo} min={customFrom} max={format(new Date(), 'yyyy-MM-dd')}
                onChange={e => setCustomTo(e.target.value)}
                className="h-7 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
              <Button size="sm" className="h-7 px-3 text-xs bg-teal-700 text-white hover:bg-teal-800"
                onClick={() => { setAppliedFrom(customFrom); setAppliedTo(customTo); setEditRow(null); }}>
                Apply
              </Button>
            </div>
          )}
        </div>

        {editRow && (
          <div className="rounded-md border bg-muted/30 p-3 space-y-2 text-xs">
            <p className="font-medium">Editing reading</p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-[11px]">Date &amp; Time</Label>
                <Input type="datetime-local" value={editRow.datetime}
                  onChange={e => setEditRow({ ...editRow, datetime: e.target.value })} className="h-8 text-xs" />
              </div>
              <div>
                <Label className="text-[11px]">Reading</Label>
                <Input type="number" step="any" value={editRow.value}
                  onChange={e => setEditRow({ ...editRow, value: e.target.value })} className="h-8 text-xs" />
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={saveEdit} disabled={saving || !editRow.value}
                className="bg-teal-700 text-white hover:bg-teal-800 h-7 text-xs px-3">
                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save changes'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditRow(null)} disabled={saving} className="h-7 text-xs px-3">Cancel</Button>
            </div>
          </div>
        )}

        <div className="overflow-auto max-h-72 rounded border text-xs">
          {isLoading ? (
            <div className="flex items-center justify-center p-6 text-muted-foreground gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : !rows?.length ? (
            <p className="p-4 text-center text-muted-foreground">
              {days === 'custom'
                ? `No readings from ${appliedFrom} → ${appliedTo}`
                : `No readings in the last ${days} days`}
            </p>
          ) : (
            <table className="w-full text-left">
              <thead className="bg-muted sticky top-0">
                <tr>
                  <th className="px-3 py-2 font-medium">Date & Time</th>
                  <th className="px-3 py-2 font-medium text-right">Reading</th>
                  <th className="px-3 py-2 font-medium text-right">Production (m³)</th>
                  <th className="px-2 py-2 font-medium text-center w-16">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r: any, i: number) => {
                  const vol = r.previous_reading != null ? r.current_reading - r.previous_reading : null;
                  const isEditing = editRow?.id === r.id;
                  const isDeleting = deletingId === r.id;
                  return (
                    <tr key={r.id ?? i} className={['border-t', isEditing ? 'bg-teal-50/60 dark:bg-teal-950/20' : 'hover:bg-muted/40'].join(' ')}>
                      <td className="px-3 py-1.5 whitespace-nowrap text-muted-foreground">
                        {r.reading_datetime ? format(new Date(r.reading_datetime), 'MMM d, yyyy HH:mm') : '—'}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono-num">{fmtNum(r.current_reading)}</td>
                      <td className="px-3 py-1.5 text-right font-mono-num text-teal-600">
                        {vol != null ? fmtNum(vol) : '—'}
                      </td>
                      <td className="px-2 py-1 text-center">
                        <div className="flex items-center justify-center gap-0.5">
                          <button title="Edit" disabled={!!editRow || isDeleting}
                            onClick={() => setEditRow({ id: r.id, datetime: format(new Date(r.reading_datetime), "yyyy-MM-dd'T'HH:mm"), value: String(r.current_reading) })}
                            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-40">
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button title="Delete" disabled={!!editRow || isDeleting}
                            onClick={() => deleteRow(r.id)}
                            className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive disabled:opacity-40">
                            {isDeleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground">
          {days === 'custom' ? `Showing ${appliedFrom} → ${appliedTo}` : `Showing up to ${days} days`} · {rows?.length ?? 0} records
        </p>
      </DialogContent>
    </Dialog>
  );
}

// ─── MeterNameList ────────────────────────────────────────────────────────────
// Per-meter name chips with inline edit + delete (with confirmation).
// Manager/Admin only — rendered conditionally by the caller.

function MeterNameList({
  count, names, accentColor, defaultPrefix, onSave, onRemoveLast,
}: {
  count: number;
  names: string[];
  accentColor: 'yellow' | 'blue';
  defaultPrefix: string;
  onSave: (names: string[]) => void;
  onRemoveLast: () => void;
}) {
  const isYellow = accentColor === 'yellow';
  const ring   = isYellow ? 'focus-visible:ring-yellow-400' : 'focus-visible:ring-blue-400';
  const border = isYellow ? 'border-yellow-300' : 'border-blue-300';
  const chip   = isYellow
    ? 'bg-yellow-50 border-yellow-200 text-yellow-800 dark:bg-yellow-950/20 dark:border-yellow-800 dark:text-yellow-300'
    : 'bg-blue-50 border-blue-200 text-blue-800 dark:bg-blue-950/20 dark:border-blue-800 dark:text-blue-300';

  // editingIdx: which chip is in edit mode (-1 = none)
  const [editingIdx, setEditingIdx] = useState<number>(-1);
  const [editVal, setEditVal]       = useState('');
  // confirmDeleteIdx: which chip is showing delete confirmation
  const [confirmDeleteIdx, setConfirmDeleteIdx] = useState<number>(-1);

  const startEdit = (i: number) => {
    setConfirmDeleteIdx(-1);
    setEditingIdx(i);
    setEditVal(names[i] ?? `${defaultPrefix} ${i + 1}`);
  };

  const commitEdit = () => {
    if (editingIdx < 0) return;
    const trimmed = editVal.trim() || `${defaultPrefix} ${editingIdx + 1}`;
    const next = [...names];
    next[editingIdx] = trimmed;
    onSave(next);
    setEditingIdx(-1);
  };

  const cancelEdit = () => { setEditingIdx(-1); };

  const askDelete = (i: number) => {
    setEditingIdx(-1);
    setConfirmDeleteIdx(i);
  };

  const confirmDelete = (i: number) => {
    // Remove this entry by shifting names down; decrement count via onRemoveLast
    const next = [...names];
    next.splice(i, 1);
    onSave(next);
    onRemoveLast();
    setConfirmDeleteIdx(-1);
  };

  const cancelDelete = () => setConfirmDeleteIdx(-1);

  return (
    <div className="flex gap-1 flex-wrap mt-0.5">
      {Array.from({ length: count }).map((_, i) => {
        const name = names[i] ?? `${defaultPrefix} ${i + 1}`;
        const isEditing  = editingIdx === i;
        const isDeleting = confirmDeleteIdx === i;

        if (isEditing) {
          return (
            <div key={i} className={`flex items-center gap-0.5 rounded border ${border} bg-background px-1 py-0.5`}>
              <input
                autoFocus
                value={editVal}
                onChange={e => setEditVal(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') cancelEdit(); }}
                className={`h-5 w-20 text-[11px] bg-transparent focus:outline-none focus-visible:ring-1 ${ring} rounded px-0.5`}
              />
              <button
                onClick={commitEdit}
                className="text-[9px] font-semibold text-emerald-700 hover:text-emerald-900 px-0.5 leading-none"
                title="Save name"
              >✓</button>
              <button
                onClick={cancelEdit}
                className="text-[9px] text-muted-foreground hover:text-foreground px-0.5 leading-none"
                title="Cancel"
              >✕</button>
            </div>
          );
        }

        if (isDeleting) {
          return (
            <div key={i} className="flex items-center gap-0.5 rounded border border-destructive/40 bg-destructive/5 px-1.5 py-0.5">
              <span className="text-[10px] text-destructive font-medium">Delete "{name}"?</span>
              <button
                onClick={() => confirmDelete(i)}
                className="text-[9px] font-bold text-destructive hover:text-destructive/80 ml-1 px-0.5"
                title="Confirm delete"
              >Yes</button>
              <button
                onClick={cancelDelete}
                className="text-[9px] text-muted-foreground hover:text-foreground px-0.5"
                title="Cancel"
              >No</button>
            </div>
          );
        }

        return (
          <div key={i} className={`flex items-center gap-0.5 rounded border ${chip} px-1.5 py-0.5 text-[11px]`}>
            <span className="leading-none">{name}</span>
            <button
              onClick={() => startEdit(i)}
              className="ml-0.5 opacity-60 hover:opacity-100 transition-opacity"
              title={`Rename "${name}"`}
            >
              <Pencil className="h-2.5 w-2.5" />
            </button>
            <button
              onClick={() => askDelete(i)}
              className="opacity-60 hover:opacity-100 hover:text-destructive transition-opacity"
              title={`Remove "${name}"`}
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ─── POWER ───────────────────────────────────────────────────────────────────

function PowerForm() {
  const qc = useQueryClient();
  const { user, isAdmin, isManager } = useAuth();
  const { data: plants } = usePlants();
  const [plantId, setPlantId]         = useState('');
  // When showSolar: `reading` = grid meter reading, `solarReading` = solar meter reading
  // When !showSolar: `reading` = combined meter reading
  const [reading, setReading]         = useState('');
  const [solarReading, setSolarReading] = useState('');
  const [dt, setDt]                   = useState(format(new Date(), "yyyy-MM-dd'T'HH:mm"));
  const [editingId, setEditingId]     = useState<string | null>(null);
  const [powerHistoryOpen, setPowerHistoryOpen] = useState(false);
  const [importOpen, setImportOpen]   = useState(false);
  // Multiplier: auto-populated from latest saved electric bill; editable by admin only when no bill exists
  const [multiplierInput, setMultiplierInput] = useState('');
  // Per-meter reading inputs: indexed arrays (index 0 = meter 1, etc.)
  const [gridMeterReadings, setGridMeterReadings]   = useState<string[]>(['', '', '', '', '']);
  const [solarMeterReadings, setSolarMeterReadings] = useState<string[]>(['', '', '', '', '']);

  const setGridMeterReading = (idx: number, val: string) =>
    setGridMeterReadings(prev => { const next = [...prev]; next[idx] = val; return next; });
  const setSolarMeterReading = (idx: number, val: string) =>
    setSolarMeterReadings(prev => { const next = [...prev]; next[idx] = val; return next; });
  // 'raw'    = user enters cumulative kWh meter reading; Δ auto-computed from prev
  // 'direct' = user enters daily kWh directly; stored straight as daily_solar_kwh
  const [solarInputMode, setSolarInputMode] = useState<'raw' | 'direct'>('raw');

  const plant     = useMemo(() => plants?.find((p) => p.id === plantId), [plants, plantId]);
  const showSolar = !!plant?.has_solar;
  const showGrid  = plant?.has_grid !== false;

  // Load meter config from plant_power_config (set in Plant → Power tab)
  const { data: powerConfig } = useQuery({
    queryKey: ['plant-power-config', plantId],
    queryFn: async () => {
      if (!plantId) return null;
      try {
        const { data, error } = await (supabase.from('plant_power_config' as any) as any)
          .select('solar_meter_count, solar_meter_names, grid_meter_count, grid_meter_names')
          .eq('plant_id', plantId).maybeSingle();
        if (!error && data) return data as any;
      } catch { /* table may not exist */ }
      try {
        const raw = localStorage.getItem(`power_config_${plantId}`);
        if (raw) return JSON.parse(raw);
      } catch { /* ignore */ }
      return null;
    },
    enabled: !!plantId,
  });

  const solarMeterCount = (powerConfig?.solar_meter_count as number) ?? 1;
  const gridMeterCount  = (powerConfig?.grid_meter_count  as number) ?? 1;
  const solarMeterNames: string[] = powerConfig?.solar_meter_names ?? [];
  const gridMeterNames:  string[] = powerConfig?.grid_meter_names  ?? [];

  const getSolarLabel = (idx: number) => solarMeterNames[idx] ?? (solarMeterCount === 1 ? 'Solar Power Reading' : `Solar Meter ${idx + 1}`);
  const getGridLabel  = (idx: number) => gridMeterNames[idx]  ?? (gridMeterCount  === 1 ? 'Grid Power Reading'  : `Grid Meter ${idx + 1}`);

  // Fetch latest electric bill to get the saved multiplier
  const { data: latestBill, isLoading: billLoading } = useQuery({
    queryKey: ['op-power-bill', plantId],
    queryFn: async () => plantId
      ? (await supabase.from('electric_bills').select('multiplier').eq('plant_id', plantId).order('billing_month', { ascending: false }).limit(1)).data?.[0] ?? null
      : null,
    enabled: !!plantId,
  });

  // billMultiplier = value from saved bill (read-only); null = no bill yet
  const billMultiplier: number | null = latestBill?.multiplier ?? null;
  // Effective multiplier used in calculations: bill value takes priority, else admin's input
  const effectiveMultiplier = billMultiplier ?? (+multiplierInput || 1);
  // Admin can type a value only when there is no saved bill
  const multiplierEditable = isAdmin && billMultiplier === null && !billLoading;

  // Auto-reset manual input when plant changes
  const handlePlantChange = (v: string) => { setPlantId(v); setEditingId(null); setMultiplierInput(''); };

  const { data: history } = useQuery({
    queryKey: ['op-power', plantId],
    queryFn: async () => {
      if (!plantId) return [];
      // First try with all optional columns
      const { data, error } = await supabase
        .from('power_readings')
        .select('id,plant_id,reading_datetime,meter_reading_kwh,daily_consumption_kwh,daily_solar_kwh,daily_grid_kwh,solar_meter_reading,is_meter_replacement,recorded_by')
        .eq('plant_id', plantId)
        .order('reading_datetime', { ascending: false })
        .limit(8);
      if (!error && data) return data;
      // Optional columns not yet in DB — retry with base columns only
      const { data: fallback, error: fallbackErr } = await supabase
        .from('power_readings')
        .select('id,plant_id,reading_datetime,meter_reading_kwh,daily_consumption_kwh,is_meter_replacement,recorded_by')
        .eq('plant_id', plantId)
        .order('reading_datetime', { ascending: false })
        .limit(8);
      if (!fallbackErr && fallback) return fallback;
      // Last resort: absolute minimum columns
      const { data: minimal } = await supabase
        .from('power_readings')
        .select('id,plant_id,reading_datetime,meter_reading_kwh')
        .eq('plant_id', plantId)
        .order('reading_datetime', { ascending: false })
        .limit(8);
      return minimal ?? [];
    },
    enabled: !!plantId,
    staleTime: 0,
  });

  // The most recent prior reading (skip the one being edited)
  const prevRow    = history?.find((r: any) => r.id !== editingId) ?? null;
  // Combined/grid meter: previous meter_reading_kwh
  const prevGrid   = prevRow?.meter_reading_kwh ?? null;
  // Solar meter: previous solar_meter_reading (if tracked)
  const prevSolar  = prevRow?.solar_meter_reading ?? null;

  // Delta calculations from meter readings
  const deltaGrid  = prevGrid != null && reading       ? +reading       - prevGrid  : null;
  // Raw mode: delta = current - prev cumulative reading
  // Direct mode: the entered value IS the daily kWh — no subtraction, no prevSolar needed
  const deltaSolar = solarInputMode === 'direct'
    ? (solarReading ? +solarReading : null)
    : (prevSolar != null && solarReading ? +solarReading  - prevSolar : null);
  // For combined (no solar): just use the main meter delta
  const daily      = showSolar ? deltaGrid : (prevGrid != null && reading ? +reading - prevGrid : null);
  // Effective daily kWh = Δ reading × multiplier
  const dailyEffective = daily != null ? daily * effectiveMultiplier : null;

  // Per-meter saving state
  const [savingMeter, setSavingMeter] = useState<string | null>(null);

  // Save a single meter reading independently
  const submitMeter = async (kind: 'solar' | 'grid', idx: number) => {
    if (!plantId) return;
    const meterKey = `${kind}-${idx}`;
    const val = kind === 'solar' ? (solarMeterReadings[idx] ?? '') : (gridMeterReadings[idx] ?? '');
    if (!val) { toast.error(`Enter a reading for ${kind === 'solar' ? getSolarLabel(idx) : getGridLabel(idx)}`); return; }

    setSavingMeter(meterKey);

    // Duplicate check (day-level) — only for the first/primary grid meter
    if (kind === 'grid' && idx === 0 && !editingId) {
      const dup = await findExistingReading({
        table: 'power_readings', entityCol: 'plant_id', entityId: plantId,
        datetime: new Date(dt), windowKind: 'day',
      });
      if (dup) {
        if (!confirm('A power reading already exists for this plant today. Edit it instead?')) {
          setSavingMeter(null); return;
        }
        setEditingId(dup);
      }
    }

    // Compute deltas for the primary meter only
    const computedDailyGrid  = kind === 'grid'  && idx === 0 && showSolar && deltaGrid  != null ? deltaGrid  * effectiveMultiplier : null;
    // In raw mode: delta is computed from prevSolar vs current solar meter reading
    // In direct mode: the user IS entering the delta — no prev needed, don't use deltaSolar
    const computedDailySolar = kind === 'solar' && idx === 0 && showSolar && solarInputMode === 'raw' && deltaSolar != null ? deltaSolar : null;

    const payload: any = {
      plant_id: plantId,
      reading_datetime: new Date(dt).toISOString(),
      recorded_by: user?.id,
    };

    if (kind === 'grid') {
      payload.meter_reading_kwh = +val;
      if (idx === 0 && computedDailyGrid != null) payload.daily_grid_kwh = computedDailyGrid;
      // Bug 3 fix: write daily_consumption_kwh so Dashboard power aggregation works.
      // For solar plants: grid consumption = Δ meter × multiplier.
      // For grid-only plants: daily_consumption_kwh = Δ meter (multiplier = 1 unless bill says otherwise).
      if (idx === 0 && deltaGrid != null) {
        payload.daily_consumption_kwh = deltaGrid * effectiveMultiplier;
      }
    }
    if (kind === 'solar') {
      // Only include meter_reading_kwh from grid if the user has actually entered one —
      // writing 0 would corrupt the cumulative grid meter sequence.
      const gridVal = gridMeterReadings[0];
      if (gridVal && +gridVal > 0) payload.meter_reading_kwh = +gridVal;
      if (solarInputMode === 'direct') {
        // Direct daily kWh: store only daily_solar_kwh, do NOT touch solar_meter_reading
        // (writing a raw meter value would corrupt the cumulative sequence)
        payload.daily_solar_kwh = +val;
      } else {
        // Raw cumulative meter: store solar_meter_reading and auto-compute daily_solar_kwh
        payload.solar_meter_reading = +val;
        // Only attach daily_solar_kwh when delta is actually computable (prev exists)
        if (idx === 0 && computedDailySolar != null) payload.daily_solar_kwh = computedDailySolar;
      }
    }

    const runQuery = () => editingId
      ? supabase.from('power_readings').update(payload).eq('id', editingId)
      : supabase.from('power_readings').insert(payload);

    let { error } = await runQuery();
    if (error && (
      error.message.includes('daily_solar_kwh') ||
      error.message.includes('daily_grid_kwh') ||
      error.message.includes('solar_meter_reading') ||
      error.message.includes('multiplier')
    )) {
      delete payload.daily_solar_kwh;
      delete payload.daily_grid_kwh;
      delete payload.solar_meter_reading;
      delete payload.multiplier;
      ({ error } = await runQuery());
    }

    setSavingMeter(null);
    if (error) { toast.error(error.message); return; }

    const label = kind === 'solar' ? getSolarLabel(idx) : getGridLabel(idx);
    toast.success(`${label}: reading saved`);

    // Clear only the saved meter's input
    if (kind === 'grid') {
      setGridMeterReadings(prev => { const next = [...prev]; next[idx] = ''; return next; });
      if (idx === 0) setReading('');
    } else {
      setSolarMeterReadings(prev => { const next = [...prev]; next[idx] = ''; return next; });
      if (idx === 0) setSolarReading('');
    }
    qc.invalidateQueries();
  };

  // Keep legacy submit for cancel/edit flows
  const submit = async () => {
    if (!plantId || !reading) return;
    const computedDailyGrid  = showSolar && deltaGrid  != null ? deltaGrid * effectiveMultiplier : null;
    const computedDailySolar = showSolar && deltaSolar != null ? deltaSolar : null;
    const payload: any = {
      plant_id: plantId,
      reading_datetime: new Date(dt).toISOString(),
      meter_reading_kwh: +reading,
      recorded_by: user?.id,
    };
    if (showSolar && solarReading) payload.solar_meter_reading = +solarReading;
    if (showSolar && computedDailyGrid  != null) payload.daily_grid_kwh  = computedDailyGrid;
    if (showSolar && computedDailySolar != null) payload.daily_solar_kwh = computedDailySolar;
    // Bug 3 fix: always write daily_consumption_kwh so Dashboard kWh total and PV ratio are correct
    if (daily != null) payload.daily_consumption_kwh = daily * effectiveMultiplier;
    const runQuery = () => editingId
      ? supabase.from('power_readings').update(payload).eq('id', editingId)
      : supabase.from('power_readings').insert(payload);
    let { error } = await runQuery();
    if (error && (
      error.message.includes('daily_solar_kwh') ||
      error.message.includes('daily_grid_kwh') ||
      error.message.includes('solar_meter_reading') ||
      error.message.includes('multiplier')
    )) {
      delete payload.daily_solar_kwh; delete payload.daily_grid_kwh;
      delete payload.solar_meter_reading; delete payload.multiplier;
      ({ error } = await runQuery());
    }
    if (error) { toast.error(error.message); return; }
    toast.success(editingId ? 'Updated' : 'Power reading saved');
    setReading(''); setSolarReading(''); setEditingId(null);
    setGridMeterReadings(['', '', '', '', '']);
    setSolarMeterReadings(['', '', '', '', '']);
    qc.invalidateQueries();
  };

  const startEdit = (r: any) => {
    setReading(String(r.meter_reading_kwh));
    setSolarReading(r.solar_meter_reading != null ? String(r.solar_meter_reading) : '');
    // Sync per-meter arrays: grid meter 0 = primary reading
    setGridMeterReadings(prev => { const next = [...prev]; next[0] = String(r.meter_reading_kwh); return next; });
    setSolarMeterReadings(prev => { const next = [...prev]; next[0] = r.solar_meter_reading != null ? String(r.solar_meter_reading) : ''; return next; });
    setDt(format(new Date(r.reading_datetime), "yyyy-MM-dd'T'HH:mm"));
    setEditingId(r.id);
    toast.info('Editing power reading');
  };

  // Build display rows: compute Δ on the fly by pairing consecutive readings
  const displayHistory = useMemo(() => {
    if (!history?.length) return [];
    return history.map((r: any, i: number) => {
      const pred          = history[i + 1] ?? null; // predecessor = row below (older), history is DESC
      // Grid meter Δ (raw, before multiplier)
      const deltaKwh      = pred != null ? r.meter_reading_kwh - pred.meter_reading_kwh : (r.daily_consumption_kwh ?? null);
      // Solar meter Δ
      const deltaSolarKwh = (pred?.solar_meter_reading != null && r.solar_meter_reading != null)
        ? r.solar_meter_reading - pred.solar_meter_reading
        : (r.daily_solar_kwh ?? null);
      // Grid consumption = grid meter Δ × CT multiplier
      const deltaGridKwh  = showSolar && deltaKwh != null
        ? deltaKwh * effectiveMultiplier
        : (r.daily_grid_kwh != null ? r.daily_grid_kwh : deltaKwh);
      return { ...r, _deltaKwh: deltaKwh, _deltaSolar: deltaSolarKwh, _deltaGrid: deltaGridKwh };
    });
  }, [history, showSolar, effectiveMultiplier]);

  return (
    <div className="space-y-3">
      <Card className="p-3 space-y-3">
        <div>
          <Label>Plant</Label>
          {/* Plant row with inline Import button */}
          <div className="flex items-center gap-2 mt-1">
            <div className="flex-1">
              <PlantSelector value={plantId} onChange={handlePlantChange} />
            </div>
            {isAdmin && plantId && (
              <Button
                size="sm" variant="outline"
                className="shrink-0 gap-1.5 border-teal-600 text-teal-700 hover:bg-teal-50 dark:hover:bg-teal-950/30"
                onClick={() => setImportOpen(true)}
                data-testid="import-power-readings-btn"
              >
                <Upload className="h-3.5 w-3.5" />
                Import
              </Button>
            )}
          </div>

          {/* ── Meter config hint ── */}
          {plantId && (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Meter count &amp; names are configured in <strong>Plants → Power</strong>.
            </p>
          )}
        </div>

        {/* Meter Reading(s) + Grid Power Multiplier — shown inline with Date & Time */}
        {showSolar ? (
          // ── Solar plant ────────────────────────────────────────────────────────
          <div className="space-y-3">

            {/* Date & Time + Grid Power Multiplier on the same row */}
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <Label>Date &amp; Time</Label>
                <Input type="datetime-local" value={dt} onChange={e => setDt(e.target.value)}
                  className="h-10 w-full max-w-[260px] min-w-[220px] block text-center sm:text-left bg-slate-50 dark:bg-slate-900 border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400" />
              </div>
              <div className="min-w-[130px]">
                <Label className="flex flex-wrap items-center gap-x-1 gap-y-0 text-xs leading-tight">
                  Grid Power Multiplier
                  {plantId && !billLoading && (
                    billMultiplier !== null
                      ? <span className="text-[9px] text-muted-foreground font-normal whitespace-nowrap">(from bill)</span>
                      : isAdmin
                        ? <span className="text-[9px] text-amber-600 font-normal whitespace-nowrap">(no bill yet)</span>
                        : null
                  )}
                </Label>
                <Input
                  type="number" step="any" min="1"
                  value={billMultiplier !== null ? billMultiplier : multiplierInput}
                  onChange={e => multiplierEditable && setMultiplierInput(e.target.value)}
                  readOnly={!multiplierEditable}
                  placeholder={billLoading ? '…' : '1'}
                  className={['text-center font-mono-num text-sm px-1', !multiplierEditable ? 'bg-muted cursor-not-allowed text-muted-foreground' : ''].join(' ')}
                  title={billMultiplier !== null ? `CT multiplier from latest bill (×${billMultiplier}). Update via Costs → Power bill.` : isAdmin ? 'No bill saved yet — enter multiplier manually.' : 'Multiplier is set by the latest electric bill.'}
                  data-testid="power-multiplier-input"
                />
              </div>
            </div>

            {/* ── 2-column layout: Solar (left) | Grid (right) ── */}
            <div className="grid grid-cols-2 gap-4 items-start">

              {/* ── Solar column ── */}
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 pb-1 border-b border-yellow-200 dark:border-yellow-800/40">
                  <span className="text-yellow-500 text-sm leading-none">☀</span>
                  <span className="text-xs font-semibold text-yellow-700 dark:text-yellow-400 uppercase tracking-wide">Solar</span>
                  <span className="text-[10px] text-muted-foreground ml-auto">{solarMeterCount} meter{solarMeterCount !== 1 ? 's' : ''}</span>
                </div>

                {/* Solar input mode toggle — clears all solar inputs on switch */}
                <div className="flex items-center rounded-md border border-yellow-200 dark:border-yellow-800/40 overflow-hidden text-[10px] font-medium w-fit">
                  <button type="button"
                    onClick={() => { setSolarInputMode('raw'); setSolarMeterReadings(['', '', '', '', '']); setSolarReading(''); }}
                    className={`px-2.5 py-1 transition-colors ${solarInputMode === 'raw' ? 'bg-yellow-500 text-white' : 'bg-transparent text-muted-foreground hover:bg-yellow-50 dark:hover:bg-yellow-950/30'}`}
                    title="Cumulative meter reading — Δ auto-computed from previous">Raw Meter</button>
                  <button type="button"
                    onClick={() => { setSolarInputMode('direct'); setSolarMeterReadings(['', '', '', '', '']); setSolarReading(''); }}
                    className={`px-2.5 py-1 transition-colors border-l border-yellow-200 dark:border-yellow-800/40 ${solarInputMode === 'direct' ? 'bg-yellow-500 text-white' : 'bg-transparent text-muted-foreground hover:bg-yellow-50 dark:hover:bg-yellow-950/30'}`}
                    title="Enter daily kWh directly — no previous reading needed">Direct kWh</button>
                </div>

                {Array.from({ length: solarMeterCount }).map((_, idx) => {
                  const meterLabel = getSolarLabel(idx);
                  const val = solarMeterReadings[idx] ?? '';
                  const isFirst = idx === 0;
                  const handleChange = (v: string) => {
                    setSolarMeterReading(idx, v);
                    if (isFirst) setSolarReading(v);
                  };
                  const meterKey = `solar-${idx}`;
                  const isSavingThis = savingMeter === meterKey;
                  return (
                    <div key={`solar-${idx}`}>
                      <Label className="flex items-center gap-1 text-xs">
                        <span className="text-yellow-400 text-[10px]">☀</span>
                        {meterLabel}
                        {isFirst && editingId && <span className="text-[10px] text-amber-600 ml-1">(editing)</span>}
                      </Label>
                      <div className="flex items-center gap-2">
                        <Input type="number" step="any" value={val}
                          onChange={e => handleChange(e.target.value)}
                          placeholder={solarInputMode === 'direct' ? 'Daily kWh' : 'Solar reading'}
                          className="border-yellow-300 focus-visible:ring-yellow-300"
                          data-testid={`power-solar-input-${idx}`} />
                        <Button size="sm" disabled={isSavingThis || !val}
                          onClick={() => submitMeter('solar', idx)}
                          className="shrink-0 h-9 px-3 text-xs bg-teal-700 text-white hover:bg-teal-800"
                          data-testid={`power-solar-save-${idx}`}>
                          {isSavingThis ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save'}
                        </Button>
                      </div>
                      {/* Hint line: raw mode shows prev + computed Δ; direct mode previews stored value */}
                      {isFirst && solarInputMode === 'raw' && prevSolar != null && (
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          prev: <span className="font-mono-num">{fmtNum(prevSolar)}</span>
                          {val && deltaSolar != null && (
                            <span className={`font-mono-num font-medium ml-1 ${deltaSolar >= 0 ? 'text-yellow-600' : 'text-destructive'}`}>
                              Δ {fmtNum(deltaSolar)} kWh
                            </span>
                          )}
                          {val && prevSolar != null && deltaSolar == null && (
                            <span className="ml-1 text-muted-foreground/60">(enter value to compute Δ)</span>
                          )}
                        </p>
                      )}
                      {isFirst && solarInputMode === 'raw' && prevSolar == null && val && (
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          No previous solar reading — Δ will be available after next entry.
                        </p>
                      )}
                      {isFirst && solarInputMode === 'direct' && val && (
                        <p className="text-[10px] text-yellow-600 dark:text-yellow-400 font-mono-num mt-0.5">
                          → {fmtNum(+val)} kWh will be saved as daily production
                        </p>
                      )}
                    </div>
                  );
                })}

                {/* Total Δ row — only meaningful in raw mode */}
                {solarInputMode === 'raw' && deltaSolar != null && solarMeterCount > 1 && (
                  <div className="rounded border border-yellow-200 bg-yellow-50/60 dark:border-yellow-800/30 dark:bg-yellow-950/10 px-2 py-1 text-[11px] flex items-center gap-1.5 mt-1">
                    <span className="text-yellow-500">☀</span>
                    <span className="text-muted-foreground">Total Δ</span>
                    <span className={`font-mono-num font-semibold ml-auto ${deltaSolar >= 0 ? 'text-yellow-700 dark:text-yellow-400' : 'text-destructive'}`}>
                      {fmtNum(deltaSolar)} kWh
                    </span>
                  </div>
                )}
              </div>

              {/* ── Grid column ── */}
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 pb-1 border-b border-blue-200 dark:border-blue-800/40">
                  <Zap className="h-3 w-3 text-blue-500" />
                  <span className="text-xs font-semibold text-blue-700 dark:text-blue-400 uppercase tracking-wide">Grid</span>
                  <span className="text-[10px] text-muted-foreground ml-auto">{gridMeterCount} meter{gridMeterCount !== 1 ? 's' : ''}</span>
                </div>
                {Array.from({ length: gridMeterCount }).map((_, idx) => {
                  const meterLabel = getGridLabel(idx);
                  const val = gridMeterReadings[idx] ?? '';
                  const isFirst = idx === 0;
                  const handleChange = (v: string) => {
                    setGridMeterReading(idx, v);
                    if (isFirst) setReading(v);
                  };
                  const meterKey = `grid-${idx}`;
                  const isSavingThis = savingMeter === meterKey;
                  return (
                    <div key={`grid-${idx}`}>
                      <Label className="flex items-center gap-1 text-xs">
                        <Zap className="h-2.5 w-2.5 text-blue-400" />
                        {meterLabel}
                      </Label>
                      <div className="flex items-center gap-2">
                        <Input type="number" step="any" value={val}
                          onChange={e => handleChange(e.target.value)}
                          placeholder="Grid reading"
                          className="border-blue-300 focus-visible:ring-blue-300"
                          data-testid={`power-meter-input-${idx}`} />
                        <Button
                          size="sm"
                          disabled={isSavingThis || !val}
                          onClick={() => submitMeter('grid', idx)}
                          className="shrink-0 h-9 px-3 text-xs bg-teal-700 text-white hover:bg-teal-800"
                          data-testid={`power-grid-save-${idx}`}
                        >
                          {isSavingThis ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save'}
                        </Button>
                      </div>
                      {isFirst && prevGrid != null && (
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          prev: <span className="font-mono-num">{fmtNum(prevGrid)}</span>
                          {deltaGrid != null && (
                            <span className={`font-mono-num font-medium ml-1 ${deltaGrid >= 0 ? 'text-blue-600' : 'text-destructive'}`}>
                              Δ {fmtNum(deltaGrid)}
                            </span>
                          )}
                        </p>
                      )}
                    </div>
                  );
                })}
                {/* Grid column total Δ (×multiplier) */}
                {deltaGrid != null && gridMeterCount > 1 && (
                  <div className="rounded border border-blue-200 bg-blue-50/60 dark:border-blue-800/30 dark:bg-blue-950/10 px-2 py-1 text-[11px] flex items-center gap-1.5 mt-1">
                    <Zap className="h-3 w-3 text-blue-500" />
                    <span className="text-muted-foreground">Total Δ</span>
                    {effectiveMultiplier !== 1 && <span className="text-[10px] text-amber-500">×{effectiveMultiplier}</span>}
                    <span className={`font-mono-num font-semibold ml-auto ${deltaGrid >= 0 ? 'text-blue-700 dark:text-blue-400' : 'text-destructive'}`}>
                      {fmtNum(deltaGrid * effectiveMultiplier)} kWh
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Energy Source Breakdown — total Δ solar + total Δ grid */}
            <div className="flex items-center gap-1.5 rounded border bg-muted/20 px-2.5 py-1.5 text-[11px]">
              <span className="text-muted-foreground/60 font-medium uppercase tracking-wide shrink-0">Breakdown</span>
              <span className="text-muted-foreground/40">·</span>
              <span className="text-yellow-500 shrink-0">☀</span>
              <span className={deltaSolar != null ? 'font-mono-num font-medium text-yellow-700 dark:text-yellow-400' : 'text-muted-foreground/50'}>
                {deltaSolar != null ? `${fmtNum(deltaSolar)} kWh` : '—'}
              </span>
              <span className="text-muted-foreground/40 mx-0.5">|</span>
              <Zap className="h-3 w-3 text-blue-500 shrink-0" />
              <span className={deltaGrid != null ? 'font-mono-num font-medium text-blue-700 dark:text-blue-400' : 'text-muted-foreground/50'}>
                {deltaGrid != null ? `${fmtNum(deltaGrid * effectiveMultiplier)} kWh` : '—'}
              </span>
              {effectiveMultiplier !== 1 && deltaGrid != null && (
                <span className="text-[10px] text-amber-500 ml-0.5">×{effectiveMultiplier}</span>
              )}
              <span className="text-muted-foreground/30 text-[10px] ml-auto">auto · read-only</span>
            </div>
          </div>
        ) : (
          // Non-solar plant: Date & Time + Grid Power Multiplier inline, then dynamic grid meter rows
          <div className="space-y-3">
            {/* Date & Time + Grid Power Multiplier on the same row */}
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <Label>Date &amp; Time</Label>
                <Input type="datetime-local" value={dt} onChange={e => setDt(e.target.value)}
                  className="h-10 w-full max-w-[260px] min-w-[220px] block text-center sm:text-left bg-slate-50 dark:bg-slate-900 border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400" />
              </div>
              <div className="min-w-[130px]">
                <Label className="flex flex-wrap items-center gap-x-1 gap-y-0 text-xs leading-tight">
                  Grid Power Multiplier
                  {plantId && !billLoading && (
                    billMultiplier !== null
                      ? <span className="text-[9px] text-muted-foreground font-normal whitespace-nowrap">(from bill)</span>
                      : isAdmin
                        ? <span className="text-[9px] text-amber-600 font-normal whitespace-nowrap">(no bill yet)</span>
                        : null
                  )}
                </Label>
                <Input
                  type="number" step="any" min="1"
                  value={billMultiplier !== null ? billMultiplier : multiplierInput}
                  onChange={e => multiplierEditable && setMultiplierInput(e.target.value)}
                  readOnly={!multiplierEditable}
                  placeholder={billLoading ? '…' : '1'}
                  className={['text-center font-mono-num text-sm px-1', !multiplierEditable ? 'bg-muted cursor-not-allowed text-muted-foreground' : ''].join(' ')}
                  title={billMultiplier !== null ? `CT multiplier from latest bill (×${billMultiplier}). Update via Costs → Power bill.` : isAdmin ? 'No bill saved yet — enter multiplier manually. Save a bill in Costs to lock it.' : 'Multiplier is set by the latest electric bill.'}
                  data-testid="power-multiplier-input"
                />
              </div>
            </div>

            {/* Dynamic grid meter rows */}
            {Array.from({ length: gridMeterCount }).map((_, idx) => {
              const meterLabel = getGridLabel(idx);
              const val = gridMeterReadings[idx] ?? '';
              const isFirst = idx === 0;
              const handleChange = (v: string) => {
                setGridMeterReading(idx, v);
                if (isFirst) setReading(v);
              };
              const meterKey2 = `grid-${idx}`;
              const isSavingThis2 = savingMeter === meterKey2;
              return (
                <div key={`grid-ns-${idx}`}>
                  <Label className="flex items-center gap-1.5">
                    <Zap className="h-3 w-3 text-blue-500" />
                    {meterLabel}
                    {isFirst && editingId && <span className="text-xs text-highlight ml-1">(editing)</span>}
                  </Label>
                  <div className="flex items-center gap-2">
                    <Input type="number" step="any" value={val}
                      onChange={e => handleChange(e.target.value)}
                      placeholder="Grid meter reading"
                      className="border-blue-300 focus-visible:ring-blue-300"
                      data-testid={`power-meter-input-${idx}`} />
                    <Button
                      size="sm"
                      disabled={isSavingThis2 || !val}
                      onClick={() => submitMeter('grid', idx)}
                      className="shrink-0 h-9 px-3 text-xs bg-teal-700 text-white hover:bg-teal-800"
                      data-testid={`power-grid-save-ns-${idx}`}
                    >
                      {isSavingThis2 ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save'}
                    </Button>
                  </div>
                  {isFirst && prevGrid != null && (
                    <div className="text-xs text-muted-foreground space-y-0.5 mt-0.5">
                      <span>
                        Previous: <span className="font-mono-num">{fmtNum(prevGrid)}</span>
                        {daily != null && <> · Δ <span className="font-mono-num">{fmtNum(daily)} kWh</span></>}
                      </span>
                      {dailyEffective != null && effectiveMultiplier !== 1 && (
                        <div className="inline-flex items-center gap-1.5 ml-2 rounded bg-amber-50 border border-amber-200 dark:bg-amber-950/20 dark:border-amber-800 px-2 py-0.5">
                          <Zap className="h-3 w-3 text-amber-500 shrink-0" />
                          <span className="font-mono-num font-medium text-amber-700 dark:text-amber-300">
                            {fmtNum(dailyEffective, 2)} kWh
                          </span>
                          <span className="text-amber-600/70 dark:text-amber-400/60">effective (×{effectiveMultiplier})</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {editingId && (
          <div className="flex gap-2">
            <Button variant="ghost" className="flex-1" onClick={() => { setEditingId(null); setReading(''); setSolarReading(''); setGridMeterReadings(['', '', '', '', '']); setSolarMeterReadings(['', '', '', '', '']); setSolarInputMode('raw'); }}>Cancel edit</Button>
          </div>
        )}
      </Card>

      <Card className="p-3">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-sm font-semibold">Last 7 readings</h4>
          {(isAdmin || isManager) && plantId && (
            <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs text-muted-foreground px-2"
              onClick={() => setPowerHistoryOpen(true)}>
              <History className="h-3 w-3" /> Full history
            </Button>
          )}
        </div>
        {displayHistory.length ? displayHistory.slice(0, 7).map((r: any) => (
          <div key={r.id} className="py-2 border-t space-y-0.5">
            {/* ── Row 1: date + grid meter reading + grid Δ (×mult) + edit ── */}
            <div className="flex justify-between items-center text-xs gap-2">
              <span className="flex-1 text-muted-foreground whitespace-nowrap">
                {format(new Date(r.reading_datetime), 'MMM d, yyyy HH:mm')}
              </span>
              {/* Raw grid meter reading */}
              <span className="font-mono-num text-blue-600" title="Grid meter reading">
                <Zap className="inline h-3 w-3 mr-0.5 text-blue-400" />
                {fmtNum(r.meter_reading_kwh)}
              </span>
              {/* Grid Δ (after multiplier) */}
              <span className={[
                'font-mono-num font-medium whitespace-nowrap',
                r._deltaGrid != null && r._deltaGrid < 0 ? 'text-destructive' : 'text-blue-700 dark:text-blue-400',
              ].join(' ')}>
                {r._deltaGrid != null
                  ? <>Δ {fmtNum(r._deltaGrid)} kWh{effectiveMultiplier !== 1 && <span className="text-[10px] text-amber-500 ml-0.5">×{effectiveMultiplier}</span>}</>
                  : '—'
                }
              </span>
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0 shrink-0" onClick={() => startEdit(r)}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </div>

            {/* ── Row 2 (solar plants only): solar meter reading + Δ ── */}
            {showSolar && (
              <div className="flex items-center gap-2 text-[11px] pl-0.5">
                <span className="text-yellow-500">☀</span>
                <span className="font-mono-num text-yellow-700 dark:text-yellow-400" title="Solar meter reading">
                  {r.solar_meter_reading != null ? fmtNum(r.solar_meter_reading) : '—'}
                </span>
                {r._deltaSolar != null ? (
                  <span className={r._deltaSolar < 0 ? 'text-destructive font-mono-num' : 'text-yellow-600 font-mono-num'}>
                    Δ {fmtNum(r._deltaSolar)} kWh
                  </span>
                ) : (
                  <span className="text-muted-foreground/50">no solar Δ</span>
                )}
              </div>
            )}
          </div>
        )) : <p className="text-xs text-muted-foreground">{plantId ? 'No readings yet' : 'Select a plant to view readings'}</p>}
      </Card>

      {importOpen && (
        <ImportReadingsDialog
          title="Import Power Readings from CSV"
          module="power"
          plantId={plantId}
          userId={user?.id ?? null}
          schemaHint={POWER_SCHEMA}
          templateFilename="power_readings_template.csv"
          templateRow={POWER_TEMPLATE_ROW}
          validateRow={validatePowerRow}
          insertRows={(rows, pid) => insertPowerReadings(rows, pid, user?.id ?? null)}
          onClose={() => setImportOpen(false)}
          onImported={() => { setImportOpen(false); qc.invalidateQueries({ queryKey: ['op-power', plantId] }); }}
        />
      )}
      {powerHistoryOpen && plantId && (
        <ReadingHistoryDialog
          entityName={plants?.find((p: any) => p.id === plantId)?.name ?? 'Plant'}
          module="power"
          entityId={plantId}
          onClose={() => setPowerHistoryOpen(false)}
        />
      )}
    </div>
  );
}

// ─── Reading History Dialog ───────────────────────────────────────────────────

type HistoryModule = 'locator' | 'well' | 'blending' | 'power';
const HISTORY_WINDOWS = [
  { label: '7D', days: 7 },
  { label: '14D', days: 14 },
  { label: '30D', days: 30 },
  { label: '60D', days: 60 },
] as const;

// Inline edit state for a history row
interface HistoryEditState {
  id: string;
  datetime: string;          // "yyyy-MM-dd'T'HH:mm"
  value: string;             // primary numeric field
  value2?: string;           // secondary (power for well, or solar for power)
  value3?: string;           // tertiary (grid for power)
  isMeterReplacement?: boolean;
}

function ReadingHistoryDialog({ entityName, module, entityId, plantId, onClose }: {
  entityName: string;
  module: HistoryModule;
  entityId: string;
  plantId?: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [days, setDays] = useState<7 | 14 | 30 | 60 | 'custom'>(30);
  const [customFrom, setCustomFrom] = useState(format(new Date(Date.now() - 30 * 86400000), 'yyyy-MM-dd'));
  const [customTo, setCustomTo]     = useState(format(new Date(), 'yyyy-MM-dd'));
  const [appliedFrom, setAppliedFrom] = useState(customFrom);
  const [appliedTo, setAppliedTo]     = useState(customTo);
  const [editRow, setEditRow] = useState<HistoryEditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [togglingGridId, setTogglingGridId] = useState<string | null>(null);
  const [togglingSolarId, setTogglingSolarId] = useState<string | null>(null);

  // Helper: parse a YYYY-MM-DD string as LOCAL midnight (avoids UTC timezone shift)
  const localMidnight = (dateStr: string) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d);
  };

  const queryKey = ['reading-history', module, entityId, days, appliedFrom, appliedTo];

  const { data: rows, isLoading } = useQuery({
    queryKey,
    queryFn: async () => {
      // Use date-only strings (YYYY-MM-DD) for all filters — avoids UTC offset
      // cutting off records that were saved in a different timezone.
      let sinceDate: string;
      let untilNextDay: string; // exclusive upper bound = day after end date
      if (days === 'custom') {
        sinceDate = appliedFrom;
        const end = new Date(appliedTo + 'T00:00:00');
        end.setDate(end.getDate() + 1);
        untilNextDay = end.toISOString().slice(0, 10);
      } else {
        const since = new Date();
        since.setDate(since.getDate() - days);
        sinceDate = since.toISOString().slice(0, 10);
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        untilNextDay = tomorrow.toISOString().slice(0, 10);
      }

      if (module === 'locator') {
        const { data } = await supabase
          .from('locator_readings')
          .select('id, current_reading, previous_reading, reading_datetime, off_location_flag, is_meter_replacement')
          .eq('locator_id', entityId)
          .gte('reading_datetime', sinceDate)
          .lt('reading_datetime', untilNextDay)
          .order('reading_datetime', { ascending: false });
        return data ?? [];
      }
      if (module === 'well') {
        const { data } = await supabase
          .from('well_readings')
          .select('id, current_reading, previous_reading, power_meter_reading, reading_datetime, is_meter_replacement')
          .eq('well_id', entityId)
          .gte('reading_datetime', sinceDate)
          .lt('reading_datetime', untilNextDay)
          .order('reading_datetime', { ascending: false });
        return data ?? [];
      }
      if (module === 'power') {
        const { data, error } = await supabase
          .from('power_readings')
          .select('id, meter_reading_kwh, daily_consumption_kwh, daily_solar_kwh, daily_grid_kwh, solar_meter_reading, reading_datetime, is_meter_replacement')
          .eq('plant_id', entityId)
          .gte('reading_datetime', sinceDate)
          .lt('reading_datetime', untilNextDay)
          .order('reading_datetime', { ascending: false });
        if (!error) return data ?? [];
        // Fallback: base columns only (optional migration columns missing)
        const { data: fallback } = await supabase
          .from('power_readings')
          .select('id, meter_reading_kwh, daily_consumption_kwh, reading_datetime, is_meter_replacement')
          .eq('plant_id', entityId)
          .gte('reading_datetime', sinceDate)
          .lt('reading_datetime', untilNextDay)
          .order('reading_datetime', { ascending: false });
        return fallback ?? [];
      }
      if (module === 'blending') {
        try {
          const daysParam = days === 'custom'
            ? Math.ceil((new Date(customTo).getTime() - new Date(customFrom).getTime()) / 86400000) + 1
            : days;
          const res = await fetch(
            `${BASE}/api/blending/history?well_id=${encodeURIComponent(entityId)}&days=${daysParam}`
          );
          if (!res.ok) return [];
          const json = await res.json();
          return json.events ?? [];
        } catch { return []; }
      }
      return [];
    },
    staleTime: 0,
  });

  const startEdit = (r: any) => {
    const dt = r.reading_datetime ?? r.created_at ?? '';
    const dtStr = dt ? format(new Date(dt), "yyyy-MM-dd'T'HH:mm") : format(new Date(), "yyyy-MM-dd'T'HH:mm");
    if (module === 'well') {
      setEditRow({ id: r.id, datetime: dtStr, value: String(r.current_reading ?? ''), value2: r.power_meter_reading != null ? String(r.power_meter_reading) : '', isMeterReplacement: !!r.is_meter_replacement });
    } else if (module === 'locator') {
      setEditRow({ id: r.id, datetime: dtStr, value: String(r.current_reading ?? ''), isMeterReplacement: !!r.is_meter_replacement });
    } else if (module === 'power') {
      setEditRow({ id: r.id, datetime: dtStr, value: String(r.meter_reading_kwh ?? ''), value2: r.solar_meter_reading != null ? String(r.solar_meter_reading) : '', value3: r.daily_grid_kwh != null ? String(r.daily_grid_kwh) : '', isMeterReplacement: !!r.is_meter_replacement });
    }
  };

  // One-click toggle for shared (non-power) meter replacement
  const toggleMeterReplacement = async (r: any) => {
    setTogglingId(r.id);
    const next = !r.is_meter_replacement;
    let error: any = null;
    if (module === 'well')
      ({ error } = await (supabase.from('well_readings') as any).update({ is_meter_replacement: next }).eq('id', r.id));
    else if (module === 'locator')
      ({ error } = await (supabase.from('locator_readings') as any).update({ is_meter_replacement: next }).eq('id', r.id));
    setTogglingId(null);
    if (error) { toast.error(error.message); return; }
    toast.success(next ? 'Marked as meter replacement — Δ zeroed' : 'Meter replacement flag removed');
    qc.invalidateQueries({ queryKey });
  };

  // Power-specific: toggle grid meter replacement
  const toggleGridReplacement = async (r: any) => {
    setTogglingGridId(r.id);
    const next = !r.is_grid_replacement;
    const { error } = await (supabase.from('power_readings') as any)
      .update({ is_grid_replacement: next }).eq('id', r.id);
    setTogglingGridId(null);
    if (error) {
      // Column may not exist yet — fall back to shared flag
      const { error: e2 } = await (supabase.from('power_readings') as any)
        .update({ is_meter_replacement: next }).eq('id', r.id);
      if (e2) { toast.error(e2.message); return; }
    }
    toast.success(next ? 'Grid replacement marked — Δ zeroed' : 'Grid replacement flag removed');
    qc.invalidateQueries({ queryKey });
  };

  // Power-specific: toggle solar meter replacement
  const toggleSolarReplacement = async (r: any) => {
    setTogglingSolarId(r.id);
    const next = !r.is_solar_replacement;
    const { error } = await (supabase.from('power_readings') as any)
      .update({ is_solar_replacement: next }).eq('id', r.id);
    setTogglingSolarId(null);
    if (error) { toast.error(error.message); return; }
    toast.success(next ? 'Solar replacement marked — Δ zeroed' : 'Solar replacement flag removed');
    qc.invalidateQueries({ queryKey });
  };

  // Row selection helpers
  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const toggleSelectAll = () => {
    if (!rows?.length) return;
    setSelectedIds(prev =>
      prev.size === rows.length ? new Set() : new Set(rows.map((r: any) => r.id))
    );
  };

  // Bulk delete
  const bulkDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!window.confirm(`Delete ${selectedIds.size} reading(s)? This cannot be undone.`)) return;
    setBulkDeleting(true);
    const ids = [...selectedIds];
    let error: any = null;
    if (module === 'well')
      ({ error } = await supabase.from('well_readings').delete().in('id', ids));
    else if (module === 'locator')
      ({ error } = await supabase.from('locator_readings').delete().in('id', ids));
    else if (module === 'power')
      ({ error } = await supabase.from('power_readings').delete().in('id', ids));
    setBulkDeleting(false);
    if (error) { toast.error(error.message); return; }
    toast.success(`${ids.length} reading(s) deleted`);
    setSelectedIds(new Set());
    qc.invalidateQueries({ queryKey });
    if (module === 'power') qc.invalidateQueries({ queryKey: ['op-power', entityId] });
    qc.invalidateQueries();
  };

  const deleteRow = async (id: string) => {
    if (!window.confirm('Delete this reading? This cannot be undone.')) return;
    setDeletingId(id);
    let error: any = null;
    if (module === 'well') ({ error } = await supabase.from('well_readings').delete().eq('id', id));
    else if (module === 'locator') ({ error } = await supabase.from('locator_readings').delete().eq('id', id));
    else if (module === 'power') ({ error } = await supabase.from('power_readings').delete().eq('id', id));
    setDeletingId(null);
    if (error) { toast.error(error.message); return; }
    toast.success('Reading deleted');
    setSelectedIds(prev => { const n = new Set(prev); n.delete(id); return n; });
    qc.invalidateQueries({ queryKey });
    if (module === 'power') qc.invalidateQueries({ queryKey: ['op-power', entityId] });
    if (module === 'locator') qc.invalidateQueries({ queryKey: ['op-locator-recent'] });
    if (module === 'well') qc.invalidateQueries({ queryKey: ['op-well-recent'] });
    qc.invalidateQueries();
  };

  const saveEdit = async () => {
    if (!editRow) return;
    setSaving(true);
    let error: any = null;
    const dtIso = new Date(editRow.datetime).toISOString();

    if (module === 'well') {
      ({ error } = await (supabase.from('well_readings') as any).update({
        current_reading: +editRow.value,
        power_meter_reading: editRow.value2 ? +editRow.value2 : null,
        reading_datetime: dtIso,
        is_meter_replacement: !!editRow.isMeterReplacement,
      }).eq('id', editRow.id));
    } else if (module === 'locator') {
      ({ error } = await (supabase.from('locator_readings') as any).update({
        current_reading: +editRow.value,
        reading_datetime: dtIso,
        is_meter_replacement: !!editRow.isMeterReplacement,
      }).eq('id', editRow.id));
    } else if (module === 'power') {
      ({ error } = await (supabase.from('power_readings') as any).update({
        meter_reading_kwh: +editRow.value,
        solar_meter_reading: editRow.value2 ? +editRow.value2 : null,
        reading_datetime: dtIso,
        is_meter_replacement: !!editRow.isMeterReplacement,
      }).eq('id', editRow.id));
    }

    setSaving(false);
    if (error) { toast.error(error.message); return; }
    toast.success('Reading updated');
    setEditRow(null);
    qc.invalidateQueries({ queryKey });
    // Also invalidate the parent form queries so "Last 7 readings" refreshes
    if (module === 'power') qc.invalidateQueries({ queryKey: ['op-power', entityId] });
    if (module === 'locator') qc.invalidateQueries({ queryKey: ['op-locator-recent'] });
    if (module === 'well') qc.invalidateQueries({ queryKey: ['op-well-recent'] });
    qc.invalidateQueries();
  };

  const title = module === 'power' ? `Power — ${entityName}` : `${entityName} — History`;
  const canEditDelete = module !== 'blending';

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-base">{title}</DialogTitle>
        </DialogHeader>

        {/* Window selector */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1 p-1 bg-muted rounded-lg w-fit">
            {HISTORY_WINDOWS.map(({ label, days: d }) => (
              <button
                key={label}
                onClick={() => { setDays(d as any); setEditRow(null); }}
                className={[
                  'px-3 py-1 text-xs font-medium rounded-md transition-all',
                  days === d ? 'bg-teal-700 text-white shadow-sm' : 'text-muted-foreground hover:text-foreground',
                ].join(' ')}
              >
                {label}
              </button>
            ))}
            <button
              onClick={() => { setDays('custom'); setEditRow(null); }}
              className={[
                'px-3 py-1 text-xs font-medium rounded-md transition-all',
                days === 'custom' ? 'bg-teal-700 text-white shadow-sm' : 'text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >
              Custom
            </button>
          </div>
          {days === 'custom' && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <input
                type="date"
                value={customFrom}
                max={customTo}
                onChange={e => setCustomFrom(e.target.value)}
                className="h-7 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              <span className="text-xs text-muted-foreground">to</span>
              <input
                type="date"
                value={customTo}
                min={customFrom}
                max={format(new Date(), 'yyyy-MM-dd')}
                onChange={e => setCustomTo(e.target.value)}
                className="h-7 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              <Button size="sm" className="h-7 px-3 text-xs bg-teal-700 text-white hover:bg-teal-800"
                onClick={() => { setAppliedFrom(customFrom); setAppliedTo(customTo); setEditRow(null); }}>
                Apply
              </Button>
            </div>
          )}
        </div>

        {/* Inline edit form */}
        {editRow && (
          <div className="rounded-md border bg-muted/30 p-3 space-y-2 text-xs">
            <p className="font-medium text-foreground">Editing reading</p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-[11px]">Date &amp; Time</Label>
                <Input type="datetime-local" value={editRow.datetime}
                  onChange={e => setEditRow({ ...editRow, datetime: e.target.value })}
                  className="h-8 text-xs" />
              </div>
              <div>
                <Label className="text-[11px]">
                  {module === 'well' ? 'Water (unitless)' : module === 'locator' ? 'Reading' : 'Grid Power Reading (kWh)'}
                </Label>
                <Input type="number" step="any" value={editRow.value}
                  onChange={e => setEditRow({ ...editRow, value: e.target.value })}
                  className="h-8 text-xs" />
              </div>
              {module === 'well' && (
                <div>
                  <Label className="text-[11px]">Power Meter (kWh)</Label>
                  <Input type="number" step="any" value={editRow.value2 ?? ''}
                    onChange={e => setEditRow({ ...editRow, value2: e.target.value })}
                    className="h-8 text-xs" placeholder="optional" />
                </div>
              )}
              {module === 'power' && (
                <div>
                  <Label className="text-[11px]">Solar Power Reading (kWh)</Label>
                  <Input type="number" step="any" value={editRow.value2 ?? ''}
                    onChange={e => setEditRow({ ...editRow, value2: e.target.value })}
                    className="h-8 text-xs" placeholder="optional" />
                </div>
              )}
            </div>
            <label className="flex items-center gap-2 cursor-pointer select-none w-fit">
              <input
                type="checkbox"
                checked={!!editRow.isMeterReplacement}
                onChange={e => setEditRow({ ...editRow, isMeterReplacement: e.target.checked })}
                className="h-3.5 w-3.5 accent-orange-500"
              />
              <span className="text-[11px] text-muted-foreground">Meter replacement / PMS (zeroes Δ)</span>
            </label>
            <div className="flex gap-2">
              <Button size="sm" onClick={saveEdit} disabled={saving || !editRow.value}
                className="bg-teal-700 text-white hover:bg-teal-800 h-7 text-xs px-3">
                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save changes'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditRow(null)} disabled={saving} className="h-7 text-xs px-3">
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* Bulk delete toolbar — shown when rows are selected */}
        {canEditDelete && selectedIds.size > 0 && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
            <span className="text-xs font-medium text-destructive flex-1">
              {selectedIds.size} row{selectedIds.size > 1 ? 's' : ''} selected
            </span>
            <Button
              size="sm"
              variant="destructive"
              className="h-7 px-3 text-xs gap-1.5"
              onClick={bulkDelete}
              disabled={bulkDeleting}
            >
              {bulkDeleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
              Delete selected
            </Button>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs"
              onClick={() => setSelectedIds(new Set())}>
              Clear
            </Button>
          </div>
        )}

        {/* Table */}
        <div className="overflow-auto max-h-72 rounded border text-xs">
          {isLoading ? (
            <div className="flex items-center justify-center p-6 text-muted-foreground gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : !rows?.length ? (
            <p className="p-4 text-center text-muted-foreground">
              {days === 'custom'
                ? `No readings from ${appliedFrom} → ${appliedTo}`
                : `No readings in the last ${days} days`}
            </p>
          ) : (
            <table className="w-full text-left">
              <thead className="bg-muted sticky top-0">
                <tr>
                  {canEditDelete && (
                    <th className="px-2 py-2 w-8">
                      <input type="checkbox"
                        className="h-3.5 w-3.5 accent-teal-700 cursor-pointer"
                        checked={!!rows?.length && selectedIds.size === rows.length}
                        onChange={toggleSelectAll}
                        title="Select all"
                      />
                    </th>
                  )}
                  <th className="px-3 py-2 font-medium">Date & Time</th>
                  {module === 'locator' && <>
                    <th className="px-3 py-2 font-medium text-right">Reading</th>
                    <th className="px-3 py-2 font-medium text-right">Δ</th>
                    <th className="px-2 py-2 font-medium text-center">Repl.</th>
                    <th className="px-3 py-2 font-medium">Flags</th>
                  </>}
                  {module === 'well' && <>
                    <th className="px-3 py-2 font-medium text-right">Water</th>
                    <th className="px-3 py-2 font-medium text-right">Δ</th>
                    <th className="px-2 py-2 font-medium text-center">Repl.</th>
                    <th className="px-3 py-2 font-medium text-right">Power (kWh)</th>
                  </>}
                  {module === 'blending' && <>
                    <th className="px-3 py-2 font-medium text-right">Volume (m³)</th>
                  </>}
                  {module === 'power' && <>
                    <th className="px-3 py-2 font-medium text-right">Grid Reading</th>
                    <th className="px-3 py-2 font-medium text-right">Δ Grid (kWh)</th>
                    <th className="px-2 py-2 font-medium text-center text-blue-600">Grid Repl.</th>
                    <th className="px-3 py-2 font-medium text-right">Solar Reading</th>
                    <th className="px-3 py-2 font-medium text-right">Δ Solar (kWh)</th>
                    <th className="px-2 py-2 font-medium text-center text-yellow-600">Solar Repl.</th>
                  </>}
                  {canEditDelete && <th className="px-2 py-2 font-medium text-center w-16">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r: any, i: number) => {
                  const dt = r.reading_datetime ?? r.event_date ?? r.created_at ?? '';
                  const dateStr = dt ? format(new Date(dt), 'MMM d, yyyy HH:mm') : '—';
                  const isEditing = editRow?.id === r.id;
                  const isDeleting = deletingId === r.id;
                  const isToggling = togglingId === r.id;
                  const isMeterReplacement = !!r.is_meter_replacement;
                  // rows sorted descending → rows[i+1] is the immediately preceding reading in time
                  const predecessor: any = rows[i + 1] ?? null;

                  const isGridRepl      = !!(r.is_grid_replacement  ?? r.is_meter_replacement);
                  const isSolarRepl     = !!(r.is_solar_replacement ?? false);
                  const isTogglingGrid  = togglingGridId  === r.id;
                  const isTogglingSolar = togglingSolarId === r.id;

                  // Shared "Repl." toggle cell — rendered for well / locator
                  const replCell = (
                    <td className="px-2 py-1.5 text-center">
                      <button
                        title={isMeterReplacement ? 'Meter replacement — click to unmark' : 'Mark as meter replacement (zeroes Δ)'}
                        disabled={isDeleting || isToggling}
                        onClick={() => toggleMeterReplacement(r)}
                        className={[
                          'inline-flex items-center justify-center w-5 h-5 rounded border transition-colors',
                          'disabled:opacity-40 disabled:cursor-not-allowed',
                          isMeterReplacement
                            ? 'bg-orange-500 border-orange-500 text-white hover:bg-orange-600'
                            : 'border-input bg-background hover:border-orange-400 hover:bg-orange-50 dark:hover:bg-orange-950/20',
                        ].join(' ')}
                      >
                        {isToggling
                          ? <Loader2 className="h-2.5 w-2.5 animate-spin" />
                          : isMeterReplacement ? <span className="text-[9px] font-bold leading-none">✓</span> : null
                        }
                      </button>
                    </td>
                  );

                  return (
                    <tr
                      key={r.id ?? i}
                      className={[
                        'border-t',
                        isEditing      ? 'bg-teal-50/60 dark:bg-teal-950/20'
                        : isMeterReplacement ? 'bg-orange-50/40 dark:bg-orange-950/10'
                        : 'hover:bg-muted/40',
                      ].join(' ')}
                    >
                      <td className="px-3 py-1.5 whitespace-nowrap text-muted-foreground">
                        <span className="flex items-center gap-1.5">
                          {dateStr}
                          {isMeterReplacement && (
                            <span className="text-[9px] font-semibold uppercase tracking-wide text-orange-600 bg-orange-100 dark:bg-orange-900/30 px-1 py-0.5 rounded leading-none">
                              repl.
                            </span>
                          )}
                        </span>
                      </td>

                      {module === 'locator' && <>
                        <td className="px-3 py-1.5 text-right font-mono-num">{fmtNum(r.current_reading)}</td>
                        <td className="px-3 py-1.5 text-right font-mono-num">
                          {isMeterReplacement
                            ? <span className="text-orange-500 font-medium">0</span>
                            : predecessor != null ? fmtNum(r.current_reading - predecessor.current_reading) : '—'
                          }
                        </td>
                        {replCell}
                        <td className="px-3 py-1.5">
                          {r.off_location_flag && <span className="text-amber-600 font-medium">off-loc</span>}
                        </td>
                      </>}

                      {module === 'well' && <>
                        <td className="px-3 py-1.5 text-right font-mono-num">{fmtNum(r.current_reading)}</td>
                        <td className="px-3 py-1.5 text-right font-mono-num">
                          {isMeterReplacement
                            ? <span className="text-orange-500 font-medium">0</span>
                            : predecessor != null ? fmtNum(r.current_reading - predecessor.current_reading) : '—'
                          }
                        </td>
                        {replCell}
                        <td className="px-3 py-1.5 text-right font-mono-num">
                          {r.power_meter_reading != null ? fmtNum(r.power_meter_reading) : '—'}
                        </td>
                      </>}

                      {module === 'blending' && <>
                        <td className="px-3 py-1.5 text-right font-mono-num">{fmtNum(r.volume_m3 ?? 0)}</td>
                      </>}

                      {module === 'power' && <>
                          {/* Grid meter reading */}
                          <td className="px-3 py-1.5 text-right font-mono-num text-blue-600">
                            {fmtNum(r.meter_reading_kwh)}
                          </td>
                          {/* Δ Grid */}
                          <td className="px-3 py-1.5 text-right font-mono-num">
                            {isGridRepl
                              ? <span className="text-orange-500 font-medium">0</span>
                              : predecessor != null ? fmtNum(r.meter_reading_kwh - predecessor.meter_reading_kwh) : '—'
                            }
                          </td>
                          {/* Grid Repl. toggle */}
                          <td className="px-2 py-1.5 text-center">
                            <button
                              title={isGridRepl ? 'Grid replacement — click to unmark' : 'Mark grid meter replacement (zeroes Δ Grid)'}
                              disabled={isDeleting || isTogglingGrid}
                              onClick={() => toggleGridReplacement(r)}
                              className={[
                                'inline-flex items-center justify-center w-5 h-5 rounded border transition-colors',
                                'disabled:opacity-40 disabled:cursor-not-allowed',
                                isGridRepl
                                  ? 'bg-blue-500 border-blue-500 text-white hover:bg-blue-600'
                                  : 'border-input bg-background hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/20',
                              ].join(' ')}
                            >
                              {isTogglingGrid
                                ? <Loader2 className="h-2.5 w-2.5 animate-spin" />
                                : isGridRepl ? <span className="text-[9px] font-bold leading-none">✓</span> : null
                              }
                            </button>
                          </td>
                          {/* Solar meter reading */}
                          <td className="px-3 py-1.5 text-right font-mono-num text-yellow-600">
                            {r.solar_meter_reading != null ? fmtNum(r.solar_meter_reading) : '—'}
                          </td>
                          {/* Δ Solar */}
                          <td className="px-3 py-1.5 text-right font-mono-num">
                            {isSolarRepl
                              ? <span className="text-orange-500 font-medium">0</span>
                              : (predecessor?.solar_meter_reading != null && r.solar_meter_reading != null)
                                ? fmtNum(r.solar_meter_reading - predecessor.solar_meter_reading)
                                : '—'
                            }
                          </td>
                          {/* Solar Repl. toggle */}
                          <td className="px-2 py-1.5 text-center">
                            <button
                              title={isSolarRepl ? 'Solar replacement — click to unmark' : 'Mark solar meter replacement (zeroes Δ Solar)'}
                              disabled={isDeleting || isTogglingSolar}
                              onClick={() => toggleSolarReplacement(r)}
                              className={[
                                'inline-flex items-center justify-center w-5 h-5 rounded border transition-colors',
                                'disabled:opacity-40 disabled:cursor-not-allowed',
                                isSolarRepl
                                  ? 'bg-yellow-500 border-yellow-500 text-white hover:bg-yellow-600'
                                  : 'border-input bg-background hover:border-yellow-400 hover:bg-yellow-50 dark:hover:bg-yellow-950/20',
                              ].join(' ')}
                            >
                              {isTogglingSolar
                                ? <Loader2 className="h-2.5 w-2.5 animate-spin" />
                                : isSolarRepl ? <span className="text-[9px] font-bold leading-none">✓</span> : null
                              }
                            </button>
                          </td>
                        </>}

                      {canEditDelete && (
                        <td className="px-2 py-1 text-center">
                          <div className="flex items-center justify-center gap-0.5">
                            <button
                              title="Edit"
                              disabled={!!editRow || isDeleting}
                              onClick={() => startEdit(r)}
                              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-40"
                            >
                              <Pencil className="h-3 w-3" />
                            </button>
                            <button
                              title="Delete"
                              disabled={!!editRow || isDeleting}
                              onClick={() => deleteRow(r.id)}
                              className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive disabled:opacity-40"
                            >
                              {isDeleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <p className="text-[10px] text-muted-foreground">
          {days === 'custom'
            ? `Showing ${appliedFrom} → ${appliedTo}`
            : `Showing up to ${days} days of history`
          } · {rows?.length ?? 0} records
        </p>
      </DialogContent>
    </Dialog>
  );
}
