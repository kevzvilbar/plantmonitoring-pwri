import { Outlet } from 'react-router-dom';
import { TopBar } from './TopBar';
import { BottomNav } from './BottomNav';
import { AppSidebar } from './AppSidebar';
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';

export function AppShell() {
  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full bg-background">
        <div className="hidden md:block">
          <AppSidebar />
        </div>
        <div className="flex-1 flex flex-col min-w-0">
          <TopBar />
          <div className="hidden md:flex h-9 items-center border-b px-2">
            <SidebarTrigger />
          </div>
          <main className="flex-1 max-w-5xl w-full mx-auto px-3 sm:px-4 py-4 pb-6">
            <Outlet />
          </main>
          <BottomNav />
        </div>
      </div>
    </SidebarProvider>
  );
}
