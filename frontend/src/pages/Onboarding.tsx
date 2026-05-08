import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { usePlants } from '@/hooks/usePlants';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { DesignationCombobox, OPERATOR_DESIGNATION } from '@/components/DesignationCombobox';
import { toast } from 'sonner';

export default function Onboarding() {
  const { user, profile, refreshProfile, loading } = useAuth();
  const navigate = useNavigate();
  const { data: plants, refetch: refetchPlants } = usePlants();
  const [busy, setBusy] = useState(false);
  const [creatingPlant, setCreatingPlant] = useState(false);
  const [newPlantName, setNewPlantName] = useState('');

  const [form, setForm] = useState({
    username: '', first_name: '', middle_name: '', last_name: '', suffix: '',
    designation: '', plant_assignments: [] as string[],
  });

  if (loading) return <div className="min-h-screen flex items-center justify-center">Loading…</div>;
  if (!user) return <Navigate to="/auth" replace />;
  // If profile is complete, redirect appropriately:
  // - confirmed users go to the app
  // - unconfirmed users go to the pending-approval page
  if (profile?.profile_complete) {
    return profile.confirmed === false
      ? <Navigate to="/pending-approval" replace />
      : <Navigate to="/" replace />;
  }

  const isOperator = form.designation === OPERATOR_DESIGNATION;

  const togglePlant = (id: string) => {
    setForm((f) => {
      if (isOperator) {
        // Operators may only hold a single plant assignment
        return { ...f, plant_assignments: f.plant_assignments.includes(id) ? [] : [id] };
      }
      return {
        ...f,
        plant_assignments: f.plant_assignments.includes(id)
          ? f.plant_assignments.filter((x) => x !== id)
          : [...f.plant_assignments, id],
      };
    });
  };

  const handleCreatePlant = async () => {
    if (!newPlantName.trim()) { toast.error('Enter a plant name'); return; }
    setCreatingPlant(true);
    const { data, error } = await supabase
      .from('plants')
      .insert({ name: newPlantName.trim(), status: 'Active', num_ro_trains: 0, geofence_radius_m: 100, backwash_mode: 'independent' })
      .select('id')
      .single();
    setCreatingPlant(false);
    if (error) { toast.error(error.message); return; }
    toast.success(`Plant "${newPlantName.trim()}" created`);
    setNewPlantName('');
    await refetchPlants();
    if (data?.id) {
      setForm((f) => ({ ...f, plant_assignments: [...f.plant_assignments, data.id] }));
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.username || !form.first_name || !form.last_name) { toast.error('Fill required fields'); return; }
    if (form.plant_assignments.length === 0) { toast.error('Assign at least one plant'); return; }
    setBusy(true);
    const { error } = await supabase.rpc('complete_onboarding', {
      _username: form.username,
      _first_name: form.first_name,
      _middle_name: form.middle_name || null,
      _last_name: form.last_name,
      _suffix: form.suffix || null,
      _designation: form.designation || null,
      _plant_assignments: form.plant_assignments,
    });
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    await refreshProfile();
    toast.success('Profile saved');
    // New users have confirmed=false by default and need admin approval
    // before accessing the app. Send them to the pending-approval page.
    navigate('/pending-approval');
  };

  const noPlants = !plants || plants.length === 0;

  return (
    <div className="min-h-screen bg-background p-4 flex justify-center">
      <form onSubmit={submit} className="w-full max-w-lg bg-card rounded-2xl shadow-card p-5 space-y-4 my-6">
        <div>
          <h1 className="text-xl font-semibold">Complete your profile</h1>
          <p className="text-sm text-muted-foreground">Required before accessing the app.</p>
        </div>

        <div>
          <Label className="mb-2 block">
            Plant assignment{isOperator ? ' * (single plant — Operators are limited to one)' : 's *'}
          </Label>

          {noPlants ? (
            <p className="text-sm text-muted-foreground mb-2">No plants found. Create one to continue.</p>
          ) : (
            <div className="grid grid-cols-2 gap-2 mb-3">
              {plants.map((p) => (
                <label key={p.id} className="flex items-center gap-2 p-2 rounded-md border cursor-pointer hover:bg-secondary">
                  {isOperator
                    ? <input type="radio" name="onboarding-plant" checked={form.plant_assignments.includes(p.id)} onChange={() => togglePlant(p.id)} className="accent-accent" />
                    : <Checkbox checked={form.plant_assignments.includes(p.id)} onCheckedChange={() => togglePlant(p.id)} />
                  }
                  <span className="text-sm">{p.name}</span>
                </label>
              ))}
            </div>
          )}

          <div className="flex gap-2 mt-1">
            <Input
              placeholder="New plant name…"
              value={newPlantName}
              onChange={(e) => setNewPlantName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreatePlant(); } }}
            />
            <Button type="button" variant="outline" onClick={handleCreatePlant} disabled={creatingPlant}>
              {creatingPlant ? 'Adding…' : '+ Add plant'}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2"><Label>Username *</Label><Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required /></div>
          <div><Label>First name *</Label><Input value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} required /></div>
          <div><Label>Last name *</Label><Input value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} required /></div>
          <div><Label>Middle name</Label><Input value={form.middle_name} onChange={(e) => setForm({ ...form, middle_name: e.target.value })} /></div>
          <div><Label>Suffix</Label><Input value={form.suffix} onChange={(e) => setForm({ ...form, suffix: e.target.value })} /></div>
          <div className="col-span-2"><Label>Designation</Label>
            <DesignationCombobox
              value={form.designation}
              onChange={(v) => setForm({ ...form, designation: v })}
              placeholder="Select or type a designation…"
              data-testid="onboarding-designation"
            />
          </div>
        </div>

        <Button type="submit" disabled={busy} className="w-full">{busy ? 'Saving…' : 'Save & continue'}</Button>
        <p className="text-xs text-muted-foreground text-center">Your role defaults to <strong>Operator</strong>. An Admin can change roles later.</p>
      </form>
    </div>
  );
}
