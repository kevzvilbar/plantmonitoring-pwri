import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { usePlants } from '@/hooks/usePlants';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from '@/components/ui/sonner';
import { Sparkles, Loader2, Trash2, ChevronDown, ChevronUp } from 'lucide-react';

// Pre-curated names of plants known to have been imported by mistake via the
// Smart Import flow. The Admin can still edit/uncheck before running.
const SUGGESTED_BAD_IMPORTS = ['Mambaling 3', 'SRP MCWD'] as const;

const REASON_TEMPLATES: { label: string; value: string }[] = [
  { label: 'Smart import error', value: 'Smart importation error cleanup' },
  { label: 'Duplicate entry',    value: 'Duplicate plant entry — removing duplicate' },
  { label: 'Test data',          value: 'Test data created during onboarding' },
  { label: 'Wrong region',       value: 'Plant assigned to the wrong region — replaced' },
  { label: 'User request',       value: 'Removed at user request' },
];

export function BadImportCleanupCard() {
  const qc = useQueryClient();
  const { data: plants } = usePlants();

  // Default-tick the suggested ones if they actually exist in the DB.
  const initialSelection = useMemo<Set<string>>(() => {
    const existing = new Set((plants ?? []).map((p) => p.name));
    return new Set(SUGGESTED_BAD_IMPORTS.filter((n) => existing.has(n)));
  }, [plants]);

  const [selected, setSelected] = useState<Set<string>>(initialSelection);
  const [reason, setReason] = useState('Smart importation error cleanup');
  const [reasonExpanded, setReasonExpanded] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<null | {
    processed: { name: string; plant_id: string; deleted_counts: Record<string, number> }[];
    not_found: string[];
  }>(null);

  // Sync the auto-selected suggestion list with the latest plants query.
  // (Without this, a freshly-loaded plants list arrives after `selected`
  // has already been initialized to an empty set on first render.)
  if (
    selected.size === 0 &&
    initialSelection.size > 0 &&
    [...initialSelection].some((n) => !selected.has(n))
  ) {
    setTimeout(() => setSelected(initialSelection), 0);
  }

  const toggle = (name: string) => {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setSelected(next);
  };

  const filteredPlants = (plants ?? []).filter(
    (p) => SUGGESTED_BAD_IMPORTS.includes(p.name as any) || selected.has(p.name),
  );

  const reasonValid = reason.trim().length >= 5;
  const canRun = selected.size > 0 && reasonValid && !busy;

  const runCleanup = async () => {
    if (!canRun) return;
    setBusy(true);
    setLastResult(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      if (!token) throw new Error('Sign in as Admin first.');
      const base = (import.meta.env.REACT_APP_BACKEND_URL as string) || '';
      const res = await fetch(`${base}/api/admin/plants/cleanup`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ names: Array.from(selected), reason: reason.trim() }),
      });
      const json = await res.json();
      if (!res.ok) {
        const msg =
          typeof json?.detail === 'string' ? json.detail
          : typeof json?.detail === 'object' ? JSON.stringify(json.detail)
          : `HTTP ${res.status}`;
        throw new Error(msg);
      }
      const removed = (json.processed ?? []).length;
      const skipped = (json.not_found ?? []).length;
      setLastResult({
        processed: json.processed ?? [],
        not_found: json.not_found ?? [],
      });
      toast.success(
        `Cleanup complete — ${removed} plant${removed === 1 ? '' : 's'} removed${
          skipped ? `, ${skipped} skipped (not found)` : ''
        }.`,
      );
      // Bust caches that depend on plants.
      qc.invalidateQueries({ queryKey: ['plants'] });
      qc.invalidateQueries({ queryKey: ['plants-well-counts'] });
      qc.invalidateQueries({ queryKey: ['admin-audit-log'] });
      qc.invalidateQueries({ queryKey: ['staff'] });
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      setSelected(new Set());
      setConfirmOpen(false);
    } catch (e: any) {
      toast.error(e?.message ?? 'Cleanup failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      className="p-3 border-amber-500/30 bg-amber-500/5"
      data-testid="bad-import-cleanup-card"
    >
      <div className="flex items-start gap-2">
        <Sparkles className="h-4 w-4 mt-0.5 text-amber-600" />
        <div className="flex-1 min-w-0 space-y-2">
          <div>
            <h3 className="text-sm font-semibold">
              Cleanup imported-by-mistake plants
            </h3>
            <p className="text-[11px] text-muted-foreground">
              One-click hard-delete of plants imported in error via Smart Import.
              Removes the plant + all wells, locators, RO trains, readings, logs,
              and assignments. Each removal is recorded in the audit log with a{' '}
              <code className="text-[10px]">[CLEANUP]</code> tag.
            </p>
          </div>

          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">
              Plants to delete
            </Label>
            {filteredPlants.length === 0 && (
              <p className="text-xs text-muted-foreground italic" data-testid="cleanup-no-targets">
                No suggested plants found in the database.
              </p>
            )}
            {filteredPlants.map((p) => (
              <label
                key={p.id}
                className="flex items-center gap-2 text-sm cursor-pointer rounded px-1 py-0.5 hover:bg-muted/40"
                data-testid={`cleanup-plant-row-${p.name}`}
              >
                <Checkbox
                  checked={selected.has(p.name)}
                  onCheckedChange={() => toggle(p.name)}
                  data-testid={`cleanup-checkbox-${p.name}`}
                />
                <span className="flex-1 truncate">{p.name}</span>
                <span className="text-[11px] text-muted-foreground truncate">
                  {p.address ?? '—'}
                </span>
              </label>
            ))}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-[11px] text-muted-foreground">
                Reason <span className="text-danger">*</span>{' '}
                <span className="text-[10px]">(min 5 chars — required for audit log)</span>
              </Label>
              <button
                type="button"
                onClick={() => setReasonExpanded((v) => !v)}
                className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5"
                data-testid="cleanup-reason-expand"
                aria-expanded={reasonExpanded}
              >
                {reasonExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                {reasonExpanded ? 'Compact' : 'Expand'}
              </button>
            </div>

            {/* Quick-select reason templates */}
            <div className="flex flex-wrap gap-1" data-testid="cleanup-reason-templates">
              {REASON_TEMPLATES.map((t) => {
                const active = reason.trim() === t.value;
                return (
                  <button
                    key={t.label}
                    type="button"
                    onClick={() => setReason(t.value)}
                    className={`text-[10px] rounded-full px-2 py-0.5 border transition-colors ${
                      active
                        ? 'bg-amber-500/20 border-amber-500/50 text-amber-800 dark:text-amber-200'
                        : 'bg-card hover:bg-muted/50 border-border text-muted-foreground'
                    }`}
                    data-testid={`cleanup-reason-template-${t.label}`}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>

            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={reasonExpanded ? 4 : 1}
              maxLength={500}
              placeholder="Pick a template above or type your own…"
              data-testid="cleanup-reason"
              aria-invalid={reason.length > 0 && !reasonValid}
              className={`text-xs resize-none ${reason.length > 0 && !reasonValid ? 'border-danger' : ''}`}
            />
            {reason.length > 0 && !reasonValid && (
              <p className="text-[10px] text-danger">
                Reason must be at least 5 characters ({reason.trim().length}/5).
              </p>
            )}

            {/* Audit preview — mirrors backend, which writes ONE row per plant
               with reason="[CLEANUP] <reason>" against entity_label=<plant>. */}
            {selected.size > 0 && reasonValid && (
              <div
                className="rounded-md bg-muted/40 border border-border/60 px-2 py-1.5 text-[10px] font-mono text-muted-foreground space-y-0.5"
                data-testid="cleanup-audit-preview"
              >
                <div className="text-[9px] uppercase tracking-wider text-muted-foreground/70 not-italic">
                  audit log preview ({selected.size} {selected.size === 1 ? 'entry' : 'entries'})
                </div>
                {Array.from(selected).map((n) => (
                  <div key={n} className="truncate">
                    <span className="text-foreground">{n}</span>
                    {' → reason: '}
                    <span className="text-foreground">[CLEANUP] {reason.trim()}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              className="border-danger text-danger hover:bg-danger/10"
              onClick={() => setConfirmOpen(true)}
              disabled={!canRun}
              data-testid="cleanup-run-btn"
            >
              <Trash2 className="h-3 w-3 mr-1" />
              Run cleanup ({selected.size})
            </Button>
          </div>

          {lastResult && (
            <div
              className="rounded-md border bg-card p-2 text-xs space-y-1"
              data-testid="cleanup-last-result"
            >
              <div className="font-semibold">Last cleanup summary</div>
              {lastResult.processed.map((p) => {
                const total = Object.values(p.deleted_counts).reduce(
                  (s, n) => s + (+n || 0), 0,
                );
                return (
                  <div key={p.plant_id} className="text-muted-foreground">
                    <strong className="text-foreground">{p.name}</strong> —{' '}
                    {total} row(s) removed across{' '}
                    {Object.keys(p.deleted_counts).length} table(s).
                  </div>
                );
              })}
              {lastResult.not_found.length > 0 && (
                <div className="text-amber-600">
                  Skipped (not found): {lastResult.not_found.join(', ')}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(o) => !o && !busy && setConfirmOpen(false)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-danger">
              Permanently delete {selected.size} plant
              {selected.size === 1 ? '' : 's'}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>This will hard-delete:</p>
                <ul className="list-disc ml-5 text-xs space-y-0.5">
                  {Array.from(selected).map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
                <div
                  className="rounded-md bg-muted/50 border border-border/60 px-2 py-1.5 text-[11px] font-mono text-muted-foreground space-y-0.5"
                  data-testid="cleanup-confirm-preview"
                >
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
                    audit log — {selected.size} {selected.size === 1 ? 'entry' : 'entries'}
                  </div>
                  {Array.from(selected).map((n) => (
                    <div key={n} className="truncate">
                      <span className="text-foreground">{n}</span>
                      {' → reason: '}
                      <span className="text-foreground">[CLEANUP] {reason.trim()}</span>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Every well, locator, RO train, reading, replacement log, and
                  user-plant assignment for these plants will be removed. The
                  action is irreversible.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy} data-testid="cleanup-cancel">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={runCleanup}
              disabled={busy}
              className="bg-danger text-danger-foreground hover:bg-danger/90"
              data-testid="cleanup-confirm"
            >
              {busy && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
              Confirm cleanup
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
