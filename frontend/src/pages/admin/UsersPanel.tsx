import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { usePlants } from '@/hooks/usePlants';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { StatusPill } from '@/components/StatusPill';
import { DeleteEntityMenu } from '@/components/DeleteEntityMenu';
import { PlantAssignmentEditor } from '@/components/PlantAssignmentEditor';
import {
  DesignationCombobox, accessLevelFromRoles, OPERATOR_DESIGNATION,
} from '@/components/DesignationCombobox';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { Search, Hourglass, UserPlus } from 'lucide-react';

const ALL_ROLES = ['Operator', 'Technician', 'Supervisor', 'Manager', 'Admin'] as const;
type AppRole = typeof ALL_ROLES[number];

// ── Role selector ─────────────────────────────────────────────────────────────

function RoleSelector({ userId, currentRoles, onChanged }: {
  userId: string; currentRoles: string[]; onChanged: () => void;
}) {
  const primaryRole: AppRole = (() => {
    const r = new Set(currentRoles);
    for (const role of ['Admin', 'Manager', 'Supervisor', 'Technician', 'Operator'] as AppRole[]) {
      if (r.has(role)) return role;
    }
    return 'Operator';
  })();

  const handleChange = async (newRole: AppRole) => {
    if (newRole === primaryRole) return;
    const { error: delError } = await supabase.from('user_roles').delete().eq('user_id', userId);
    if (delError) { toast.error(delError.message); return; }
    const { error: insError } = await supabase.from('user_roles').insert({ user_id: userId, role: newRole });
    if (insError) { toast.error(insError.message); return; }
    toast.success(`Role updated to ${newRole}`);
    onChanged();
  };

  return (
    <Select value={primaryRole} onValueChange={(v) => handleChange(v as AppRole)}>
      <SelectTrigger className="h-7 text-xs w-32"><SelectValue /></SelectTrigger>
      <SelectContent>
        {ALL_ROLES.map((r) => <SelectItem key={r} value={r} className="text-xs">{r}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

// ── Create-user dialog ────────────────────────────────────────────────────────

function CreateUserDialog({ open, onClose, onCreated }: {
  open: boolean; onClose: () => void; onCreated: () => void;
}) {
  const { data: plants } = usePlants();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    email: '', password: '', first_name: '', last_name: '',
    middle_name: '', suffix: '', username: '', designation: '',
  });
  // Plant assignment inside dialog
  const [plantId, setPlantId] = useState('');        // single plant (Operator)
  const [plantIds, setPlantIds] = useState<string[]>([]); // multi-plant (others)

  const isOperator = form.designation === OPERATOR_DESIGNATION;

  const field = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const reset = () => {
    setForm({ email: '', password: '', first_name: '', last_name: '', middle_name: '', suffix: '', username: '', designation: '' });
    setPlantId(''); setPlantIds([]); setBusy(false);
  };

  const handleClose = () => { reset(); onClose(); };

  const handleSubmit = async () => {
    if (!form.email || !form.password || !form.first_name || !form.last_name || !form.username) {
      toast.error('Email, password, username, first name and last name are required.'); return;
    }
    if (form.password.length < 6) { toast.error('Password must be at least 6 characters.'); return; }
    if (isOperator && !plantId) { toast.error('Select a plant for this Operator.'); return; }
    if (!isOperator && plantIds.length === 0) { toast.error('Assign at least one plant.'); return; }

    setBusy(true);
    const assignedPlants = isOperator ? [plantId] : plantIds;
    try {
      // Save current admin session so we can restore it after creating the user
      const { data: adminSession } = await supabase.auth.getSession();

      // 1. Create the auth user
      const { error: upErr } = await supabase.auth.signUp({
        email: form.email, password: form.password,
      });
      if (upErr) throw new Error(upErr.message);

      // 2. Sign in as the new user to call the RPC
      const { error: inErr } = await supabase.auth.signInWithPassword({
        email: form.email, password: form.password,
      });
      if (inErr) throw new Error(inErr.message);

      // 3. Complete onboarding profile
      const { error: rpErr } = await supabase.rpc('complete_onboarding', {
        _username: form.username,
        _first_name: form.first_name,
        _middle_name: form.middle_name || null,
        _last_name: form.last_name,
        _suffix: form.suffix || null,
        _designation: form.designation || null,
        _plant_assignments: assignedPlants,
      });
      if (rpErr) throw new Error(rpErr.message);

      // 4. Sign out the new user
      await supabase.auth.signOut();

      // 5. Restore admin session
      if (adminSession.session?.refresh_token) {
        await supabase.auth.setSession({
          access_token: adminSession.session.access_token,
          refresh_token: adminSession.session.refresh_token,
        });
      }

      toast.success(`${form.first_name} ${form.last_name} created — click Approve to activate.`);
      setBusy(false); onCreated(); handleClose();
    } catch (err: any) {
      toast.error(err?.message ?? 'Unexpected error creating user.'); setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Create new user</DialogTitle></DialogHeader>
        <div className="space-y-3 py-1">
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Login credentials</p>
            <div><Label>Email *</Label><Input type="email" value={form.email} onChange={field('email')} placeholder="user@example.com" /></div>
            <div><Label>Password *</Label><Input type="password" value={form.password} onChange={field('password')} placeholder="Min. 6 characters" /></div>
          </div>
          <div className="space-y-2 pt-1 border-t">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Profile</p>
            <div><Label>Username *</Label><Input value={form.username} onChange={field('username')} placeholder="e.g. jdelacruz" /></div>
            <div className="grid grid-cols-2 gap-2">
              <div><Label>First name *</Label><Input value={form.first_name} onChange={field('first_name')} /></div>
              <div><Label>Last name *</Label><Input value={form.last_name} onChange={field('last_name')} /></div>
              <div><Label>Middle name</Label><Input value={form.middle_name} onChange={field('middle_name')} /></div>
              <div><Label>Suffix</Label><Input value={form.suffix} onChange={field('suffix')} placeholder="Jr., Sr., III…" /></div>
            </div>
            <div>
              <Label>Designation</Label>
              <DesignationCombobox value={form.designation} onChange={(v) => { setForm((f) => ({ ...f, designation: v })); setPlantId(''); setPlantIds([]); }} placeholder="Select or type a designation…" />
            </div>
          </div>

          {/* Plant assignment — conditional on designation */}
          {form.designation && (
            <div className="space-y-2 pt-1 border-t">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Plant assignment {isOperator ? '(single plant)' : '(multi-plant)'}
              </p>
              {isOperator ? (
                <div className="space-y-1.5 max-h-40 overflow-y-auto">
                  {(plants ?? []).map((p) => (
                    <label key={p.id} className={`flex items-center gap-2 p-2 rounded-md border cursor-pointer transition-colors ${plantId === p.id ? 'border-accent bg-accent/5' : 'hover:bg-muted/40'}`}>
                      <input type="radio" name="create-plant" value={p.id} checked={plantId === p.id} onChange={() => setPlantId(p.id)} className="accent-accent" />
                      <span className="text-sm">{p.name}</span>
                    </label>
                  ))}
                  {!(plants ?? []).length && <p className="text-xs text-muted-foreground">No plants available.</p>}
                </div>
              ) : (
                <div className="space-y-1.5 max-h-40 overflow-y-auto">
                  {(plants ?? []).map((p) => (
                    <label key={p.id} className={`flex items-center gap-2 p-2 rounded-md border cursor-pointer transition-colors ${plantIds.includes(p.id) ? 'border-accent bg-accent/5' : 'hover:bg-muted/40'}`}>
                      <Checkbox checked={plantIds.includes(p.id)} onCheckedChange={() => setPlantIds((prev) => prev.includes(p.id) ? prev.filter((x) => x !== p.id) : [...prev, p.id])} />
                      <span className="text-sm">{p.name}</span>
                    </label>
                  ))}
                  {!(plants ?? []).length && <p className="text-xs text-muted-foreground">No plants available.</p>}
                </div>
              )}
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Created with <strong>Operator</strong> role, placed in the approval queue.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={busy}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={busy}>{busy ? 'Creating…' : 'Create user'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function UsersPanel() {
  const qc = useQueryClient();
  const { data: plants } = usePlants();
  const [query, setQuery] = useState('');
  const [pendingOnly, setPendingOnly] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const { data: staff } = useQuery({
    queryKey: ['admin-users'],
    queryFn: async () => (await supabase.from('user_profiles').select('*').order('last_name')).data ?? [],
  });
  const { data: roles } = useQuery({
    queryKey: ['admin-user-roles'],
    queryFn: async () => (await supabase.from('user_roles').select('user_id, role')).data ?? [],
  });

  const rolesOf = (uid: string): string[] =>
    (roles ?? []).filter((r: any) => r.user_id === uid).map((r: any) => r.role as string);

  const plantName = (id: string) => (plants ?? []).find((p) => p.id === id)?.name ?? id;

  const logPlantAssignmentChange = async (userId: string, newPlants: string[], justification = 'Admin update') => {
    try {
      const { data: actor } = await supabase.auth.getUser();
      await supabase.from('plant_assignment_audit' as any).insert({
        user_id: userId,
        admin_id: actor.user?.id ?? null,
        new_plant_ids: newPlants,
        justification,
        changed_at: new Date().toISOString(),
      } as any);
    } catch { /* audit table may not exist yet — non-blocking */ }
  };

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['admin-users'] });
    qc.invalidateQueries({ queryKey: ['admin-user-roles'] });
    qc.invalidateQueries({ queryKey: ['staff'] });
  };

  const updateDesignation = async (uid: string, designation: string) => {
    const { error } = await supabase.from('user_profiles').update({ designation }).eq('id', uid);
    if (error) { toast.error(error.message); return; }
    toast.success('Designation updated');
    invalidate();
  };

  const approveUser = async (uid: string, label: string) => {
    const { error } = await supabase.rpc('approve_user' as any, { _user_id: uid, _approve: true } as any);
    if (error) { toast.error(error.message); return; }
    toast.success(`${label || 'User'} approved`);
    invalidate();
  };

  const existingDesignations = useMemo(
    () => Array.from(new Set(((staff ?? []) as any[]).map((s) => s.designation).filter(Boolean))) as string[],
    [staff],
  );

  const pendingCount = useMemo(
    () => ((staff ?? []) as any[]).filter((s) => s.confirmed === false || s.status === 'Pending').length,
    [staff],
  );

  const filtered = useMemo(() => {
    let list = (staff ?? []) as any[];
    if (pendingOnly) list = list.filter((s) => s.confirmed === false || s.status === 'Pending');
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((s) =>
      [s.first_name, s.last_name, s.username, s.designation].filter(Boolean).some((v: string) => v.toLowerCase().includes(q)),
    );
  }, [staff, query, pendingOnly]);

  return (
    <div className="space-y-2">
      <div className="flex gap-2 items-center">
        <div className="relative flex-1">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-2.5 text-muted-foreground" />
          <Input placeholder="Search by name, username, designation…" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-8" data-testid="admin-users-search" />
        </div>
        <Button size="sm" variant={pendingOnly ? 'default' : 'outline'} onClick={() => setPendingOnly((v) => !v)} data-testid="admin-users-pending-filter">
          <Hourglass className="h-3 w-3 mr-1" /> Pending {pendingCount > 0 && `· ${pendingCount}`}
        </Button>
        <Button size="sm" onClick={() => setCreateOpen(true)} data-testid="admin-create-user-btn">
          <UserPlus className="h-3 w-3 mr-1" /> Add user
        </Button>
      </div>

      {filtered.map((s: any) => {
        const userRoles = rolesOf(s.id);
        const access = accessLevelFromRoles(userRoles);
        const awaiting = s.confirmed === false || s.status === 'Pending';
        const isOperator = s.designation === OPERATOR_DESIGNATION;
        const assignments: string[] = s.plant_assignments ?? [];
        return (
          <Card key={s.id} className="p-3 space-y-2" data-testid={`admin-user-card-${s.id}`}>
            <div className="flex justify-between items-start gap-2">
              <div className="min-w-0 space-y-1">
                <div className="font-medium text-sm truncate flex items-center gap-1.5 flex-wrap">
                  <span>{s.first_name} {s.last_name} {s.suffix}</span>
                  {awaiting && (
                    <Badge className="bg-amber-100 text-amber-700 border-amber-200 hover:bg-amber-100" data-testid={`pending-badge-${s.id}`}>
                      <Hourglass className="h-2.5 w-2.5 mr-0.5" /> Awaiting approval
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground truncate">@{s.username ?? '—'}</div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {userRoles.length === 0 && <Badge variant="secondary" className="text-[10px]">No role</Badge>}
                  {userRoles.map((r) => <Badge key={r} variant="outline" className="text-[10px]">{r}</Badge>)}
                  <StatusPill tone={access.tone}>{access.label}</StatusPill>
                </div>
                {/* Plant assignments display */}
                {assignments.length > 0 && (
                  <div className="flex items-center gap-1 flex-wrap pt-0.5">
                    <span className="text-[10px] text-muted-foreground">Plants:</span>
                    {assignments.map((id) => (
                      <Badge key={id} variant="secondary" className="text-[10px]">{plantName(id)}</Badge>
                    ))}
                    {isOperator && assignments.length > 1 && (
                      <Badge variant="destructive" className="text-[10px]">⚠ Multiple plants (Operator should have 1)</Badge>
                    )}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {awaiting && (
                  <Button size="sm" onClick={() => approveUser(s.id, `${s.first_name ?? ''} ${s.last_name ?? ''}`.trim() || (s.username ?? 'user'))} data-testid={`approve-user-${s.id}`}>
                    Approve
                  </Button>
                )}
                <StatusPill tone={s.status === 'Active' ? 'accent' : s.status === 'Pending' ? 'warn' : 'muted'}>{s.status}</StatusPill>
                <DeleteEntityMenu
                  kind="user" id={s.id}
                  label={`${s.first_name ?? ''} ${s.last_name ?? ''}`.trim() || (s.username ?? 'user')}
                  canSoftDelete={s.status === 'Active'} canHardDelete
                  invalidateKeys={[['admin-users'], ['admin-user-roles'], ['staff'], ['all-roles']]} compact
                />
              </div>
            </div>

            {/* Designation + Role row */}
            <div className="grid grid-cols-2 gap-2 items-center pt-1 border-t">
              <div className="grid grid-cols-[auto_1fr] gap-2 items-center">
                <span className="text-xs text-muted-foreground">Designation</span>
                <DesignationCombobox value={s.designation ?? ''} onChange={(v) => updateDesignation(s.id, v)} extraOptions={existingDesignations} data-testid={`admin-designation-${s.id}`} />
              </div>
              <div className="flex items-center gap-2 justify-end">
                <span className="text-xs text-muted-foreground">Role</span>
                <RoleSelector userId={s.id} currentRoles={userRoles} onChanged={invalidate} />
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 text-xs pt-1">
              <span className="text-muted-foreground">
                {assignments.length} plant{assignments.length === 1 ? '' : 's'} assigned
                {isOperator && <span className="text-amber-600 ml-1">(Operator: single plant only)</span>}
              </span>
              <PlantAssignmentEditor
                userId={s.id}
                userLabel={`${s.first_name ?? ''} ${s.last_name ?? ''}`.trim() || (s.username ?? 'user')}
                currentPlantIds={assignments}
                singlePlantOnly={isOperator}
                invalidateKeys={[['admin-users'], ['staff']]}
              />
            </div>
          </Card>
        );
      })}

      {filtered.length === 0 && (
        <Card className="p-4 text-center text-xs text-muted-foreground">
          {pendingOnly ? 'No pending approvals.' : 'No users found.'}
        </Card>
      )}

      <CreateUserDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={invalidate} />
    </div>
  );
}
