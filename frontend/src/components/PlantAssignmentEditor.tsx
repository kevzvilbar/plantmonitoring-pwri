import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { usePlants } from '@/hooks/usePlants';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader,
  DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/sonner';
import { Building2, Loader2 } from 'lucide-react';

interface Props {
  userId: string;
  userLabel: string;
  currentPlantIds: string[];
  invalidateKeys?: string[][];
  /** Disable the trigger when the caller lacks permission. */
  disabled?: boolean;
  /** When true (Operator), only one plant may be selected at a time. */
  singlePlantOnly?: boolean;
}

export function PlantAssignmentEditor({
  userId, userLabel, currentPlantIds, invalidateKeys, disabled, singlePlantOnly,
}: Props) {
  const qc = useQueryClient();
  const { data: plants } = usePlants();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set(currentPlantIds ?? []));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setSelected(new Set(currentPlantIds ?? []));
  }, [open, currentPlantIds]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (singlePlantOnly) {
        // Operator: radio-style — selecting a new plant replaces any existing
        return next.has(id) ? new Set<string>() : new Set<string>([id]);
      }
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const save = async () => {
    setBusy(true);
    try {
      const next = Array.from(selected);
      const { error } = await supabase
        .from('user_profiles')
        .update({ plant_assignments: next })
        .eq('id', userId);
      if (error) throw new Error(error.message);
      toast.success('Plant assignments updated');
      (invalidateKeys ?? [['admin-users'], ['staff']]).forEach((k) =>
        qc.invalidateQueries({ queryKey: k })
      );
      setOpen(false);
    } catch (e: any) {
      toast.error(e?.message ?? 'Update failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          data-testid={`edit-plants-${userId}`}
        >
          <Building2 className="h-3.5 w-3.5 mr-1.5" />
          Edit plants
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Plant assignments</DialogTitle>
          <DialogDescription>
            {singlePlantOnly
              ? <>Operators can only be assigned to <strong>one plant</strong>. Select below for <strong>{userLabel}</strong>.</>
              : <>Choose which plants <strong>{userLabel}</strong> can access.</>
            }
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5 max-h-[50vh] overflow-y-auto">
          {(plants ?? []).map((p) => {
            const on = selected.has(p.id);
            return (
              <label
                key={p.id}
                className="flex items-center gap-2 p-2 rounded-md border hover:bg-muted cursor-pointer"
                data-testid={`plant-toggle-${p.id}`}
              >
                {singlePlantOnly
                  ? <input type="radio" name={`plant-${userId}`} checked={on} onChange={() => { setSelected(new Set([p.id])); }} className="accent-accent" />
                  : <Checkbox checked={on} onCheckedChange={() => toggle(p.id)} />
                }
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{p.name}</div>
                  <div className="text-[11px] text-muted-foreground truncate">
                    {p.address ?? '—'}
                  </div>
                </div>
                {p.status !== 'Active' && (
                  <Badge variant="secondary" className="text-[10px]">{p.status}</Badge>
                )}
              </label>
            );
          })}
          {!plants?.length && (
            <div className="text-xs text-muted-foreground text-center py-4">
              No plants to assign.
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy} data-testid="save-plant-assignments">
            {busy && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
            Save ({selected.size})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
