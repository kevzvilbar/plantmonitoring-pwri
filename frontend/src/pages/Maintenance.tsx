import { useState } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { StatusPill } from '@/components/StatusPill';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { Sparkles } from 'lucide-react';
import { PMS_TEMPLATES } from '@/lib/pmsTemplates';
import { PmsCalendar } from '@/components/PmsCalendar';
import { PmForecastTab } from '@/components/PmForecastTab';

const FREQUENCIES = ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Yearly'] as const;
type Frequency = typeof FREQUENCIES[number];
const CATEGORIES = [
  'Controllers', 'Pumps & Motors', 'Genset', 'RO Membranes', 'Dosing Pump',
  'pH Meter', 'TDS Meter', 'Colorimeter', 'Nephelometer',
  'Filter Media', 'Safety Equipment', 'Other',
];

export default function Maintenance() {
  return (
    <div className="space-y-3 animate-fade-in">
      <h1 className="text-xl font-semibold tracking-tight">Maintenance</h1>
      <Tabs defaultValue="calendar">
        <TabsList className="grid grid-cols-4 w-full">
          <TabsTrigger value="calendar">Calendar</TabsTrigger>
          <TabsTrigger value="add">Add Equipment</TabsTrigger>
          <TabsTrigger value="records">Records</TabsTrigger>
          <TabsTrigger value="forecast"><Sparkles className="h-3.5 w-3.5 mr-1" />AI Forecast</TabsTrigger>
        </TabsList>
        <TabsContent value="calendar" className="mt-3"><PmsCalendar /></TabsContent>
        <TabsContent value="add" className="mt-3"><AddTemplate /></TabsContent>
        <TabsContent value="records" className="mt-3"><Records /></TabsContent>
        <TabsContent value="forecast" className="mt-3"><PmForecastTab /></TabsContent>
      </Tabs>
    </div>
  );
}

function AddTemplate() {
  const qc = useQueryClient();
  const { user, isManager } = useAuth();
  const { selectedPlantId } = useAppStore();
  const { data: plants } = usePlants();
  const [generating, setGenerating] = useState(false);
  const [v, setV] = useState({
    plant_id: selectedPlantId ?? '',
    category: 'Controllers',
    equipment_name: '',
    frequencies: new Set<Frequency>(['Monthly']),
    checklist_steps: '',
    schedule_start_date: format(new Date(), 'yyyy-MM-dd'),
  });

  if (!isManager) return <Card className="p-4 text-xs text-center text-muted-foreground">Manager/Admin only</Card>;

  const toggleFreq = (f: Frequency) => {
    const next = new Set(v.frequencies);
    next.has(f) ? next.delete(f) : next.add(f);
    setV({ ...v, frequencies: next });
  };

  const submit = async () => {
    if (!v.plant_id || !v.equipment_name) { toast.error('Plant and equipment name are required'); return; }
    if (!v.frequencies.size) { toast.error('Pick at least one frequency'); return; }

    // For each chosen frequency, prefer the matching steps from PMS_TEMPLATES (by category + equipment_name + frequency).
    // Otherwise fall back to user-entered steps.
    const userSteps = v.checklist_steps.split('\n').map(s => s.trim()).filter(Boolean);
    const rows = Array.from(v.frequencies).map((freq) => {
      const seed = PMS_TEMPLATES.find(t =>
        t.category === v.category &&
        t.equipment_name.toLowerCase() === v.equipment_name.toLowerCase() &&
        t.frequency === freq
      );
      return {
        plant_id: v.plant_id,
        category: v.category,
        equipment_name: v.equipment_name,
        frequency: freq,
        checklist_steps: userSteps.length ? userSteps : (seed?.steps ?? []),
        schedule_start_date: v.schedule_start_date,
        created_by: user?.id,
      };
    });
    const { error } = await supabase.from('checklist_templates').insert(rows);
    if (error) { toast.error(error.message); return; }
    toast.success(`Created ${rows.length} schedule${rows.length === 1 ? '' : 's'} for ${v.equipment_name}`);
    setV({ ...v, equipment_name: '', frequencies: new Set(['Monthly']), checklist_steps: '' });
    qc.invalidateQueries({ queryKey: ['pms-templates'] });
  };

  const generatePms = async () => {
    if (!v.plant_id) { toast.error('Pick a plant first'); return; }
    setGenerating(true);
    try {
      const { data: existing } = await supabase
        .from('checklist_templates')
        .select('equipment_name,frequency,category')
        .eq('plant_id', v.plant_id);
      const existsKey = new Set((existing ?? []).map((r: any) =>
        `${r.category}|${r.equipment_name}|${r.frequency}`));
      const startDate = v.schedule_start_date;
      const rows = PMS_TEMPLATES
        .filter(t => !existsKey.has(`${t.category}|${t.equipment_name}|${t.frequency}`))
        .map(t => ({
          plant_id: v.plant_id, category: t.category,
          equipment_name: t.equipment_name, frequency: t.frequency,
          checklist_steps: t.steps, schedule_start_date: startDate,
          created_by: user?.id,
        }));
      if (!rows.length) { toast.info('All standard PMS templates already exist'); return; }
      const { error } = await supabase.from('checklist_templates').insert(rows);
      if (error) throw error;
      toast.success(`Generated ${rows.length} standard PMS schedules`);
      qc.invalidateQueries({ queryKey: ['pms-templates'] });
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to generate');
    } finally { setGenerating(false); }
  };

  return (
    <div className="space-y-3">
      <Card className="p-3 flex items-start gap-3 bg-accent-soft/40 border-accent/30">
        <Sparkles className="h-4 w-4 text-accent mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold">Generate Standard PMS Library</div>
          <p className="text-[11px] text-muted-foreground">
            One-tap setup of standard PMS schedules (Genset, RO, Dosing Pump, Controllers, Cartridge Filter, Pumps & Motors, pH/NTU/Colorimeter)
            for the selected plant. Skips anything that already exists.
          </p>
        </div>
        <Button size="sm" onClick={generatePms} disabled={generating || !v.plant_id}>
          {generating ? 'Generating…' : 'Generate'}
        </Button>
      </Card>

      <Card className="p-3 space-y-3">
        <div className="text-sm font-semibold">Add Equipment + Schedules</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div>
            <Label>Plant</Label>
            <Select value={v.plant_id} onValueChange={(x) => setV({ ...v, plant_id: x })}>
              <SelectTrigger><SelectValue placeholder="Plant" /></SelectTrigger>
              <SelectContent>{plants?.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <Label>Category</Label>
            <Select value={v.category} onValueChange={(x) => setV({ ...v, category: x })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        <div>
          <Label>Equipment Name</Label>
          <Input value={v.equipment_name} placeholder="e.g. Pump & Motor"
            onChange={e => setV({ ...v, equipment_name: e.target.value })} />
        </div>
        <div>
          <Label>Frequencies (Multi-Select)</Label>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mt-1">
            {FREQUENCIES.map(f => (
              <label key={f}
                className={`flex items-center gap-2 rounded-md border px-2 py-2 cursor-pointer text-xs transition-colors
                  ${v.frequencies.has(f) ? 'border-primary bg-primary-soft text-primary' : 'border-border hover:bg-secondary'}`}>
                <Checkbox checked={v.frequencies.has(f)} onCheckedChange={() => toggleFreq(f)} />
                {f}
              </label>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">
            One PMS schedule will be generated per selected frequency, starting from the date below.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div>
            <Label>Schedule Start Date</Label>
            <Input type="date" value={v.schedule_start_date} onChange={e => setV({ ...v, schedule_start_date: e.target.value })} />
          </div>
        </div>
        <div>
          <Label>Custom Steps (Optional, One Per Line)</Label>
          <Textarea value={v.checklist_steps} rows={3}
            placeholder="Leave blank to use the standard template steps for this category + equipment."
            onChange={e => setV({ ...v, checklist_steps: e.target.value })} />
        </div>
        <Button onClick={submit} className="w-full">
          Generate {v.frequencies.size} Schedule{v.frequencies.size === 1 ? '' : 's'}
        </Button>
      </Card>
    </div>
  );
}

function Records() {
  const { selectedPlantId } = useAppStore();
  const { data } = useQuery({
    queryKey: ['records', selectedPlantId],
    queryFn: async () => {
      let q = supabase.from('checklist_executions')
        .select('*,checklist_templates(equipment_name,category),user_profiles(first_name,last_name)')
        .order('completed_at', { ascending: false }).limit(50);
      if (selectedPlantId) q = q.eq('plant_id', selectedPlantId);
      return (await q).data ?? [];
    },
  });
  return (
    <div className="space-y-2">
      {data?.map((r: any) => (
        <Card key={r.id} className="p-3">
          <div className="flex justify-between items-start text-sm">
            <div>
              <div className="font-medium">{r.checklist_templates?.equipment_name}</div>
              <div className="text-xs text-muted-foreground">{r.checklist_templates?.category} · {r.frequency}</div>
            </div>
            <StatusPill tone="accent">Done</StatusPill>
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            By {r.user_profiles?.first_name} · {r.completed_at && format(new Date(r.completed_at), 'MMM d, HH:mm')}
          </div>
          {r.findings && <div className="text-xs mt-1 p-1.5 bg-secondary rounded">{r.findings}</div>}
        </Card>
      ))}
      {!data?.length && <Card className="p-4 text-xs text-center text-muted-foreground">No records</Card>}
    </div>
  );
}
