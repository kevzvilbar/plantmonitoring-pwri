import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { format } from 'date-fns';

interface AuditEntry {
  id: string;
  kind: 'user' | 'plant';
  entity_id: string;
  entity_label: string | null;
  action: 'soft' | 'hard';
  actor_user_id: string | null;
  actor_label: string | null;
  reason: string | null;
  dependencies: Record<string, unknown> | null;
  created_at: string;
}

export function AuditLogPanel() {
  const [kindFilter, setKindFilter] = useState<'all' | 'user' | 'plant'>('all');
  const { data, isLoading } = useQuery({
    queryKey: ['admin-audit-log', kindFilter],
    queryFn: async () => {
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      if (!token) throw new Error('Sign in required');
      const base = (import.meta.env.REACT_APP_BACKEND_URL as string) || '';
      const qs = kindFilter === 'all' ? '' : `?kind=${kindFilter}`;
      const res = await fetch(`${base}/api/admin/audit-log${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Audit log fetch failed: ${res.status}`);
      return (await res.json()) as {
        count: number;
        entries: AuditEntry[];
        warning?: string;
        table_missing?: boolean;
      };
    },
  });

  return (
    <div className="space-y-2">
      <div className="flex gap-1.5">
        {(['all', 'user', 'plant'] as const).map((k) => (
          <button
            key={k}
            onClick={() => setKindFilter(k)}
            className={`px-3 py-1 text-xs rounded-md border transition-colors ${
              kindFilter === k
                ? 'bg-accent text-accent-foreground border-accent'
                : 'bg-card hover:bg-muted'
            }`}
            data-testid={`audit-filter-${k}`}
          >
            {k === 'all' ? 'All' : k[0].toUpperCase() + k.slice(1) + 's'}
          </button>
        ))}
      </div>
      {data?.table_missing && (
        <Card className="p-3 text-xs text-amber-600 border-amber-500/30 bg-amber-500/5">
          <strong>Audit log table not yet created.</strong> Run{' '}
          <code>supabase/migrations/20260424_deletion_audit_log.sql</code> in your
          Supabase project (SQL editor) to enable full audit history. Deletions
          will still execute — they just won't be logged until the migration runs.
        </Card>
      )}
      {data?.warning && !data?.table_missing && (
        <Card className="p-3 text-xs text-amber-600 border-amber-500/30 bg-amber-500/5">
          Audit log warning: <code>{data.warning}</code>
        </Card>
      )}
      {isLoading && (
        <Card className="p-4 text-center text-xs text-muted-foreground">Loading…</Card>
      )}
      {(data?.entries ?? []).map((e) => (
        <Card key={e.id} className="p-3 space-y-1" data-testid={`audit-entry-${e.id}`}>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-1.5">
              <Badge variant="outline" className="capitalize">{e.kind}</Badge>
              <Badge
                variant={e.action === 'hard' ? 'destructive' : 'secondary'}
                className="capitalize"
              >
                {e.action === 'hard' ? 'Hard delete' : 'Soft delete'}
              </Badge>
              {e.reason?.startsWith('[FORCE]') && (
                <Badge className="bg-danger text-danger-foreground">FORCE</Badge>
              )}
            </div>
            <span className="text-[11px] text-muted-foreground">
              {format(new Date(e.created_at), 'yyyy-MM-dd HH:mm')}
            </span>
          </div>
          <div className="text-sm">
            <strong>{e.entity_label ?? e.entity_id}</strong>
            <span className="text-muted-foreground"> · by {e.actor_label ?? e.actor_user_id ?? '—'}</span>
          </div>
          {e.reason && (
            <div className="text-xs text-muted-foreground italic">"{e.reason}"</div>
          )}
        </Card>
      ))}
      {!isLoading && (data?.entries?.length ?? 0) === 0 && (
        <Card className="p-4 text-center text-xs text-muted-foreground">
          No deletion events recorded yet.
        </Card>
      )}
    </div>
  );
}
