import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Building2, Activity, Cog, Wrench, AlertTriangle,
  Users, DollarSign, Receipt, Download, Upload, Sparkles, ShieldCheck, ShieldAlert,
} from 'lucide-react';
import {
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar,
} from '@/components/ui/sidebar';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';

type SidebarItem = {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  end?: boolean;
};
type SidebarGroup = { label: string; items: SidebarItem[] };

const groups: SidebarGroup[] = [
  {
    label: 'Overview',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
      { to: '/ai', label: 'AI Assistant', icon: Sparkles },
      { to: '/compliance', label: 'Compliance', icon: ShieldCheck },
    ],
  },
  {
    label: 'Operations',
    items: [
      { to: '/plants', label: 'Plants', icon: Building2 },
      { to: '/operations', label: 'Wells & Locators', icon: Activity },
      { to: '/ro-trains', label: 'RO Trains', icon: Cog },
    ],
  },
  {
    label: 'Maintenance',
    items: [
      { to: '/maintenance', label: 'PM Schedule', icon: Wrench },
      { to: '/incidents', label: 'Incidents', icon: AlertTriangle },
    ],
  },
  {
    label: 'Finance',
    items: [
      { to: '/costs', label: 'Costs & Tariffs', icon: DollarSign },
      { to: '/costs?tab=prices', label: 'Chemical Prices', icon: Receipt },
    ],
  },
];

const adminGroup: SidebarGroup = {
  label: 'Admin',
  items: [
    { to: '/admin', label: 'Admin Console', icon: ShieldAlert },
    { to: '/exports', label: 'Data Exports', icon: Download },
    { to: '/import', label: 'Smart Import', icon: Upload },
  ],
};

// Visible to every authenticated user (not just admins)
const sharedGroup: SidebarGroup = {
  label: 'Team',
  items: [
    { to: '/employees', label: 'Employees', icon: Users },
  ],
};

export function AppSidebar() {
  const { state } = useSidebar();
  const collapsed = state === 'collapsed';
  const { pathname } = useLocation();
  const { isAdmin } = useAuth();

  const visibleGroups = isAdmin
    ? [...groups, sharedGroup, adminGroup]
    : [...groups, sharedGroup];

  return (
    <Sidebar collapsible="icon">
      <SidebarContent>
        {visibleGroups.map((g) => (
          <SidebarGroup key={g.label}>
            {!collapsed && <SidebarGroupLabel>{g.label}</SidebarGroupLabel>}
            <SidebarGroupContent>
              <SidebarMenu>
                {g.items.map((item) => {
                  const isActive = item.end ? pathname === item.to : pathname.startsWith(item.to.split('?')[0]);
                  return (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton asChild>
                        <NavLink
                          to={item.to}
                          end={item.end}
                          className={cn(
                            'flex items-center gap-2',
                            isActive && 'bg-accent-soft text-accent font-medium',
                          )}
                        >
                          <item.icon className="h-4 w-4 shrink-0" />
                          {!collapsed && <span>{item.label}</span>}
                        </NavLink>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
    </Sidebar>
  );
}
