import { useMemo, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { usePlants } from '@/hooks/usePlants';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { StatusPill } from '@/components/StatusPill';
import { DeleteEntityMenu } from '@/components/DeleteEntityMenu';
import { Search } from 'lucide-react';
import { BadImportCleanupCard } from './BadImportCleanupCard';

export function PlantsPanel() {
  const { isAdmin } = useAuth();
  const { data: plants } = usePlants();
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const list = plants ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((p) =>
      [p.name, p.address]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(q)),
    );
  }, [plants, query]);

  return (
    <div className="space-y-2">
      {isAdmin && <BadImportCleanupCard />}
      {/* Sticky search keeps Search-by-name accessible while scrolling the list. */}
      <div className="sticky top-0 z-20 -mx-1 px-1 py-1 bg-background/85 backdrop-blur-sm border-b border-border/40">
        <div className="relative">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-2.5 text-muted-foreground" />
          <Input
            placeholder="Search by name or address…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-8"
            data-testid="admin-plants-search"
          />
          {query && (
            <span className="absolute right-2.5 top-2 text-[10px] text-muted-foreground" data-testid="admin-plants-count">
              {filtered.length} / {plants?.length ?? 0}
            </span>
          )}
        </div>
      </div>
      {filtered.map((p) => {
        const active = p.status === 'Active';
        return (
          <Card
            key={p.id}
            className={`p-3 border-l-4 transition-colors ${
              active
                ? 'border-l-emerald-500/70 bg-gradient-to-r from-emerald-50/40 to-transparent dark:from-emerald-950/20'
                : 'border-l-muted-foreground/40 bg-muted/20 opacity-90'
            }`}
            data-testid={`admin-plant-card-${p.id}`}
          >
            <div className="flex justify-between items-start gap-2">
              <div className="min-w-0">
                <div className="font-medium text-sm truncate">{p.name}</div>
                <div className="text-xs text-muted-foreground truncate">{p.address ?? '—'}</div>
                <div className="text-xs mt-1 flex flex-wrap gap-x-3">
                  <span>RO trains: <strong>{p.num_ro_trains}</strong></span>
                  <span>Capacity: <strong>{p.design_capacity_m3 ?? '—'} m³</strong></span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <StatusPill tone={active ? 'accent' : 'muted'}>{p.status}</StatusPill>
                <DeleteEntityMenu
                  kind="plant"
                  id={p.id}
                  label={p.name}
                  canSoftDelete={active}
                  canHardDelete
                  invalidateKeys={[['plants']]}
                  compact
                />
              </div>
            </div>
          </Card>
        );
      })}
      {filtered.length === 0 && (
        <Card className="p-4 text-center text-xs text-muted-foreground">No plants</Card>
      )}
    </div>
  );
}
