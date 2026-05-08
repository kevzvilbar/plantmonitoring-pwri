import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth, type Profile } from '@/hooks/useAuth';
import { useAppStore } from '@/store/appStore';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ChevronDown, UserCheck, UserCog, LogOut } from 'lucide-react';
import { toast } from 'sonner';
import { useNavigate } from 'react-router-dom';

const API_BASE = (import.meta.env.VITE_BACKEND_URL as string) || '';

function initials(p: Profile | null): string {
  if (!p) return '?';
  return ((p.first_name?.[0] ?? '') + (p.last_name?.[0] ?? '')).toUpperCase() || '?';
}

function fullName(p: Profile | null): string {
  if (!p) return 'Unknown';
  return [p.first_name, p.last_name].filter(Boolean).join(' ') || p.username || 'Unknown';
}

const OPERATOR_DESIGNATIONS = ['Operator'];

function canSwitchOperator(profile: Profile | null): boolean {
  if (!profile?.designation) return false;
  return OPERATOR_DESIGNATIONS.includes(profile.designation);
}

/**
 * Fetches Active Operator profiles on the same plant(s).
 * Uses .contains() per plant id to work around PostgREST array overlap issues.
 */
function useSamePlantOperators(plantAssignments: string[]) {
  return useQuery<Profile[]>({
    queryKey: ['same-plant-operators', plantAssignments.join(',')],
    queryFn: async () => {
      if (plantAssignments.length === 0) return [];

      // Query once per plant and union — avoids .overlaps() PostgREST compatibility issues
      const results = await Promise.all(
        plantAssignments.map((pid) =>
          supabase
            .from('user_profiles')
            .select('*')
            .eq('status', 'Active')
            .eq('designation', 'Operator')
            .contains('plant_assignments', [pid])
            .order('first_name'),
        ),
      );

      // Merge and deduplicate by id
      const seen = new Set<string>();
      const merged: Profile[] = [];
      for (const { data } of results) {
        for (const row of data ?? []) {
          if (!seen.has(row.id)) {
            seen.add(row.id);
            merged.push(row as Profile);
          }
        }
      }
      // Sort by first name
      return merged.sort((a, b) =>
        (a.first_name ?? '').localeCompare(b.first_name ?? ''),
      );
    },
    enabled: plantAssignments.length > 0,
    staleTime: 30_000,
  });
}

async function logSwitchEvent(payload: {
  plant_id: string;
  from_username: string;
  to_username: string;
  device_id: string;
}) {
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    await fetch(`${API_BASE}/operator/switch-log`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch {
    console.warn('[OperatorSwitcher] Failed to post switch audit log');
  }
}

function getDeviceId(): string {
  const key = 'pwri-device-id';
  let id = localStorage.getItem(key);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(key, id); }
  return id;
}

export function OperatorSwitcher() {
  const { user, profile, activeOperator, signOut } = useAuth();
  const { activeOperatorId, setActiveOperatorId } = useAppStore();
  const navigate = useNavigate();

  const switchAllowed = canSwitchOperator(profile);
  const plantAssignments = profile?.plant_assignments ?? [];
  const { data: peers = [] } = useSamePlantOperators(
    switchAllowed ? plantAssignments : [],
  );

  const [pendingId, setPendingId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => { if (!open) setPendingId(null); }, [open]);

  const isOverride = activeOperatorId !== null && activeOperatorId !== user?.id;
  const avatarBg = isOverride ? 'bg-amber-500' : 'bg-accent';

  const handleSelect = async (p: Profile) => {
    const targetPlants: string[] = p.plant_assignments ?? [];
    const sessionPlants: string[] = profile?.plant_assignments ?? [];
    const sharedPlant = sessionPlants.find((pid) => targetPlants.includes(pid));

    if (!sharedPlant) {
      toast.error('Cannot switch: operator is not assigned to this plant.');
      setOpen(false);
      return;
    }

    if (p.id === user?.id) {
      setActiveOperatorId(null);
      setPendingId(null);
      setOpen(false);
      toast.success('Switched back to your own profile');
      return;
    }

    if (pendingId === p.id) {
      setActiveOperatorId(p.id);
      setPendingId(null);
      setOpen(false);
      toast.success(`Now recording as ${fullName(p)}`);
      await logSwitchEvent({
        plant_id: sharedPlant,
        from_username: profile?.username ?? user?.id ?? 'unknown',
        to_username: p.username ?? p.id,
        device_id: getDeviceId(),
      });
    } else {
      setPendingId(p.id);
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-1 hover:bg-topbar/40 rounded-full pl-1 pr-1.5 py-0.5 transition-colors">
          <div className="relative">
            <Avatar className="h-7 w-7">
              <AvatarFallback className={`${avatarBg} text-white text-[11px] font-semibold`}>
                {initials(activeOperator)}
              </AvatarFallback>
            </Avatar>
            {isOverride && (
              <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-amber-400 border-2 border-topbar flex items-center justify-center">
                <UserCheck className="h-1.5 w-1.5 text-white" />
              </span>
            )}
          </div>
          <ChevronDown className="h-3 w-3 text-topbar-muted" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-56">

        {/* Header */}
        <div className="px-3 py-2">
          <div className="flex items-center gap-1.5">
            {isOverride
              ? <UserCheck className="h-3 w-3 text-amber-500 shrink-0" />
              : <UserCog className="h-3 w-3 text-muted-foreground shrink-0" />
            }
            <span className="font-semibold text-xs truncate">{fullName(activeOperator)}</span>
          </div>
          <p className="text-[10px] text-muted-foreground pl-4 leading-tight">{activeOperator?.designation ?? 'Operator'}</p>
          {isOverride && (
            <p className="text-[10px] text-muted-foreground pl-4 leading-tight truncate">Logged in as {user?.email}</p>
          )}
        </div>

        <DropdownMenuSeparator className="my-0" />

        {/* Switch Operator — Operators only */}
        {switchAllowed && (
          <>
            <p className="px-3 pt-1.5 pb-0.5 text-[10px] uppercase tracking-widest text-muted-foreground font-medium">
              Switch operator
            </p>
            <div className="max-h-44 overflow-y-auto">
              {peers.length === 0 ? (
                <p className="px-3 py-2 text-[11px] text-muted-foreground text-center">
                  No other active operators at this plant
                </p>
              ) : (
                peers.map((p) => {
                  const isSelf = p.id === user?.id;
                  const isActive = (activeOperatorId ?? user?.id) === p.id;
                  const isPending = pendingId === p.id;
                  return (
                    <DropdownMenuItem
                      key={p.id}
                      className={`flex items-center gap-2 cursor-pointer py-1.5 px-3 ${isActive ? 'bg-accent/10' : ''} ${isPending ? 'bg-amber-50 dark:bg-amber-950/30' : ''}`}
                      onSelect={(e) => { e.preventDefault(); handleSelect(p); }}
                    >
                      <Avatar className="h-6 w-6 shrink-0">
                        <AvatarFallback className={`text-[9px] font-semibold ${isActive ? 'bg-accent text-white' : 'bg-muted text-muted-foreground'}`}>
                          {initials(p)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium truncate leading-tight">
                          {fullName(p)}
                          {isSelf && <span className="text-[10px] text-muted-foreground ml-1">(you)</span>}
                        </div>
                      </div>
                      {isActive && !isPending && (
                        <span className="h-1.5 w-1.5 rounded-full bg-accent shrink-0" />
                      )}
                      {isPending && (
                        <span className="text-[10px] text-amber-600 font-medium shrink-0">Confirm?</span>
                      )}
                    </DropdownMenuItem>
                  );
                })
              )}
            </div>
            <DropdownMenuSeparator className="my-0" />
          </>
        )}

        {/* Actions */}
        <DropdownMenuItem onClick={() => navigate('/profile')} className="gap-2 text-xs py-1.5">
          <UserCog className="h-3.5 w-3.5" /> My profile
        </DropdownMenuItem>
        <DropdownMenuItem onClick={signOut} className="text-danger gap-2 text-xs py-1.5">
          <LogOut className="h-3.5 w-3.5" /> Sign out
        </DropdownMenuItem>

      </DropdownMenuContent>
    </DropdownMenu>
  );
}
