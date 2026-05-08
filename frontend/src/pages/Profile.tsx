import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useAppStore } from '@/store/appStore';
import { usePlants } from '@/hooks/usePlants';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { StatusPill } from '@/components/StatusPill';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { DesignationCombobox, accessLevelFromRoles } from '@/components/DesignationCombobox';
import { toast } from '@/components/ui/sonner';
import { Loader2, Pencil, ShieldCheck, Building2, MapPin } from 'lucide-react';

export default function Profile() {
  const { user, profile, activeOperator, roles, refreshProfile, loading } = useAuth();
  const { data: plants } = usePlants();
  const { selectedPlantId, setSelectedPlantId } = useAppStore();

  // activeOperator falls back to profile when no override is set (see useAuth)
  // so we detect an override by comparing ids
  const isOverride = !!activeOperator && !!profile && activeOperator.id !== profile.id;
  const displayProfile = activeOperator; // already equals profile when no override

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    first_name: '', middle_name: '', last_name: '', suffix: '',
    username: '', designation: '',
  });

  useEffect(() => {
    if (displayProfile) {
      setForm({
        first_name: displayProfile.first_name ?? '',
        middle_name: displayProfile.middle_name ?? '',
        last_name: displayProfile.last_name ?? '',
        suffix: displayProfile.suffix ?? '',
        username: displayProfile.username ?? '',
        designation: displayProfile.designation ?? '',
      });
    }
    // Exit edit mode whenever active operator changes
    setEditing(false);
  }, [displayProfile?.id]);

  // Preload designation hints from all known profiles for better suggestions
  const { data: existingDesignations } = useQuery({
    queryKey: ['designation-suggestions'],
    queryFn: async () => {
      const { data } = await supabase.from('user_profiles').select('designation');
      return Array.from(
        new Set(((data ?? []) as any[]).map((d) => d.designation).filter(Boolean)),
      ) as string[];
    },
  });

  const assignedPlants = useMemo(() => {
    if (!plants || !profile) return [];
    return plants.filter((p) => displayProfile?.plant_assignments?.includes(p.id));
  }, [plants, displayProfile]);

  const save = async () => {
    setSaving(true);
    try {
      const { error } = await supabase.rpc('update_own_profile', {
        _designation: form.designation || '',
        _first_name: form.first_name || '',
        _last_name: form.last_name || '',
        _middle_name: form.middle_name || '',
        _suffix: form.suffix || '',
        _username: form.username || '',
      });
      if (error) throw new Error(error.message);
      toast.success('Profile updated');
      await refreshProfile();
      setEditing(false);
    } catch (e: any) {
      toast.error(e?.message ?? 'Update failed');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  if (!user || !profile) {
    return (
      <Card className="p-6 text-sm text-muted-foreground" data-testid="profile-empty">
        Sign in to view your profile.
      </Card>
    );
  }

  const access = accessLevelFromRoles(roles);
  const displayName = [
    displayProfile?.first_name, displayProfile?.middle_name,
    displayProfile?.last_name, displayProfile?.suffix,
  ].filter(Boolean).join(' ') || '—';

  return (
    <div className="space-y-3 animate-fade-in" data-testid="profile-page">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight">{isOverride ? `${displayProfile?.first_name ?? ''} ${displayProfile?.last_name ?? ''} — Profile`.trim() : 'My profile'}</h1>
        {!editing && !isOverride && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setEditing(true)}
            data-testid="profile-edit-toggle"
          >
            <Pencil className="h-3 w-3 mr-1" /> Edit
          </Button>
        )}
      </div>

      {/* Plant selector — ensures plant choice is visible post-login */}
      <Card className="p-3" data-testid="profile-plant-selector">
        <div className="flex items-center gap-2">
          <Building2 className="h-4 w-4 text-accent" />
          <Label className="text-xs uppercase tracking-wide text-muted-foreground">
            Active plant
          </Label>
        </div>
        <Select
          value={selectedPlantId ?? 'all'}
          onValueChange={(v) => setSelectedPlantId(v === 'all' ? null : v)}
        >
          <SelectTrigger className="mt-2 w-full" data-testid="profile-plant-select">
            <SelectValue placeholder="Choose a plant…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All plants</SelectItem>
            {assignedPlants.map((p) => (
              <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground mt-1.5">
          You can always switch plant from the top-bar selector.
        </p>
      </Card>

      {/* Role / access level */}
      <Card className="p-3 space-y-2" data-testid="profile-role-card">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-accent" />
          <Label className="text-xs uppercase tracking-wide text-muted-foreground">
            Role & access
          </Label>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {roles.length === 0 && (
            <Badge variant="secondary">No role assigned</Badge>
          )}
          {roles.map((r) => (
            <Badge key={r} variant="outline" data-testid={`profile-role-${r}`}>
              {r}
            </Badge>
          ))}
          <StatusPill tone={access.tone}>{access.label}</StatusPill>
        </div>
        <div className="text-[11px] text-muted-foreground">
          Access level is computed from role:{' '}
          Admin → Full access · Manager → Elevated · Supervisor → Limited · others → Restricted.
        </div>
      </Card>

      {/* Identity */}
      <Card className="p-3 space-y-3" data-testid="profile-identity-card">
        <Label className="text-xs uppercase tracking-wide text-muted-foreground">
          Identity
        </Label>
        {editing ? (
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>First name</Label>
              <Input
                value={form.first_name}
                onChange={(e) => setForm({ ...form, first_name: e.target.value })}
                data-testid="profile-first-name"
              />
            </div>
            <div>
              <Label>Middle name</Label>
              <Input
                value={form.middle_name}
                onChange={(e) => setForm({ ...form, middle_name: e.target.value })}
              />
            </div>
            <div>
              <Label>Last name</Label>
              <Input
                value={form.last_name}
                onChange={(e) => setForm({ ...form, last_name: e.target.value })}
                data-testid="profile-last-name"
              />
            </div>
            <div>
              <Label>Suffix</Label>
              <Input
                value={form.suffix}
                onChange={(e) => setForm({ ...form, suffix: e.target.value })}
                placeholder="Jr., III…"
              />
            </div>
            <div className="col-span-2">
              <Label>Username</Label>
              <Input
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                data-testid="profile-username"
              />
            </div>
            <div className="col-span-2">
              <Label>Designation</Label>
              <DesignationCombobox
                value={form.designation}
                onChange={(v) => setForm({ ...form, designation: v })}
                extraOptions={existingDesignations}
                data-testid="profile-designation"
              />
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
            <Meta label="Name" value={displayName} />
            <Meta label="Username" value={displayProfile?.username ? `@${displayProfile.username}` : '—'} />
            <Meta label="Designation" value={displayProfile?.designation ?? '—'} />
            <Meta label="Email" value={user.email ?? '—'} />
            <Meta label="Status" value={displayProfile?.status ?? '—'} />
          </div>
        )}
        {editing && (
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving} data-testid="profile-save">
              {saving && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
              Save changes
            </Button>
          </div>
        )}
      </Card>

      {/* Assigned plants (EnumList badges) */}
      <Card className="p-3 space-y-2" data-testid="profile-plants-card">
        <div className="flex items-center gap-2">
          <MapPin className="h-4 w-4 text-accent" />
          <Label className="text-xs uppercase tracking-wide text-muted-foreground">
            Assigned plants ({assignedPlants.length})
          </Label>
        </div>
        {assignedPlants.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No plants assigned. Ask your Admin to add plants in the Admin console.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {assignedPlants.map((p) => (
              <Badge
                key={p.id}
                variant="outline"
                className="gap-1"
                data-testid={`profile-plant-badge-${p.id}`}
              >
                <Building2 className="h-3 w-3" />
                {p.name}
              </Badge>
            ))}
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">
          Plant assignments can only be changed by an Admin.
        </p>
      </Card>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium truncate">{value}</span>
    </>
  );
}
