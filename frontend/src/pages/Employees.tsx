import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MessageSquare, X, Send, Loader2, Clock,
  Building2, User, ShieldCheck, MapPin, ChevronRight,
  Users, CheckCircle2, AlertCircle, BookOpen, ChevronDown,
  BarChart3, GitBranch, ClipboardList,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { usePlants } from '@/hooks/usePlants';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DeleteEntityMenu } from '@/components/DeleteEntityMenu';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ChatMsg = {
  id: string;
  sender_id: string;
  recipient_id: string;
  body: string;
  sent_at: string;
  expires_at: string;
};

type StaffMember = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  middle_name: string | null;
  suffix: string | null;
  username: string | null;
  designation: string | null;
  plant_assignments: string[];
  status: string;
  updated_at: string;
  immediate_head_id: string | null;
};

// ---------------------------------------------------------------------------
// Presence helpers
// ---------------------------------------------------------------------------

type PresenceState = 'active' | 'idle' | 'away' | 'offline';

function getPresence(updatedAt: string, accountStatus: string): PresenceState {
  if (accountStatus === 'Suspended' || accountStatus === 'Pending') return 'offline';
  const diffMin = (Date.now() - new Date(updatedAt).getTime()) / 60_000;
  if (diffMin < 15)  return 'active';
  if (diffMin < 60)  return 'idle';
  if (diffMin < 480) return 'away';
  return 'offline';
}

const presenceConfig: Record<PresenceState, { label: string; dot: string; badge: string }> = {
  active:  { label: 'Active',  dot: 'bg-emerald-500', badge: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  idle:    { label: 'Idle',    dot: 'bg-amber-400',   badge: 'bg-amber-50 text-amber-700 border-amber-200' },
  away:    { label: 'Away',    dot: 'bg-orange-400',  badge: 'bg-orange-50 text-orange-700 border-orange-200' },
  offline: { label: 'Offline', dot: 'bg-zinc-300',    badge: 'bg-zinc-50 text-zinc-500 border-zinc-200' },
};

// ---------------------------------------------------------------------------
// Per-user deterministic colour accent
// ---------------------------------------------------------------------------

const TILE_ACCENTS = [
  'border-l-sky-400', 'border-l-violet-400', 'border-l-teal-400', 'border-l-rose-400',
  'border-l-amber-400', 'border-l-indigo-400', 'border-l-emerald-400', 'border-l-pink-400',
];

const AVATAR_COLORS = [
  'bg-sky-500', 'bg-violet-500', 'bg-teal-500', 'bg-rose-500',
  'bg-amber-500', 'bg-indigo-500', 'bg-emerald-500', 'bg-pink-500',
];

function hashId(id: string) {
  return id.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
}

function accentForId(id: string)  { return TILE_ACCENTS[hashId(id) % TILE_ACCENTS.length]; }
function avatarColor(id: string)  { return AVATAR_COLORS[hashId(id) % AVATAR_COLORS.length]; }

function initials(s: StaffMember) {
  const f = s.first_name?.[0] ?? '';
  const l = s.last_name?.[0] ?? '';
  return (f + l).toUpperCase() || (s.username?.[0] ?? '?').toUpperCase();
}

function fullName(s: StaffMember) {
  return [s.first_name, s.middle_name ? s.middle_name[0] + '.' : null, s.last_name, s.suffix]
    .filter(Boolean).join(' ') || s.username || 'Unknown';
}

// ---------------------------------------------------------------------------
// Chat helpers
// ---------------------------------------------------------------------------

function timeUntilExpiry(expiresAt: string) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ---------------------------------------------------------------------------
// Chat Window
// ---------------------------------------------------------------------------

function ChatWindow({ peer, currentUserId, onClose }: {
  peer: StaffMember; currentUserId: string; onClose: () => void;
}) {
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Fetch messages for this conversation (both directions, non-expired).
  const fetchMessages = useCallback(async (): Promise<ChatMsg[]> => {
    const { data, error } = await (supabase as any)
      .from('chat_messages').select('*')
      .or(`and(sender_id.eq.${currentUserId},recipient_id.eq.${peer.id}),and(sender_id.eq.${peer.id},recipient_id.eq.${currentUserId})`)
      .gt('expires_at', new Date().toISOString())
      .order('sent_at', { ascending: true });
    if (error) throw error;
    return (data ?? []) as ChatMsg[];
  }, [currentUserId, peer.id]);

  const { data: messages = [], refetch } = useQuery<ChatMsg[]>({
    queryKey: ['chat', currentUserId, peer.id],
    queryFn: fetchMessages,
    // Fallback polling every 3 s in case realtime broadcast misses an event.
    refetchInterval: 3000,
  });

  useEffect(() => {
    // Use a Broadcast channel (no REPLICA IDENTITY FULL required) so both the
    // sender and receiver are notified the moment a message is inserted.
    // Channel name is deterministic for the pair so both sides join the same room.
    const channelName = `chat:${[currentUserId, peer.id].sort().join(':')}`;
    const ch = supabase
      .channel(channelName)
      .on('broadcast', { event: 'new_message' }, () => refetch())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [currentUserId, peer.id, refetch]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages.length]);

  const send = useCallback(async () => {
    const body = input.trim();
    if (!body) return;
    setInput(''); setSending(true);
    try {
      // 1. Persist the message to the DB.
      await (supabase as any).from('chat_messages').insert({ sender_id: currentUserId, recipient_id: peer.id, body });
      // 2. Broadcast to the shared channel so the peer's window refetches immediately.
      const channelName = `chat:${[currentUserId, peer.id].sort().join(':')}`;
      await supabase.channel(channelName).send({ type: 'broadcast', event: 'new_message', payload: {} });
      // 3. Refetch our own window immediately too.
      refetch();
    } finally { setSending(false); }
  }, [input, currentUserId, peer.id, refetch]);

  const presence = getPresence(peer.updated_at, peer.status);
  const pc = presenceConfig[presence];

  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 shadow-2xl rounded-xl overflow-hidden border border-border bg-background flex flex-col" style={{ height: 420 }}>
      <div className="flex items-center gap-2 px-3 py-2 bg-gradient-to-r from-sky-600 to-teal-600 text-white shrink-0">
        <div className={cn('h-8 w-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0', avatarColor(peer.id))}>
          {initials(peer)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm truncate">{fullName(peer)}</div>
          <div className="flex items-center gap-1 text-[10px] opacity-80">
            <span className={cn('h-1.5 w-1.5 rounded-full', pc.dot)} />
            {pc.label} · @{peer.username ?? '—'}
          </div>
        </div>
        <Button size="icon" variant="ghost" className="h-6 w-6 text-white hover:bg-white/20" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 border-b border-amber-100 text-amber-700 text-[10px] shrink-0">
        <Clock className="h-3 w-3 shrink-0" />
        Messages auto-delete after 8 hours. No content is retained.
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {messages.length === 0
          ? <div className="h-full flex items-center justify-center text-xs text-muted-foreground text-center px-4">No messages yet. Say hello!</div>
          : messages.map((m) => {
              const mine = m.sender_id === currentUserId;
              return (
                <div key={m.id} className={cn('flex flex-col gap-0.5', mine ? 'items-end' : 'items-start')}>
                  <div className={cn('rounded-lg px-2.5 py-1.5 text-xs max-w-[85%] break-words',
                    mine ? 'bg-sky-600 text-white rounded-br-sm' : 'bg-muted text-foreground rounded-bl-sm')}>
                    {m.body}
                  </div>
                  <div className="flex items-center gap-1 text-[9px] text-muted-foreground px-0.5">
                    <span>{formatTime(m.sent_at)}</span><span>·</span>
                    <Clock className="h-2.5 w-2.5" /><span>{timeUntilExpiry(m.expires_at)}</span>
                  </div>
                </div>
              );
            })}
        <div ref={bottomRef} />
      </div>

      <div className="border-t p-2 flex gap-1.5 shrink-0">
        <Input value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Type a message…" className="flex-1 h-8 text-xs" disabled={sending} autoFocus />
        <Button size="sm" className="h-8 px-2" onClick={send} disabled={sending || !input.trim()}>
          {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// InfoRow helper
// ---------------------------------------------------------------------------

function InfoRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex gap-2.5">
      <div className="text-muted-foreground mt-0.5 shrink-0">{icon}</div>
      <div className="min-w-0">
        <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</div>
        <div className="text-sm break-words">{value}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail Drawer
// ---------------------------------------------------------------------------

function DetailDrawer({ member, roles, plants, allStaff, onChat, onClose, isSelf, isAdmin }: {
  member: StaffMember; roles: any[]; plants: any[]; allStaff: StaffMember[];
  onChat: () => void; onClose: () => void; isSelf: boolean; isAdmin: boolean;
}) {
  const presence = getPresence(member.updated_at, member.status);
  const pc = presenceConfig[presence];
  const memberRoles = roles.filter((r) => r.user_id === member.id).map((r) => r.role);
  const memberPlants = plants.filter((p) => member.plant_assignments?.includes(p.id)).map((p) => p.name);
  const head = allStaff.find((s) => s.id === member.immediate_head_id);

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <div className="fixed right-0 top-0 bottom-0 z-50 w-80 bg-background border-l shadow-2xl flex flex-col">
        <div className={cn('h-1.5 w-full', avatarColor(member.id))} />
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <span className="text-sm font-semibold">Employee Details</span>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="flex flex-col items-center pt-6 pb-4 px-4 text-center">
            <div className={cn('h-16 w-16 rounded-full flex items-center justify-center text-xl font-bold text-white mb-3', avatarColor(member.id))}>
              {initials(member)}
            </div>
            <div className="font-semibold text-base">{fullName(member)}</div>
            <div className="text-xs text-muted-foreground mt-0.5">@{member.username ?? '—'}</div>
            <div className={cn('flex items-center gap-1.5 mt-2 text-xs px-2.5 py-1 rounded-full border font-medium', pc.badge)}>
              <span className={cn('h-2 w-2 rounded-full', pc.dot)} />
              {pc.label}
            </div>
          </div>

          <div className="px-4 space-y-3 pb-6">
            <InfoRow icon={<User className="h-3.5 w-3.5" />}       label="Designation"  value={member.designation ?? '—'} />
            <InfoRow icon={<ShieldCheck className="h-3.5 w-3.5" />} label="Role(s)"      value={memberRoles.join(', ') || '—'} />
            <InfoRow icon={<Building2 className="h-3.5 w-3.5" />}  label="Plants"       value={memberPlants.join(', ') || '—'} />
            <InfoRow icon={<MapPin className="h-3.5 w-3.5" />}     label="Reports to"   value={head ? fullName(head) : '—'} />
            <InfoRow icon={<Clock className="h-3.5 w-3.5" />}      label="Account status" value={member.status} />
          </div>
        </div>

        <div className="border-t p-4 flex gap-2">
          {!isSelf && (
            <Button className="flex-1 gap-1.5" size="sm" onClick={() => { onChat(); onClose(); }}>
              <MessageSquare className="h-3.5 w-3.5" /> Chat
            </Button>
          )}
          {isAdmin && (
            <DeleteEntityMenu
              kind="user" id={member.id} label={fullName(member)}
              canSoftDelete={member.status === 'Active'} canHardDelete
              invalidateKeys={[['staff'], ['all-roles']]} compact
            />
          )}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Staff Tile
// ---------------------------------------------------------------------------

function StaffTile({ member, roles, isSelf, onChat, onDetail }: {
  member: StaffMember; roles: any[]; isSelf: boolean; onChat: () => void; onDetail: () => void;
}) {
  const presence = getPresence(member.updated_at, member.status);
  const pc = presenceConfig[presence];
  const memberRole = (roles as any[]).find((r) => r.user_id === member.id)?.role ?? '—';

  return (
    <div
      className={cn(
        'relative bg-card rounded-lg border border-l-4 p-3 flex flex-col gap-2',
        'hover:shadow-md transition-shadow cursor-pointer group',
        accentForId(member.id),
      )}
      onClick={onDetail}
    >
      <div className="flex items-start gap-2.5">
        <div className="relative shrink-0">
          <div className={cn('h-10 w-10 rounded-full flex items-center justify-center text-sm font-bold text-white', avatarColor(member.id))}>
            {initials(member)}
          </div>
          <span className={cn('absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-background', pc.dot)} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm leading-tight truncate">
            {fullName(member)}
            {isSelf && <span className="ml-1 text-[10px] text-muted-foreground">(you)</span>}
          </div>
          <div className="text-[11px] text-muted-foreground truncate">{member.designation ?? '—'}</div>
        </div>
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0 mt-1" />
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[10px] bg-muted text-muted-foreground px-1.5 py-0.5 rounded font-medium">{memberRole}</span>
        <span className={cn('text-[10px] px-1.5 py-0.5 rounded border font-medium', pc.badge)}>{pc.label}</span>
        <div className="flex-1" />
        {!isSelf && (
          <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] gap-1 hover:bg-sky-50 hover:text-sky-700"
            onClick={(e) => { e.stopPropagation(); onChat(); }}>
            <MessageSquare className="h-3 w-3" /> Chat
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Staff tab
// ---------------------------------------------------------------------------

function Staff() {
  const { data: plants } = usePlants();
  // activeOperator = the switched-to operator (or own profile if no switch).
  // All presence/identity logic must use activeOperator, NOT raw user.
  const { isAdmin, user, activeOperator } = useAuth();
  const queryClient = useQueryClient();

  const [chatPeer, setChatPeer] = useState<StaffMember | null>(null);
  const [detailMember, setDetailMember] = useState<StaffMember | null>(null);

  // Heartbeat: touch updated_at for the ACTIVE OPERATOR so their tile shows
  // "Active" while the session is in use. Also patch the query cache immediately
  // so the dot flips without waiting for the next DB refetch.
  useEffect(() => {
    const operatorId = activeOperator?.id ?? user?.id;
    if (!operatorId) return;
    const heartbeat = async () => {
      const now = new Date().toISOString();
      await supabase.from('user_profiles').update({ updated_at: now }).eq('id', operatorId);
      queryClient.setQueryData<StaffMember[]>(['staff'], (prev) =>
        prev?.map((s) => s.id === operatorId ? { ...s, updated_at: now } : s) ?? prev
      );
    };
    heartbeat();
    const interval = setInterval(heartbeat, 2 * 60 * 1000);
    return () => clearInterval(interval);
  // Re-run whenever the active operator switches so the new operator gets the heartbeat.
  }, [activeOperator?.id, user?.id, queryClient]);

  const { data: staff = [], refetch: refetchStaff } = useQuery<StaffMember[]>({
    queryKey: ['staff'],
    queryFn: async () => {
      // FIX: Use an RPC with SECURITY DEFINER to bypass RLS so that Operators
      // can see ALL staff (including Managers and Admins) for communication.
      // Falls back to a direct select (which RLS may restrict for non-admins).
      const { data: rpcData, error: rpcError } = await (supabase as any).rpc('get_all_staff_profiles');
      if (!rpcError && rpcData) return rpcData as StaffMember[];

      // Fallback: direct select (will be limited by RLS for non-admin roles)
      const { data, error } = await supabase.from('user_profiles').select('*').order('last_name');
      if (error) throw error;
      return (data ?? []) as StaffMember[];
    },
    // Refresh every 30 s; staleTime 0 so presence dots are always fresh.
    refetchInterval: 30_000,
    staleTime: 0,
  });

  // FIX: Subscribe to realtime updated_at changes so that when any user's
  // heartbeat fires the staff list re-fetches and their presence dot updates.
  useEffect(() => {
    const ch = supabase
      .channel('staff-presence')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'user_profiles' }, () => {
        refetchStaff();
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [refetchStaff]);

  // FIX: Use RPC to get all roles — bypasses RLS so non-admins see correct
  // role labels for all users (not just their own row from user_roles).
  const { data: roles = [] } = useQuery({
    queryKey: ['all-roles'],
    queryFn: async () => {
      const { data: rpcData, error: rpcError } = await (supabase as any).rpc('get_all_user_roles');
      if (!rpcError && rpcData) return rpcData as { user_id: string; role: string }[];

      const { data } = await supabase
        .from('user_profiles')
        .select('id, user_roles(role)');
      return (data ?? []).flatMap((p: any) =>
        (p.user_roles ?? []).map((r: any) => ({ user_id: p.id, role: r.role }))
      );
    },
  });

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {staff.map((s) => (
          <StaffTile key={s.id} member={s} roles={roles as any[]}
            isSelf={s.id === (activeOperator?.id ?? user?.id)}
            onChat={() => setChatPeer(s)}
            onDetail={() => setDetailMember(s)}
          />
        ))}
        {staff.length === 0 && (
          <div className="col-span-full">
            <Card className="p-6 text-xs text-center text-muted-foreground">No staff found</Card>
          </div>
        )}
      </div>

      {detailMember && (
        <DetailDrawer
          member={detailMember} roles={roles as any[]} plants={plants ?? []} allStaff={staff}
          isSelf={detailMember.id === (activeOperator?.id ?? user?.id)} isAdmin={isAdmin}
          onChat={() => setChatPeer(detailMember)}
          onClose={() => setDetailMember(null)}
        />
      )}

      {chatPeer && user && chatPeer.id !== (activeOperator?.id ?? user.id) && (
        <ChatWindow peer={chatPeer} currentUserId={activeOperator?.id ?? user.id} onClose={() => setChatPeer(null)} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Org Chart Node (recursive)
// ---------------------------------------------------------------------------

function OrgNode({ member, allStaff, roles, depth = 0 }: {
  member: StaffMember; allStaff: StaffMember[]; roles: any[]; depth?: number;
}) {
  const [expanded, setExpanded] = useState(depth < 2);
  const children = allStaff.filter((s) => s.immediate_head_id === member.id);
  const memberRole = (roles as any[]).find((r) => r.user_id === member.id)?.role ?? '—';
  const hasChildren = children.length > 0;

  return (
    <div className={cn('flex flex-col', depth > 0 && 'ml-5 border-l border-dashed border-muted-foreground/30 pl-4 mt-1')}>
      <div
        className={cn(
          'flex items-center gap-2 py-1.5 px-2 rounded-md group',
          hasChildren && 'cursor-pointer hover:bg-muted/50',
        )}
        onClick={() => hasChildren && setExpanded((p) => !p)}
      >
        <div className={cn('h-7 w-7 rounded-full flex items-center justify-center text-[11px] font-bold text-white shrink-0', avatarColor(member.id))}>
          {initials(member)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium leading-none truncate">{fullName(member)}</div>
          <div className="text-[10px] text-muted-foreground mt-0.5 truncate">
            {member.designation
              ? <><span>{member.designation}</span><span className="mx-1 opacity-40">·</span><span>{memberRole}</span></>
              : memberRole}
          </div>
        </div>
        {hasChildren && (
          <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform', expanded && 'rotate-180')} />
        )}
      </div>
      {expanded && hasChildren && children.map((child) => (
        <OrgNode key={child.id} member={child} allStaff={allStaff} roles={roles} depth={depth + 1} />
      ))}
    </div>
  );
}

function OrgChart({ staff, roles }: { staff: StaffMember[]; roles: any[] }) {
  // Root members = those with no immediate_head_id, or whose head_id doesn't exist in the list
  const staffIds = new Set(staff.map((s) => s.id));
  const roots = staff.filter((s) => !s.immediate_head_id || !staffIds.has(s.immediate_head_id));

  if (roots.length === 0) {
    return <p className="text-xs text-muted-foreground text-center py-4">No reporting relationships configured.</p>;
  }

  return (
    <div className="space-y-1">
      {roots.map((r) => <OrgNode key={r.id} member={r} allStaff={staff} roles={roles} depth={0} />)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Staff Directory Stats
// ---------------------------------------------------------------------------

const ROLES = ['Admin', 'Manager', 'Technician', 'Operator'] as const;

function DirectoryStats({ staff, roles, plants }: { staff: StaffMember[]; roles: any[]; plants: any[] }) {
  const activeCount = staff.filter((s) => s.status === 'Active').length;

  const roleCounts = ROLES.map((role) => ({
    role,
    count: (roles as any[]).filter((r) => r.role === role).length,
  }));

  const coveredPlantIds = new Set(staff.flatMap((s) => s.plant_assignments ?? []));
  const plantsCount = plants.filter((p) => coveredPlantIds.has(p.id)).length;

  const statItems = [
    { label: 'Total Staff', value: staff.length, icon: <Users className="h-4 w-4" />, color: 'text-sky-600' },
    { label: 'Active', value: activeCount, icon: <CheckCircle2 className="h-4 w-4" />, color: 'text-emerald-600' },
    { label: 'Plants Covered', value: plantsCount, icon: <Building2 className="h-4 w-4" />, color: 'text-violet-600' },
  ];

  return (
    <div className="space-y-3">
      {/* Summary row */}
      <div className="grid grid-cols-3 gap-2">
        {statItems.map((s) => (
          <div key={s.label} className="flex flex-col items-center bg-muted/50 rounded-lg py-3 px-2 text-center gap-1">
            <span className={s.color}>{s.icon}</span>
            <span className="text-xl font-bold leading-none">{s.value}</span>
            <span className="text-[10px] text-muted-foreground">{s.label}</span>
          </div>
        ))}
      </div>
      {/* Role breakdown */}
      <div className="grid grid-cols-2 gap-2">
        {roleCounts.map(({ role, count }) => (
          <div key={role} className="flex items-center justify-between bg-muted/30 rounded-md px-3 py-2">
            <span className="text-xs text-muted-foreground">{role}</span>
            <span className="text-sm font-semibold">{count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pending Approvals (admin only)
// ---------------------------------------------------------------------------

function PendingApprovals({ staff }: { staff: StaffMember[] }) {
  const queryClient = useQueryClient();
  const [approving, setApproving] = useState<string | null>(null);

  const pending = staff.filter((s) => s.status === 'Pending');

  const approve = useCallback(async (id: string) => {
    setApproving(id);
    try {
      // Set confirmed = true in user_profiles; adjust field name to match your schema
      await (supabase as any)
        .from('user_profiles')
        .update({ confirmed: true, status: 'Active' })
        .eq('id', id);
      queryClient.invalidateQueries({ queryKey: ['staff'] });
    } finally {
      setApproving(null);
    }
  }, [queryClient]);

  if (pending.length === 0) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-3">
        <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
        No pending approvals. All accounts are active.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {pending.map((s) => (
        <div key={s.id} className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          <div className={cn('h-8 w-8 rounded-full flex items-center justify-center text-[11px] font-bold text-white shrink-0', avatarColor(s.id))}>
            {initials(s)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">{fullName(s)}</div>
            <div className="text-[11px] text-muted-foreground">@{s.username ?? '—'} · {s.designation ?? 'No designation'}</div>
          </div>
          <Button
            size="sm" variant="outline"
            className="h-7 px-2 text-[11px] text-emerald-700 border-emerald-300 hover:bg-emerald-50 shrink-0"
            disabled={approving === s.id}
            onClick={() => approve(s.id)}
          >
            {approving === s.id ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Approve'}
          </Button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// App Manual
// ---------------------------------------------------------------------------

type ManualSection = { title: string; icon: React.ReactNode; content: React.ReactNode };

const MANUAL_SECTIONS: ManualSection[] = [
  {
    title: 'Getting Started',
    icon: <BookOpen className="h-3.5 w-3.5" />,
    content: (
      <div className="space-y-2 text-xs text-muted-foreground">
        <p>New staff sign up on the login page using their email and password. After email confirmation, they complete a profile setup (plants, designation, etc.).</p>
        <p>An <strong className="text-foreground">Admin</strong> must then review and approve the account. New users default to <strong className="text-foreground">Pending</strong> status and cannot access the app until approved.</p>
      </div>
    ),
  },
  {
    title: 'Roles & Permissions',
    icon: <ShieldCheck className="h-3.5 w-3.5" />,
    content: (
      <div className="space-y-1.5 text-xs">
        {[
          { role: 'Admin', desc: 'Full access — manage staff, approve accounts, configure plants, access all data and exports.' },
          { role: 'Manager', desc: 'View and manage operations, maintenance, compliance, and incidents across assigned plants.' },
          { role: 'Technician', desc: 'Log readings, submit maintenance records, and manage incidents for assigned plants.' },
          { role: 'Operator', desc: 'View-only access to operations and dashboard. Can chat with colleagues.' },
        ].map(({ role, desc }) => (
          <div key={role} className="flex gap-2">
            <span className="font-semibold text-foreground w-20 shrink-0">{role}</span>
            <span className="text-muted-foreground">{desc}</span>
          </div>
        ))}
      </div>
    ),
  },
  {
    title: 'Staff Directory',
    icon: <Users className="h-3.5 w-3.5" />,
    content: (
      <div className="space-y-2 text-xs text-muted-foreground">
        <p>The <strong className="text-foreground">Staff</strong> tab lists all registered users. Click any tile to view their full profile — designation, role, plant assignments, and who they report to.</p>
        <p>Use the <strong className="text-foreground">Chat</strong> button to send ephemeral messages (auto-deleted after 8 hours). Admins can suspend or delete accounts from the detail drawer.</p>
      </div>
    ),
  },
  {
    title: 'Org Chart',
    icon: <GitBranch className="h-3.5 w-3.5" />,
    content: (
      <div className="text-xs text-muted-foreground">
        <p>The reporting tree is built from the <strong className="text-foreground">immediate_head_id</strong> field on each profile. During onboarding or via the Admin Console, each user's direct supervisor can be set. The chart auto-nests and is collapsible at each level.</p>
      </div>
    ),
  },
  {
    title: 'Plants & Operations',
    icon: <Building2 className="h-3.5 w-3.5" />,
    content: (
      <div className="space-y-2 text-xs text-muted-foreground">
        <p>Each plant has its own wells, locators, RO trains, and chemical dosing configuration. Staff are assigned to plants; their access is scoped accordingly.</p>
        <p>Daily readings (flow, pressure, energy, pH) are logged under each plant. Data is queryable through the AI Assistant and exportable via <strong className="text-foreground">Data Exports</strong>.</p>
      </div>
    ),
  },
  {
    title: 'Maintenance & Incidents',
    icon: <ClipboardList className="h-3.5 w-3.5" />,
    content: (
      <div className="space-y-2 text-xs text-muted-foreground">
        <p><strong className="text-foreground">PM Schedule</strong> tracks preventive maintenance tasks with due dates and completion status. Overdue items are flagged automatically.</p>
        <p><strong className="text-foreground">Incidents</strong> records downtime events, equipment failures, and safety observations. Each incident can be linked to a specific plant and tagged with a severity level.</p>
      </div>
    ),
  },
];

function AppManual() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <div className="space-y-1.5">
      {MANUAL_SECTIONS.map((s, i) => (
        <div key={i} className="border rounded-lg overflow-hidden">
          <button
            className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-muted/40 transition-colors"
            onClick={() => setOpen((p) => (p === i ? null : i))}
          >
            <span className="text-muted-foreground">{s.icon}</span>
            <span className="text-sm font-medium flex-1">{s.title}</span>
            <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', open === i && 'rotate-180')} />
          </button>
          {open === i && (
            <div className="px-4 pb-3 pt-1 border-t bg-muted/20">
              {s.content}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Info Tab (enhanced)
// ---------------------------------------------------------------------------

function RegisterInfo() {
  const { isAdmin } = useAuth();
  const { data: plants = [] } = usePlants();

  // FIX: Reuse the same 'staff' queryKey so this shares the cached result
  // from Staff tab (which already uses the RPC to bypass RLS).
  const { data: staff = [] } = useQuery<StaffMember[]>({
    queryKey: ['staff'],
    queryFn: async () => {
      const { data: rpcData, error: rpcError } = await (supabase as any).rpc('get_all_staff_profiles');
      if (!rpcError && rpcData) return rpcData as StaffMember[];
      const { data, error } = await supabase.from('user_profiles').select('*').order('last_name');
      if (error) throw error;
      return (data ?? []) as StaffMember[];
    },
    staleTime: 30_000,
  });

  const { data: roles = [] } = useQuery({
    queryKey: ['all-roles'],
    queryFn: async () => {
      // FIX: Use RPC to get all roles bypassing RLS, so Managers/Admins show
      // the correct role label in the Reporting Tree instead of "Operator".
      const { data: rpcData, error: rpcError } = await (supabase as any).rpc('get_all_user_roles');
      if (!rpcError && rpcData) return rpcData as { user_id: string; role: string }[];

      const { data } = await supabase
        .from('user_profiles')
        .select('id, user_roles(role)');
      return (data ?? []).flatMap((p: any) =>
        (p.user_roles ?? []).map((r: any) => ({ user_id: p.id, role: r.role }))
      );
    },
  });

  return (
    <div className="space-y-4">

      {/* 1. Staff Directory Stats */}
      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-semibold text-sm">Directory Overview</h3>
        </div>
        <DirectoryStats staff={staff} roles={roles} plants={plants} />
      </Card>

      {/* 2. Org Chart */}
      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-semibold text-sm">Reporting Tree</h3>
        </div>
        <OrgChart staff={staff} roles={roles} />
      </Card>

      {/* 3. Pending Approvals — admin only */}
      {isAdmin && (
        <Card className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-amber-500" />
            <h3 className="font-semibold text-sm">Pending Approvals</h3>
            {staff.filter((s) => s.status === 'Pending').length > 0 && (
              <span className="ml-auto text-[10px] font-semibold bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">
                {staff.filter((s) => s.status === 'Pending').length} pending
              </span>
            )}
          </div>
          <PendingApprovals staff={staff} />
        </Card>
      )}

      {/* 4. App Manual */}
      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-semibold text-sm">App Manual</h3>
        </div>
        <AppManual />
      </Card>

    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Employees() {
  return (
    <div className="space-y-3 animate-fade-in">
      <h1 className="text-xl font-semibold tracking-tight">Employees</h1>
      <Tabs defaultValue="staff">
        <TabsList className="grid grid-cols-2 w-full">
          <TabsTrigger value="staff">Staff</TabsTrigger>
          <TabsTrigger value="info">Info</TabsTrigger>
        </TabsList>
        <TabsContent value="staff" className="mt-3"><Staff /></TabsContent>
        <TabsContent value="info" className="mt-3"><RegisterInfo /></TabsContent>
      </Tabs>
    </div>
  );
}
