import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { downloadCSV } from '@/lib/csv';
import { useAppStore } from '@/store/appStore';
import { usePlants } from '@/hooks/usePlants';
import { Download } from 'lucide-react';
import { toast } from 'sonner';
import { format, subDays } from 'date-fns';

const TABLES: Array<{ id: string; label: string; dateCol?: string }> = [
  { id: 'daily_plant_summary', label: 'Daily Plant Summary', dateCol: 'summary_date' },
  { id: 'production_costs', label: 'Production Costs', dateCol: 'cost_date' },
  { id: 'well_readings', label: 'Well Readings', dateCol: 'reading_datetime' },
  { id: 'locator_readings', label: 'Locator Readings', dateCol: 'reading_datetime' },
  { id: 'power_readings', label: 'Power Readings', dateCol: 'reading_datetime' },
  { id: 'ro_train_readings', label: 'RO Train Readings', dateCol: 'reading_datetime' },
  { id: 'ro_pretreatment_readings', label: 'Pre-Treatment Readings', dateCol: 'reading_datetime' },
  { id: 'chemical_dosing_logs', label: 'Chemical Dosing Logs', dateCol: 'log_datetime' },
  { id: 'chemical_deliveries', label: 'Chemical Deliveries', dateCol: 'delivery_date' },
  { id: 'chemical_prices', label: 'Chemical Prices', dateCol: 'effective_date' },
  { id: 'electric_bills', label: 'Electric Bills', dateCol: 'billing_month' },
  { id: 'power_tariffs', label: 'Power Tariffs', dateCol: 'effective_date' },
  { id: 'incidents', label: 'Incidents', dateCol: 'when_datetime' },
  { id: 'cip_logs', label: 'CIP Logs', dateCol: 'start_datetime' },
];

export default function Exports() {
  const { selectedPlantId } = useAppStore();
  const { data: plants } = usePlants();
  const [plantId, setPlantId] = useState(selectedPlantId ?? 'all');
  const [from, setFrom] = useState(format(subDays(new Date(), 30), 'yyyy-MM-dd'));
  const [to, setTo] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [busy, setBusy] = useState<string | null>(null);

  const exportTable = async (t: typeof TABLES[number]) => {
    setBusy(t.id);
    try {
      let q = supabase.from(t.id as any).select('*').limit(50000);
      if (plantId && plantId !== 'all') q = (q as any).eq('plant_id', plantId);
      if (t.dateCol) {
        q = (q as any).gte(t.dateCol, from).lte(t.dateCol, to + 'T23:59:59');
      }
      const { data, error } = await q;
      if (error) throw error;
      if (!data?.length) { toast.info(`No rows in ${t.label}`); return; }
      downloadCSV(`${t.id}_${from}_to_${to}.csv`, data as any[]);
      toast.success(`Exported ${data.length} rows from ${t.label}`);
    } catch (e: any) {
      toast.error(e.message ?? 'Export failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3 animate-fade-in">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Data Exports</h1>
        <p className="text-sm text-muted-foreground">Download any data set as CSV (Excel-compatible).</p>
      </div>

      <Card className="p-3 space-y-2">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div>
            <Label>Plant</Label>
            <Select value={plantId} onValueChange={setPlantId}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All plants</SelectItem>
                {plants?.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div><Label>From</Label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><Label>To</Label><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        </div>
      </Card>

      <Card className="p-2 divide-y">
        {TABLES.map((t) => (
          <div key={t.id} className="flex items-center justify-between gap-2 p-2">
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{t.label}</div>
              <div className="text-[10px] text-muted-foreground font-mono-num truncate">{t.id}</div>
            </div>
            <Button onClick={() => exportTable(t)} variant="outline" size="sm" disabled={busy === t.id}>
              <Download className="h-3.5 w-3.5" />
              {busy === t.id ? 'Exporting…' : 'CSV'}
            </Button>
          </div>
        ))}
      </Card>
    </div>
  );
}
