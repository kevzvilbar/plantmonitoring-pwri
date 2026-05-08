import { Button } from '@/components/ui/button';
import { Download } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { downloadCSV } from '@/lib/csv';
import { toast } from 'sonner';
import { useState } from 'react';

interface Props {
  table: string;
  filename?: string;
  filters?: Record<string, any>;
  label?: string;
  size?: 'sm' | 'default';
}

export function ExportButton({ table, filename, filters, label = 'Export CSV', size = 'sm' }: Props) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      let q = supabase.from(table as any).select('*').limit(10000);
      if (filters) {
        Object.entries(filters).forEach(([k, v]) => {
          if (v != null && v !== '') q = (q as any).eq(k, v);
        });
      }
      const { data, error } = await q;
      if (error) throw error;
      if (!data?.length) { toast.info('No rows to export'); return; }
      downloadCSV(filename ?? `${table}-${new Date().toISOString().slice(0, 10)}.csv`, data as any[]);
      toast.success(`Exported ${data.length} rows`);
    } catch (e: any) {
      toast.error(e.message ?? 'Export failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button onClick={run} variant="outline" size={size} disabled={busy}>
      <Download className="h-3.5 w-3.5" />
      {label}
    </Button>
  );
}
