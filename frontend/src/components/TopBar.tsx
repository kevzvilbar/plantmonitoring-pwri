import { Bell, AlertTriangle, Info } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useAppStore } from '@/store/appStore';
import { usePlants } from '@/hooks/usePlants';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useNavigate } from 'react-router-dom';
import { formatDistanceToNow, format } from 'date-fns';
import { OperatorSwitcher } from '@/components/OperatorSwitcher';
import { cn } from '@/lib/utils';

interface Notification {
  id: string;
  title: string;
  message: string | null;
  link_path: string | null;
  read: boolean;
  severity: string;
  created_at: string;
}

const EMPTY_NOTIFICATIONS: Notification[] = [];
const EMPTY_PLANTS: Array<{ id: string; name: string }> = [];

// ── Severity icon + colour helpers for PlantAlerts ───────────────────────────
const sevIcon = (severity: string) =>
  severity === 'critical' ? AlertTriangle :
  severity === 'warning'  ? AlertTriangle : Info;

const sevDotCls = (severity: string) =>
  severity === 'critical' ? 'bg-red-500' :
  severity === 'warning'  ? 'bg-amber-500' : 'bg-blue-500';

const sevTextCls = (severity: string) =>
  severity === 'critical' ? 'text-red-600 dark:text-red-400' :
  severity === 'warning'  ? 'text-amber-600 dark:text-amber-400' : 'text-blue-600 dark:text-blue-400';

export function TopBar() {
  const { user, profile } = useAuth();
  const { data: plants } = usePlants();
  const {
    selectedPlantId, setSelectedPlantId,
    setUnreadCount, unreadCount,
    plantAlerts, removeAlerts, clearAlerts,
  } = useAppStore();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const visiblePlants = useMemo(() => {
    if (!plants) return EMPTY_PLANTS;
    if (profile?.plant_assignments?.length) {
      return plants.filter((p) => profile.plant_assignments.includes(p.id));
    }
    return plants;
  }, [plants, profile?.plant_assignments]);

  const { data: notificationsData } = useQuery({
    queryKey: ['notifications', user?.id],
    queryFn: async (): Promise<Notification[]> => {
      if (!user) return EMPTY_NOTIFICATIONS;
      const { data } = await supabase
        .from('notifications')
        .select('id,title,message,link_path,read,severity,created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(20);
      return (data ?? EMPTY_NOTIFICATIONS) as Notification[];
    },
    enabled: !!user,
    refetchInterval: 60000,
  });

  const notifs = notificationsData ?? EMPTY_NOTIFICATIONS;
  const nextUnreadCount = useMemo(() => notifs.filter((n) => !n.read).length, [notifs]);

  useEffect(() => {
    if (unreadCount !== nextUnreadCount) {
      setUnreadCount(nextUnreadCount);
    }
  }, [nextUnreadCount, setUnreadCount, unreadCount]);

  // Clear plant alerts when user switches plant
  useEffect(() => {
    clearAlerts();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPlantId]);

  const markAllRead = async () => {
    if (!user) return;
    await supabase.from('notifications').update({ read: true }).eq('user_id', user.id).eq('read', false);
    qc.invalidateQueries({ queryKey: ['notifications'] });
  };

  // Total badge = DB unread notifs + in-memory plant alerts
  const totalBadge = unreadCount + plantAlerts.length;

  // Sorted plant alerts: critical first, then by newest
  const sortedAlerts = useMemo(() =>
    [...plantAlerts].sort((a, b) => {
      const order: Record<string, number> = { critical: 0, warning: 1, info: 2 };
      return (order[a.severity] ?? 9) - (order[b.severity] ?? 9) || b.timestamp - a.timestamp;
    }),
  [plantAlerts]);

  const hasCritical = plantAlerts.some((a) => a.severity === 'critical');

  return (
    <header className="sticky top-0 z-40 bg-topbar text-topbar-foreground border-b border-topbar/0 shadow-sm">
      <div className="flex items-center gap-2 sm:gap-4 px-3 sm:px-4 h-14">
        <div className="flex flex-col leading-tight">
          <span className="text-sm sm:text-base font-semibold tracking-tight">PWRI</span>
          <span className="text-[10px] sm:text-xs text-topbar-muted hidden sm:block">Monitoring & Alert System</span>
        </div>

        <div className="flex-1 flex justify-center">
          <Select
            value={selectedPlantId ?? 'all'}
            onValueChange={(v) => setSelectedPlantId(v === 'all' ? null : v)}
          >
            <SelectTrigger className="w-[140px] sm:w-[200px] h-9 bg-topbar/40 border-topbar-muted/30 text-topbar-foreground">
              <SelectValue placeholder="Select plant" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All plants</SelectItem>
              {visiblePlants.map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="relative text-topbar-foreground hover:bg-topbar/40 hover:text-topbar-foreground">
              <Bell className="h-5 w-5" />
              {totalBadge > 0 && (
                <span
                  className={cn(
                    'absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1',
                    'flex items-center justify-center rounded-full text-[10px] font-bold text-white leading-none',
                    hasCritical ? 'bg-red-500' : unreadCount > 0 ? 'bg-danger' : 'bg-amber-500',
                  )}
                  aria-label={`${totalBadge} alerts`}
                >
                  {totalBadge > 99 ? '99+' : totalBadge}
                </span>
              )}
            </Button>
          </DropdownMenuTrigger>

          <DropdownMenuContent align="end" className="w-80 max-h-[75vh] overflow-y-auto">

            {/* ── Plant Alerts section (in-memory, from modules) ─────────── */}
            {sortedAlerts.length > 0 && (
              <>
                <DropdownMenuLabel className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
                    Plant Alerts
                    <span className={cn(
                      'text-[10px] font-bold px-1.5 py-0.5 rounded-full ml-1',
                      hasCritical
                        ? 'bg-red-100 text-red-700 dark:bg-red-900/60 dark:text-red-300'
                        : 'bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-300',
                    )}>
                      {sortedAlerts.length}
                    </span>
                  </span>
                  <button
                    onClick={clearAlerts}
                    className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
                  >
                    Clear all
                  </button>
                </DropdownMenuLabel>

                {sortedAlerts.map((alert) => {
                  const Icon = sevIcon(alert.severity);
                  return (
                    <div
                      key={alert.id}
                      className={cn(
                        'flex gap-2.5 px-3 py-2.5 border-b border-border/40 last:border-0',
                        alert.severity === 'critical' && 'bg-red-50/60 dark:bg-red-950/20',
                        alert.severity === 'warning'  && 'bg-amber-50/60 dark:bg-amber-950/20',
                      )}
                    >
                      <Icon className={cn('h-4 w-4 mt-0.5 shrink-0', sevTextCls(alert.severity))} />
                      <div className="flex-1 min-w-0 space-y-0.5">
                        <div className="flex items-start justify-between gap-1">
                          <span className={cn('text-xs font-semibold leading-snug', sevTextCls(alert.severity))}>
                            {alert.title}
                          </span>
                          <button
                            onClick={() => removeAlerts([alert.id])}
                            className="text-muted-foreground/50 hover:text-muted-foreground text-[10px] shrink-0 ml-1"
                            aria-label="Dismiss"
                          >
                            ✕
                          </button>
                        </div>
                        <p className="text-xs text-muted-foreground leading-snug">{alert.description}</p>
                        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/60">
                          <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', sevDotCls(alert.severity))} />
                          <span>{alert.source}</span>
                          <span>·</span>
                          <span>{format(new Date(alert.timestamp), 'hh:mm aa')}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}

                <DropdownMenuSeparator />
              </>
            )}

            {/* ── DB Notifications section ──────────────────────────────── */}
            <DropdownMenuLabel className="flex items-center justify-between">
              <span>Notifications</span>
              {unreadCount > 0 && (
                <button onClick={markAllRead} className="text-xs text-accent hover:underline">Mark all read</button>
              )}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {notifs.length === 0 && (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">No notifications</div>
            )}
            {notifs.map((n) => (
              <DropdownMenuItem
                key={n.id}
                onClick={() => n.link_path && navigate(n.link_path)}
                className="flex flex-col items-start gap-1 py-2"
              >
                <div className="flex items-center gap-2 w-full">
                  {!n.read && <span className="h-2 w-2 rounded-full bg-danger flex-shrink-0" />}
                  <span className="text-sm font-medium flex-1">{n.title}</span>
                  <span className="text-[10px] text-muted-foreground">{formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}</span>
                </div>
                {n.message && <div className="text-xs text-muted-foreground line-clamp-2">{n.message}</div>}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Operator switcher replaces the old static avatar + sign-out dropdown */}
        <OperatorSwitcher />
      </div>
    </header>
  );
}
