import { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading, profile } = useAuth();
  const loc = useLocation();

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Loading…</div>;
  }
  if (!user) return <Navigate to="/auth" state={{ from: loc }} replace />;
  if (!profile?.profile_complete && loc.pathname !== '/onboarding') {
    return <Navigate to="/onboarding" replace />;
  }
  // Iteration 9: gate every protected route on Admin approval.
  // `confirmed` is undefined for projects that haven't run the
  // 20260428_admin_approval_flow.sql migration yet — treat as approved
  // in that case so the UI stays usable until the flag rolls out.
  if (
    profile?.profile_complete &&
    profile.confirmed === false &&
    loc.pathname !== '/pending-approval'
  ) {
    return <Navigate to="/pending-approval" replace />;
  }
  return <>{children}</>;
}
