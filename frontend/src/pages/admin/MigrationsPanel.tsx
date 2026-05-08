import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from '@/components/ui/sonner';
import {
  Database, Copy, CheckCircle2, AlertTriangle, Loader2, ChevronDown, ChevronUp,
  RefreshCcw, FileCode, Download, ExternalLink, Search, Trash2,
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';

// ---------------------------------------------------------------------------
// Migrations panel — Admin-only. Probes the live Supabase schema against the
// SQL files in supabase/migrations/ and offers a copy-to-clipboard for any
// pending file so the Admin can paste it into the Supabase SQL editor.
// ---------------------------------------------------------------------------

interface MigrationExpectedColumn {
  column: string;
  exists: boolean;
}
interface MigrationProbeTable {
  name: string;
  exists: boolean;
  expected_columns?: MigrationExpectedColumn[];
  missing_columns?: string[];
  present_columns?: string[];
  expected_count?: number;
}
interface MigrationProbeColumn {
  table: string;
  column: string;
  exists: boolean;
}
interface MigrationOverride {
  marked_at: string;
  by_user_id: string | null;
  by_label: string | null;
  note: string | null;
}
interface MigrationApplyHistory {
  applied_at: string | null;
  by_label: string | null;
  note: string | null;
  source: string | null;
}
interface MigrationFile {
  filename: string;
  size: number;
  sha256?: string;
  status: 'applied' | 'pending' | 'partial' | 'indeterminate';
  probed_status?: 'applied' | 'pending' | 'partial' | 'indeterminate';
  manual_override?: MigrationOverride | null;
  override_applied?: boolean;
  // Permanent record of when this file was first marked applied locally,
  // preserved across override-purge cleanups. Null for files never run
  // through the override flow (we don't fabricate a timestamp we don't know).
  apply_history?: MigrationApplyHistory | null;
  table_probes: MigrationProbeTable[];
  column_probes: MigrationProbeColumn[];
  added_column_probes?: MigrationProbeColumn[];
  sql: string;
}
interface MigrationsResponse {
  migrations_dir: string;
  summary: {
    total: number;
    applied: number;
    pending: number;
    partial: number;
    indeterminate: number;
  };
  files: MigrationFile[];
  // Filenames whose manual override was auto-removed this fetch because the
  // probe now confirms the migration is applied for real. The frontend uses
  // this to surface a one-time confirmation toast on explicit Re-check.
  purged_overrides?: string[];
}

// localStorage key for the per-file SHA snapshot the user has acknowledged.
// We compare each fresh response against this snapshot to flag files whose
// on-disk content changed since the user last hit Re-check (i.e. potentially
// stale relative to a previously-downloaded bundle).
const MIGRATIONS_SHA_KEY = 'pwri:migration-shas-v1';

export function MigrationsPanel() {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [showApplied, setShowApplied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [seenShas, setSeenShas] = useState<Record<string, string>>(() => {
    // Stored data is non-sensitive: SHA-256 hashes of public migration
    // files the admin has acknowledged downloading. localStorage is
    // appropriate (no auth/PII here) and the catch swallows quota /
    // private-mode errors silently because the worst case is the user
    // sees the "new since last visit" badge once more.
    try {
      const raw = localStorage.getItem(MIGRATIONS_SHA_KEY);
      return raw ? (JSON.parse(raw) as Record<string, string>) : {};
    } catch (readErr) {
      console.warn('[Admin] failed to read seen migration SHAs:', readErr);
      return {};
    }
  });

  const persistShas = (next: Record<string, string>) => {
    setSeenShas(next);
    try {
      localStorage.setItem(MIGRATIONS_SHA_KEY, JSON.stringify(next));
    } catch (writeErr) {
      // Quota / private-mode — non-fatal, the dot indicator just won't persist.
      console.warn('[Admin] failed to persist seen migration SHAs:', writeErr);
    }
  };

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['admin-migrations-status'],
    queryFn: async () => {
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      if (!token) throw new Error('Sign in required');
      const base = (import.meta.env.REACT_APP_BACKEND_URL as string) || '';
      const res = await fetch(`${base}/api/admin/migrations/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Migrations probe failed: ${res.status} ${body}`);
      }
      return (await res.json()) as MigrationsResponse;
    },
  });

  const copySql = async (filename: string, sql: string) => {
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(filename);
      toast.success(`Copied ${filename} — paste into Supabase SQL editor.`);
      setTimeout(() => setCopied((c) => (c === filename ? null : c)), 2500);
    } catch (e: any) {
      toast.error(`Copy failed: ${e?.message ?? e}`);
    }
  };

  // The probe is the source of truth here — we deliberately skip files marked
  // applied via manual override (probe=pending but user said "I ran it") so
  // the bundle only contains SQL that genuinely still needs to run.
  // Partial files are included on the assumption that all our migrations use
  // `if not exists` / `drop … if exists` guards, so re-running is idempotent.
  // Indeterminate files (no probe-able statements at all) are excluded — we
  // can't know whether they need to run, and the user should mark those by hand.
  const pendingFiles = useMemo(() => {
    return (data?.files ?? []).filter(
      (f) => f.probed_status === 'pending' || f.probed_status === 'partial',
    );
  }, [data]);

  // Map of {filename: sha256} for the files in the most recent fetch.
  const currentShas = useMemo(() => {
    const out: Record<string, string> = {};
    for (const f of data?.files ?? []) {
      if (f.sha256) out[f.filename] = f.sha256;
    }
    return out;
  }, [data]);

  // First-ever load: silently capture the current snapshot so we don't show a
  // "modified" pill for every file just because the user has never used the
  // panel before. After this point, drift is only flagged when something
  // actually changes between Re-checks.
  useEffect(() => {
    if (!data) return;
    if (Object.keys(seenShas).length === 0 && Object.keys(currentShas).length > 0) {
      persistShas(currentShas);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const driftCount = useMemo(() => {
    let n = 0;
    for (const [name, sha] of Object.entries(currentShas)) {
      if (seenShas[name] && seenShas[name] !== sha) n += 1;
    }
    return n;
  }, [currentShas, seenShas]);

  const handleRecheck = async () => {
    const result = await refetch();
    // Acknowledge the freshly-fetched state so the "modified" pills clear.
    const fresh: Record<string, string> = {};
    for (const f of result.data?.files ?? []) {
      if (f.sha256) fresh[f.filename] = f.sha256;
    }
    if (Object.keys(fresh).length > 0) persistShas(fresh);

    // Surface auto-cleanup so the user knows the override store was tidied
    // up (otherwise the override silently disappears and they'd wonder
    // whether their earlier Mark-applied click actually registered).
    const purged = result.data?.purged_overrides ?? [];
    if (purged.length > 0) {
      const list = purged.length <= 3
        ? purged.join(', ')
        : `${purged.slice(0, 3).join(', ')} +${purged.length - 3} more`;
      toast.success(
        `Cleaned up ${purged.length} stale override${purged.length === 1 ? '' : 's'} ` +
        `(probe now confirms applied): ${list}`,
      );
    }
  };

  // Build a deep link to the Supabase Dashboard SQL editor for this project.
  // We prefer the explicit VITE_SUPABASE_PROJECT_ID (already in .env), and
  // fall back to extracting the subdomain from VITE_SUPABASE_URL — handy if
  // someone forgets to set the project-id var in a new environment.
  // Returns null when neither is configured (button is then hidden rather
  // than producing a broken supabase.com/dashboard/project//sql/new link).
  const supabaseSqlEditorUrl = useMemo<string | null>(() => {
    const explicit = import.meta.env.VITE_SUPABASE_PROJECT_ID as string | undefined;
    let ref = explicit?.trim() || '';
    if (!ref) {
      const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() || '';
      const m = url.match(/^https?:\/\/([a-z0-9-]+)\.supabase\.co/i);
      if (m) ref = m[1];
    }
    if (!ref) return null;
    return `https://supabase.com/dashboard/project/${ref}/sql/new`;
  }, []);

  // Copy SQL to clipboard, then open the Supabase SQL editor in a new tab.
  // We do the copy first so the open-in-new-tab user-gesture isn't broken by
  // a slow clipboard write, and we toast either way so the user knows what
  // landed in their clipboard before the editor finishes loading.
  const openInSupabase = async (filename: string, sql: string) => {
    if (!supabaseSqlEditorUrl) return;
    try {
      await navigator.clipboard.writeText(sql);
      toast.success(`Copied ${filename} — paste into the Supabase SQL editor that just opened`);
    } catch {
      toast.message(`Opening Supabase SQL editor — copy ${filename}'s SQL manually from the panel`);
    }
    window.open(supabaseSqlEditorUrl, '_blank', 'noopener,noreferrer');
  };

  // Build the concatenated SQL bundle for the current pending/partial set.
  // Returned as { text, sizeKb } so the caller can decide whether to push it
  // to clipboard (copyAllPending) or download it as a file (downloadAllPending).
  const buildPendingBundle = (): { text: string; sizeKb: string } | null => {
    if (pendingFiles.length === 0) return null;
    const stamp = new Date().toISOString();
    const header = [
      '-- ============================================================',
      `-- PWRI Monitoring · pending Supabase migrations bundle`,
      `-- Generated: ${stamp}`,
      `-- Files: ${pendingFiles.length}`,
      '-- Paste into Supabase Dashboard → SQL editor → Run.',
      '-- All bundled files use `if not exists` / `drop … if exists` guards,',
      '-- so re-running an already-applied file is safe.',
      '-- ============================================================',
      '',
    ].join('\n');
    const body = pendingFiles
      .map((f) => {
        const banner =
          `-- ===== ${f.filename} (${f.probed_status}) ` +
          '='.repeat(Math.max(0, 60 - f.filename.length - f.probed_status.length));
        const trailer = `-- ===== end ${f.filename} ` + '='.repeat(40);
        return `${banner}\n${f.sql.trimEnd()}\n${trailer}\n`;
      })
      .join('\n');
    const text = `${header}${body}`;
    return { text, sizeKb: (text.length / 1024).toFixed(1) };
  };

  const copyAllPending = async () => {
    const bundle = buildPendingBundle();
    if (!bundle) {
      toast.info('Nothing to copy — no pending or partial migrations.');
      return;
    }
    try {
      await navigator.clipboard.writeText(bundle.text);
      toast.success(
        `Copied ${pendingFiles.length} pending migration${
          pendingFiles.length === 1 ? '' : 's'
        } (${bundle.sizeKb} KB).`,
      );
    } catch (e: any) {
      toast.error(`Copy failed: ${e?.message ?? e}`);
    }
  };

  // Export the apply-history audit trail as a JSON file. Useful for
  // archiving "this migration ran in this environment at this time" without
  // granting Supabase Dashboard access, and for diff-ing two environments
  // (e.g. staging vs prod) to spot which migrations one ran but the other
  // hasn't. Only entries with a recorded apply event are included — files
  // applied via psql / dashboard without going through Mark-applied won't
  // appear, mirroring backend honesty about what we actually know.
  const downloadHistory = () => {
    const entries: Record<string, MigrationApplyHistory> = {};
    for (const f of data?.files ?? []) {
      if (f.apply_history?.applied_at) {
        entries[f.filename] = f.apply_history;
      }
    }
    const count = Object.keys(entries).length;
    if (count === 0) {
      toast.info('No apply-history entries to export yet.');
      return;
    }
    const payload = {
      exported_at: new Date().toISOString(),
      migrations_dir: data?.migrations_dir ?? null,
      history: entries,
    };
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');
    const filename = `pwri-migration-apply-history-${stamp}.json`;
    try {
      const text = JSON.stringify(payload, null, 2);
      const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Defer revoke so Safari has time to actually start the download.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success(
        `Exported ${count} apply-history entr${count === 1 ? 'y' : 'ies'} → ${filename}`,
      );
    } catch (e: any) {
      toast.error(`Export failed: ${e?.message ?? e}`);
    }
  };

  // True iff at least one file has a recorded apply event — used to gate
  // visibility of the Export-history button so we don't offer a download
  // that would just produce {history: {}}.
  const hasAnyHistory = useMemo(
    () => (data?.files ?? []).some((f) => !!f.apply_history?.applied_at),
    [data],
  );

  // Hidden <input type="file"> the Import-history button programmatically
  // clicks. Lives in state so we can keep the input mounted (and reset
  // .value after each pick so picking the same file twice in a row still
  // fires onChange).
  const [importing, setImporting] = useState(false);

  const handleImportHistoryFile = async (file: File) => {
    setImporting(true);
    try {
      const text = await file.text();
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        toast.error('Selected file is not valid JSON.');
        return;
      }
      // Accept both the export format ({history: {...}}) and a bare history
      // map ({...}) so users who copy-paste fragments still succeed.
      const historyObj = parsed?.history ?? parsed;
      if (!historyObj || typeof historyObj !== 'object' || Array.isArray(historyObj)) {
        toast.error('Imported file must contain a "history" object keyed by filename.');
        return;
      }

      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        toast.error('Not signed in.');
        return;
      }
      const BASE = (import.meta.env.REACT_APP_BACKEND_URL as string) || '';
      const res = await fetch(`${BASE}/api/admin/migrations/apply-history/import`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ history: historyObj, mode: 'fill_gaps' }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        toast.error(`Import failed (${res.status}): ${detail.slice(0, 200)}`);
        return;
      }
      const out = await res.json();
      const added = (out.added ?? []).length;
      const skipExist = (out.skipped_existing ?? []).length;
      const skipUnk = (out.skipped_unknown ?? []).length;
      const skipBad = (out.skipped_invalid ?? []).length;
      const parts = [
        `${added} added`,
        skipExist > 0 ? `${skipExist} skipped (already recorded)` : null,
        skipUnk > 0 ? `${skipUnk} skipped (unknown filename)` : null,
        skipBad > 0 ? `${skipBad} skipped (invalid)` : null,
      ].filter(Boolean).join(' · ');
      if (added > 0) toast.success(`Imported apply-history: ${parts}`);
      else toast.info(`Nothing new imported: ${parts || 'all entries were already present'}`);
      // Refetch so the new "applied locally" pills appear immediately.
      await refetch();
    } catch (e: any) {
      toast.error(`Import failed: ${e?.message ?? e}`);
    } finally {
      setImporting(false);
    }
  };

  // Save the same bundle as a versioned .sql file. Filenames embed an
  // ISO-style timestamp (no colons — Windows-friendly) so multiple runs
  // don't overwrite each other and you have a clear audit trail of exactly
  // what was pasted into Supabase, when, and by which session.
  const downloadAllPending = () => {
    const bundle = buildPendingBundle();
    if (!bundle) {
      toast.info('Nothing to download — no pending or partial migrations.');
      return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');
    const filename = `pwri-pending-migrations-${stamp}.sql`;
    try {
      const blob = new Blob([bundle.text], { type: 'application/sql;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Defer revoke so Safari has time to actually start the download.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success(
        `Downloaded ${filename} (${pendingFiles.length} file${
          pendingFiles.length === 1 ? '' : 's'
        }, ${bundle.sizeKb} KB).`,
      );
    } catch (e: any) {
      toast.error(`Download failed: ${e?.message ?? e}`);
    }
  };

  const markApplied = async (filename: string) => {
    const note = window.prompt(
      `Mark "${filename}" as applied?\n\nUse this for migrations the schema probe can't verify (RPCs, one-shot UPDATEs, pure DML).\n\nOptional note (e.g. "ran in Supabase SQL editor on 2026-04-25"):`,
      '',
    );
    if (note === null) return; // user cancelled
    try {
      setBusy(filename);
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      if (!token) throw new Error('Sign in required');
      const base = (import.meta.env.REACT_APP_BACKEND_URL as string) || '';
      const res = await fetch(
        `${base}/api/admin/migrations/${encodeURIComponent(filename)}/mark-applied`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ note: note || null }),
        },
      );
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      toast.success(`Marked ${filename} as applied.`);
      await refetch();
    } catch (e: any) {
      toast.error(`Mark failed: ${e?.message ?? e}`);
    } finally {
      setBusy(null);
    }
  };

  const unmarkApplied = async (filename: string) => {
    if (!window.confirm(`Remove the applied mark for "${filename}"?`)) return;
    try {
      setBusy(filename);
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      if (!token) throw new Error('Sign in required');
      const base = (import.meta.env.REACT_APP_BACKEND_URL as string) || '';
      const res = await fetch(
        `${base}/api/admin/migrations/${encodeURIComponent(filename)}/mark-applied`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      toast.success(`Cleared mark for ${filename}.`);
      await refetch();
    } catch (e: any) {
      toast.error(`Unmark failed: ${e?.message ?? e}`);
    } finally {
      setBusy(null);
    }
  };

  // Free-text filename filter — case-insensitive substring match against
  // the bare filename (no path). Persists nothing; resets whenever the
  // panel unmounts. Use sparingly: small migration sets don't need it,
  // but it pays off once the directory grows past a screenful.
  const [nameFilter, setNameFilter] = useState('');

  const visibleFiles = useMemo(() => {
    if (!data?.files) return [];
    let rows = showApplied ? data.files : data.files.filter((f) => f.status !== 'applied');
    const q = nameFilter.trim().toLowerCase();
    if (q) rows = rows.filter((f) => f.filename.toLowerCase().includes(q));
    return rows;
  }, [data, showApplied, nameFilter]);

  // Total visible BEFORE the name filter — so we can render
  // "showing N of M" without confusing "M" with "all files in repo".
  const visibleBeforeFilter = useMemo(() => {
    if (!data?.files) return 0;
    return showApplied
      ? data.files.length
      : data.files.filter((f) => f.status !== 'applied').length;
  }, [data, showApplied]);

  const STATUS_META: Record<MigrationFile['status'], { label: string; className: string; Icon: any }> = {
    applied:       { label: 'Applied',       className: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/40', Icon: CheckCircle2 },
    pending:       { label: 'Pending',       className: 'bg-rose-500/15 text-rose-700 border-rose-500/40',          Icon: AlertTriangle },
    partial:       { label: 'Partial',       className: 'bg-amber-500/15 text-amber-700 border-amber-500/40',       Icon: AlertTriangle },
    indeterminate: { label: 'Indeterminate', className: 'bg-zinc-500/15 text-zinc-700 border-zinc-500/40',          Icon: FileCode },
  };

  return (
    <div className="space-y-3" data-testid="admin-migrations-panel">
      <Card className="p-3 text-xs space-y-2">
        <div className="flex items-start gap-2">
          <Database className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
          <div className="flex-1">
            <div className="font-medium">Supabase migrations status</div>
            <div className="text-muted-foreground">
              Scans <code>supabase/migrations/*.sql</code> and probes your Supabase
              project for the tables / columns each file should have created.
              Pending or partial files include the exact SQL to paste into the
              Supabase Dashboard → SQL editor.
            </div>
          </div>
        </div>
        {data && (
          <div className="flex flex-wrap gap-2 items-center pt-1">
            <Badge variant="outline" className="bg-emerald-500/10 text-emerald-700">
              {data.summary.applied} applied
            </Badge>
            {data.summary.pending > 0 && (
              <Badge variant="outline" className="bg-rose-500/10 text-rose-700">
                {data.summary.pending} pending
              </Badge>
            )}
            {data.summary.partial > 0 && (
              <Badge variant="outline" className="bg-amber-500/10 text-amber-700">
                {data.summary.partial} partial
              </Badge>
            )}
            {data.summary.indeterminate > 0 && (
              <Badge variant="outline" className="bg-zinc-500/10 text-zinc-700">
                {data.summary.indeterminate} indeterminate
              </Badge>
            )}
            {driftCount > 0 && (
              <Badge
                variant="outline"
                className="bg-amber-500/15 text-amber-700 border-amber-500/40"
                title={
                  `${driftCount} migration file${driftCount === 1 ? '' : 's'} ` +
                  `changed on disk since the last Re-check. ` +
                  `Re-download the bundle before pasting into Supabase, ` +
                  `then click Re-check to acknowledge.`
                }
                data-testid="migrations-drift-count"
              >
                <AlertTriangle className="h-2.5 w-2.5 mr-1" />
                {driftCount} modified since last check
              </Badge>
            )}
            <span className="text-[11px] text-muted-foreground">
              · {data.summary.total} total
            </span>
            <div className="ml-auto flex items-center gap-2 flex-wrap">
              <div className="relative">
                <Search className="h-3 w-3 text-muted-foreground absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="search"
                  placeholder="Filter filenames…"
                  value={nameFilter}
                  onChange={(e) => setNameFilter(e.target.value)}
                  className="h-7 pl-6 pr-2 text-[11px] rounded-md border bg-background w-44 focus:outline-none focus:ring-1 focus:ring-ring"
                  title="Case-insensitive substring match against filename"
                  data-testid="migrations-name-filter"
                />
                {nameFilter && (
                  <button
                    type="button"
                    onClick={() => setNameFilter('')}
                    className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-[14px] leading-none px-1"
                    title="Clear filter"
                    data-testid="migrations-name-filter-clear"
                  >
                    ×
                  </button>
                )}
              </div>
              <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer">
                <Checkbox
                  checked={showApplied}
                  onCheckedChange={(v) => setShowApplied(!!v)}
                  data-testid="migrations-show-applied"
                />
                Show applied
              </label>
              <Button
                size="sm" variant="outline" className="h-7"
                disabled={pendingFiles.length === 0}
                onClick={copyAllPending}
                title={
                  pendingFiles.length === 0
                    ? 'No pending or partial migrations to bundle'
                    : `Copy ${pendingFiles.length} file(s) as one paste-able SQL bundle`
                }
                data-testid="migrations-copy-all"
              >
                <Copy className="h-3 w-3 mr-1" />
                Copy all pending ({pendingFiles.length})
              </Button>
              <Button
                size="sm" variant="outline" className="h-7"
                disabled={pendingFiles.length === 0}
                onClick={downloadAllPending}
                title={
                  pendingFiles.length === 0
                    ? 'No pending or partial migrations to bundle'
                    : `Save ${pendingFiles.length} file(s) as a versioned .sql backup`
                }
                data-testid="migrations-download-all"
              >
                <Download className="h-3 w-3 mr-1" />
                Download .sql
              </Button>
              {hasAnyHistory && (
                <Button
                  size="sm" variant="outline" className="h-7"
                  onClick={downloadHistory}
                  title="Export the apply-history audit trail as a JSON file (one entry per migration that has been marked applied locally)"
                  data-testid="migrations-export-history"
                >
                  <Download className="h-3 w-3 mr-1" />
                  Export history
                </Button>
              )}
              <label
                className={`inline-flex items-center h-7 px-3 text-[12px] rounded-md border bg-background hover:bg-muted cursor-pointer ${
                  importing ? 'opacity-60 pointer-events-none' : ''
                }`}
                title="Import a previously-exported apply-history JSON. Non-destructive: local entries always win on conflict."
                data-testid="migrations-import-history-label"
              >
                {importing
                  ? <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  : <Database className="h-3 w-3 mr-1" />}
                Import history
                <input
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  data-testid="migrations-import-history-input"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    // Reset .value so picking the same file twice still
                    // triggers onChange (browsers dedupe identical paths).
                    e.target.value = '';
                    if (file) handleImportHistoryFile(file);
                  }}
                />
              </label>
              <Button
                size="sm" variant="outline" className="h-7"
                disabled={isFetching}
                onClick={handleRecheck}
                data-testid="migrations-refresh"
              >
                {isFetching
                  ? <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  : <RefreshCcw className="h-3 w-3 mr-1" />}
                Re-check
              </Button>
            </div>
          </div>
        )}
      </Card>

      {isLoading && (
        <Card className="p-4 text-center text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 mx-auto animate-spin mb-1" />
          Probing live Supabase schema…
        </Card>
      )}

      {!isLoading && visibleFiles.length === 0 && data && (
        <Card className="p-4 text-center text-xs text-muted-foreground">
          {nameFilter
            ? <>No files match <code className="font-mono">{nameFilter}</code>.{' '}
                <button
                  type="button"
                  className="underline hover:text-foreground"
                  onClick={() => setNameFilter('')}
                >
                  Clear filter
                </button></>
            : data.summary.pending + data.summary.partial === 0
              ? 'All migrations already applied. Toggle "Show applied" to see the full history.'
              : 'No files match the current filter.'}
        </Card>
      )}

      {nameFilter && visibleFiles.length > 0 && data && (
        <div className="text-[11px] text-muted-foreground px-1">
          Showing <strong className="text-foreground">{visibleFiles.length}</strong> of{' '}
          <strong className="text-foreground">{visibleBeforeFilter}</strong>
          {visibleBeforeFilter !== data.summary.total && (
            <> visible ({data.summary.total} total in repo)</>
          )}
          {' '}— filtered by <code className="font-mono">{nameFilter}</code>
        </div>
      )}

      <div className="space-y-2">
        {visibleFiles.map((f) => {
          const meta = STATUS_META[f.status];
          const isOpen = !!expanded[f.filename];
          const wasCopied = copied === f.filename;
          return (
            <Card
              key={f.filename}
              className={`p-3 border-l-4 ${
                f.status === 'pending'
                  ? 'border-l-rose-500/70'
                  : f.status === 'partial'
                    ? 'border-l-amber-500/70'
                    : f.status === 'applied'
                      ? 'border-l-emerald-500/60 opacity-90'
                      : 'border-l-zinc-300'
              }`}
              data-testid={`migration-${f.filename}`}
            >
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <FileCode className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <code className="text-xs font-mono truncate">{f.filename}</code>
                  <Badge variant="outline" className={`text-[10px] ${meta.className}`}>
                    <meta.Icon className="h-2.5 w-2.5 mr-1" />
                    {meta.label}
                  </Badge>
                  {(() => {
                    const seen = f.sha256 ? seenShas[f.filename] : undefined;
                    const drifted = !!(seen && f.sha256 && seen !== f.sha256);
                    if (!drifted) return null;
                    return (
                      <Badge
                        variant="outline"
                        className="text-[10px] bg-amber-500/15 text-amber-700 border-amber-500/40"
                        title={
                          `On-disk content changed since last Re-check.\n` +
                          `was: ${seen?.slice(0, 12)}…\n` +
                          `now: ${f.sha256?.slice(0, 12)}…\n` +
                          `Re-download the bundle before pasting into Supabase.`
                        }
                        data-testid={`migration-drift-${f.filename}`}
                      >
                        <AlertTriangle className="h-2.5 w-2.5 mr-1" />
                        modified since last check
                      </Badge>
                    );
                  })()}
                  {(() => {
                    // Show "applied locally <relative>" on probe-confirmed
                    // applied files when we have a recorded apply event in
                    // history. Hidden when an override is currently active
                    // (the override line below already shows that timestamp,
                    // and we don't want two timestamp pills competing).
                    const h = f.apply_history;
                    if (!h?.applied_at) return null;
                    if (f.override_applied) return null;
                    if (f.probed_status !== 'applied') return null;
                    const when = new Date(h.applied_at);
                    if (Number.isNaN(when.getTime())) return null;
                    const rel = formatDistanceToNow(when, { addSuffix: true });
                    const abs = format(when, 'yyyy-MM-dd HH:mm');
                    return (
                      <Badge
                        variant="outline"
                        className="text-[10px] bg-emerald-500/5 text-emerald-700 border-emerald-500/30 font-mono"
                        title={
                          `First marked applied locally at ${abs} (local time)` +
                          (h.by_label ? ` by ${h.by_label}` : '') +
                          (h.note ? `\nNote: "${h.note}"` : '') +
                          `\nOriginal manual override has since been auto-purged ` +
                          `because the live probe now confirms the migration.`
                        }
                        data-testid={`migration-applied-locally-${f.filename}`}
                      >
                        applied {rel}
                      </Badge>
                    );
                  })()}
                  <span className="text-[10px] text-muted-foreground">
                    {(f.size / 1024).toFixed(1)} KB
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {f.probed_status !== 'applied' && (
                    <Button
                      size="sm" variant="outline" className="h-7 text-[11px]"
                      onClick={() => copySql(f.filename, f.sql)}
                      data-testid={`migration-copy-${f.filename}`}
                    >
                      {wasCopied
                        ? <><CheckCircle2 className="h-3 w-3 mr-1 text-emerald-600" /> Copied</>
                        : <><Copy className="h-3 w-3 mr-1" /> Copy SQL</>}
                    </Button>
                  )}
                  {f.probed_status !== 'applied' && supabaseSqlEditorUrl && (
                    <Button
                      size="sm" variant="outline" className="h-7 text-[11px]"
                      onClick={() => openInSupabase(f.filename, f.sql)}
                      title="Copy this file's SQL and open the Supabase SQL editor in a new tab"
                      data-testid={`migration-open-supabase-${f.filename}`}
                    >
                      <ExternalLink className="h-3 w-3 mr-1" />
                      Open in Supabase
                    </Button>
                  )}
                  {f.override_applied ? (
                    <Button
                      size="sm" variant="outline" className="h-7 text-[11px]"
                      disabled={busy === f.filename}
                      onClick={() => unmarkApplied(f.filename)}
                      data-testid={`migration-unmark-${f.filename}`}
                    >
                      {busy === f.filename
                        ? <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                        : <Trash2 className="h-3 w-3 mr-1" />}
                      Clear mark
                    </Button>
                  ) : (
                    f.probed_status !== 'applied' && (
                      <Button
                        size="sm" variant="outline" className="h-7 text-[11px]"
                        disabled={busy === f.filename}
                        onClick={() => markApplied(f.filename)}
                        data-testid={`migration-mark-${f.filename}`}
                      >
                        {busy === f.filename
                          ? <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                          : <CheckCircle2 className="h-3 w-3 mr-1" />}
                        Mark applied
                      </Button>
                    )
                  )}
                  <Button
                    size="sm" variant="ghost" className="h-7 text-[11px]"
                    onClick={() => setExpanded((m) => ({ ...m, [f.filename]: !m[f.filename] }))}
                  >
                    {isOpen
                      ? <><ChevronUp className="h-3 w-3 mr-1" /> Hide</>
                      : <><ChevronDown className="h-3 w-3 mr-1" /> Details</>}
                  </Button>
                </div>
              </div>
              {f.override_applied && f.manual_override && (() => {
                // Defensive parse — older overrides without marked_at would
                // otherwise crash formatDistanceToNow with "Invalid time value".
                const marked = new Date(f.manual_override.marked_at);
                const validMarked = !Number.isNaN(marked.getTime());
                const absolute = validMarked
                  ? format(marked, 'yyyy-MM-dd HH:mm')
                  : 'unknown time';
                const relative = validMarked
                  ? formatDistanceToNow(marked, { addSuffix: true })
                  : '';
                return (
                  <div className="mt-1.5 text-[11px] text-muted-foreground italic flex items-center gap-1.5 flex-wrap">
                    <Badge variant="outline" className="bg-sky-500/10 text-sky-700 border-sky-400/40 text-[10px]">
                      manual override
                    </Badge>
                    {validMarked && (
                      <Badge
                        variant="outline"
                        className="bg-sky-500/5 text-sky-700 border-sky-400/30 text-[10px] not-italic font-mono"
                        title={`Marked applied at ${absolute} (local time)`}
                        data-testid={`migration-override-age-${f.filename}`}
                      >
                        {relative}
                      </Badge>
                    )}
                    Marked applied by <strong className="not-italic">{f.manual_override.by_label ?? 'admin'}</strong>
                    {' on '}
                    <span title={validMarked ? marked.toISOString() : undefined}>{absolute}</span>
                    {f.manual_override.note ? ` — "${f.manual_override.note}"` : ''}
                    {' · probe says '}
                    <code>{f.probed_status}</code>
                  </div>
                );
              })()}

              {(f.table_probes.length > 0 || f.column_probes.length > 0) && (
                <div className="mt-2 space-y-1.5">
                  {f.table_probes.map((p) => {
                    const expected = p.expected_columns ?? [];
                    const present = (p.present_columns ?? []).length;
                    const missing = (p.missing_columns ?? []).length;
                    const hasDrift = p.exists && missing > 0;
                    return (
                      <div
                        key={`t-${p.name}`}
                        className={`rounded-md border px-2 py-1.5 text-[11px] ${
                          !p.exists
                            ? 'bg-rose-500/5 border-rose-500/30'
                            : hasDrift
                              ? 'bg-amber-500/5 border-amber-500/30'
                              : 'bg-emerald-500/5 border-emerald-500/30'
                        }`}
                      >
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span
                            className={`text-[10px] rounded-full px-1.5 py-0.5 border ${
                              p.exists
                                ? 'bg-emerald-50 text-emerald-700 border-emerald-300 dark:bg-emerald-900/20 dark:text-emerald-200'
                                : 'bg-rose-50 text-rose-700 border-rose-300 dark:bg-rose-900/20 dark:text-rose-200'
                            }`}
                          >
                            table {p.name} {p.exists ? '✓ present' : '✗ missing'}
                          </span>
                          {expected.length > 0 && (
                            <span className="text-muted-foreground">
                              {p.exists
                                ? hasDrift
                                  ? `${present}/${expected.length} columns present · ${missing} missing`
                                  : `all ${expected.length} columns present`
                                : `would create ${expected.length} columns`}
                            </span>
                          )}
                        </div>
                        {hasDrift && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {(p.missing_columns ?? []).map((c) => (
                              <span
                                key={`m-${p.name}.${c}`}
                                className="text-[10px] rounded-full px-1.5 py-0.5 border bg-rose-50 text-rose-700 border-rose-300 dark:bg-rose-900/20 dark:text-rose-200"
                                title={`Column ${p.name}.${c} declared in this migration is not present in the live table`}
                              >
                                {p.name}.{c} ✗
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {f.column_probes.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-0.5">
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground self-center mr-1">
                        Added columns:
                      </span>
                      {f.column_probes.map((p) => (
                        <span
                          key={`c-${p.table}.${p.column}`}
                          className={`text-[10px] rounded-full px-1.5 py-0.5 border ${
                            p.exists
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-300 dark:bg-emerald-900/20 dark:text-emerald-200'
                              : 'bg-rose-50 text-rose-700 border-rose-300 dark:bg-rose-900/20 dark:text-rose-200'
                          }`}
                        >
                          {p.table}.{p.column} {p.exists ? '✓' : '✗'}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {isOpen && (
                <pre className="mt-2 p-2 rounded-md bg-muted/40 border text-[10px] font-mono overflow-auto max-h-72">
{f.sql}
                </pre>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
