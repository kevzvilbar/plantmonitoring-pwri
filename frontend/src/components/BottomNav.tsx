import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Menu,
  Building2, Droplet, Cog,
  Wrench, AlertTriangle, DollarSign, Users, Download, Upload, Sparkles, ShieldCheck,
  ShieldAlert,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger,
} from '@/components/ui/sheet';

// Priority items for mobile bottom nav (Dashboard centered).
// Wells + Locators are combined into a single entry on mobile so the bottom
// bar fits a 5-icon layout (Plants · Wells & Locators · Dashboard · RO Trains · More).
type Priority = {
  to: string;
  label: string;
  icon: any;
  match?: string[];
  // Optional precise active check: returns true when the current `tab` query
  // value (lower-cased) is one of the given values. Preferred over loose
  // substring matching against the full URL.
  matchTabValues?: string[];
};

const leftPriority: Priority[] = [
  { to: '/plants', label: 'Plants', icon: Building2 },
  {
    to: '/operations?tab=wells',
    label: 'Wells & Locators',
    icon: Droplet,
    match: ['/operations'],
    // Accept both plural deep-link values and the singular values that
    // Operations writes back when the user manually clicks a tab.
    matchTabValues: ['well', 'wells', 'locator', 'locators'],
  },
];
const rightPriority: Priority[] = [
  { to: '/ro-trains', label: 'RO Trains', icon: Cog },
];

// Items hidden behind the side sheet
const sideSheetGroups = [
  {
    title: 'Overview',
    items: [
      { to: '/ai', label: 'AI Assistant', icon: Sparkles },
      { to: '/compliance', label: 'Compliance', icon: ShieldCheck },
    ],
  },
  {
    title: 'Maintenance',
    items: [
      { to: '/maintenance', label: 'PM Schedule', icon: Wrench },
      { to: '/incidents', label: 'Incidents', icon: AlertTriangle },
    ],
  },
  {
    title: 'Finance',
    items: [
      { to: '/costs', label: 'Costs & Tariffs', icon: DollarSign },
    ],
  },
];

const adminGroup = {
  title: 'Admin',
  items: [
    { to: '/admin', label: 'Admin Console', icon: ShieldAlert },
    { to: '/exports', label: 'Data Exports', icon: Download },
    { to: '/import', label: 'Smart Import', icon: Upload },
  ],
};

// Always visible (all roles)
const teamGroup = {
  title: 'Team',
  items: [
    { to: '/employees', label: 'Employees', icon: Users },
  ],
};

export function BottomNav() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const fullPath = pathname + search;
  const visibleGroups = isAdmin
    ? [...sideSheetGroups, teamGroup, adminGroup]
    : [...sideSheetGroups, teamGroup];

  const isPriorityActive = (item: Priority) => {
    const target = item.to.split('?')[0];
    if (item.match) {
      const pathMatch = item.match.some((p) => pathname.startsWith(p));
      if (!pathMatch) return false;
      // Prefer exact `?tab=` value matching when configured; this is robust
      // against unrelated query params that could otherwise contain the same
      // substring.
      const currentTab = (new URLSearchParams(search).get('tab') || '').toLowerCase();
      if (item.matchTabValues) return item.matchTabValues.includes(currentTab);
      // Fallback: match the literal query string from the item's `to`.
      const ownQuery = item.to.split('?')[1] ?? '';
      return ownQuery ? fullPath.includes(ownQuery) : true;
    }
    return pathname === target || pathname.startsWith(target + '/');
  };

  const renderPriority = (item: Priority) => {
    const active = isPriorityActive(item);
    return (
      <button
        key={item.to}
        onClick={() => navigate(item.to)}
        className={cn(
          'flex flex-col items-center justify-center gap-0.5 py-2 px-1 transition-all',
          active
            ? 'text-primary text-[11px] font-semibold'
            : 'text-muted-foreground text-[10px] font-medium hover:text-foreground',
        )}
      >
        <item.icon
          className={cn(
            'transition-all',
            active ? 'h-[22px] w-[22px] drop-shadow-sm' : 'h-[18px] w-[18px]',
          )}
        />
        <span className="leading-none">{item.label}</span>
      </button>
    );
  };

  return (
    <nav className="md:hidden sticky bottom-0 z-40 bg-card border-t shadow-[0_-2px_8px_-2px_hsl(210_30%_12%/0.06)]">
      <div className="grid grid-cols-5 max-w-3xl mx-auto items-end">
        {leftPriority.map(renderPriority)}

        {/* Centered, prominent Dashboard button */}
        <NavLink
          to="/"
          end
          className={({ isActive }) => cn(
            'flex flex-col items-center justify-center gap-0.5 py-1 px-1 text-[10px] font-semibold transition-colors -mt-3',
            isActive ? 'text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {({ isActive }) => (
            <>
              <span className={cn(
                'flex items-center justify-center h-12 w-12 rounded-full shadow-elev border-2 border-card',
                isActive ? 'bg-primary text-primary-foreground' : 'bg-accent text-accent-foreground',
              )}>
                <LayoutDashboard className="h-5 w-5" />
              </span>
              <span className="leading-none mt-0.5 text-foreground">Dashboard</span>
            </>
          )}
        </NavLink>

        {rightPriority.map(renderPriority)}

        {/* Side sheet: employees, data exports, and other less-frequent items */}
        <Sheet>
          <SheetTrigger asChild>
            <button className="flex flex-col items-center justify-center gap-0.5 py-2 px-1 text-[10px] font-medium text-muted-foreground hover:text-foreground">
              <Menu className="h-[18px] w-[18px]" />
              <span className="leading-none">More</span>
            </button>
          </SheetTrigger>
          <SheetContent side="right" className="w-72">
            <SheetHeader><SheetTitle>More</SheetTitle></SheetHeader>
            <div className="mt-4 space-y-4 overflow-y-auto">
              {visibleGroups.map((group) => (
                <div key={group.title}>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground px-2 mb-1">{group.title}</div>
                  <div className="flex flex-col gap-1">
                    {group.items.map((r) => (
                      <NavLink
                        key={r.to}
                        to={r.to}
                        className={({ isActive }) => cn(
                          'flex items-center gap-3 px-3 py-2.5 rounded-md text-sm transition-colors',
                          isActive ? 'bg-accent-soft text-accent font-medium' : 'hover:bg-muted',
                        )}
                      >
                        <r.icon className="h-4 w-4" />
                        {r.label}
                      </NavLink>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </nav>
  );
}
