import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Hourglass, LogOut, RefreshCw } from 'lucide-react';

export default function PendingApproval() {
  const { profile, signOut, refreshProfile } = useAuth();
  const navigate = useNavigate();

  // Auto-redirect when confirmed flips to true
  useEffect(() => {
    if (profile?.confirmed === true) {
      navigate('/', { replace: true });
    }
  }, [profile?.confirmed, navigate]);

  const handleRefresh = async () => {
    await refreshProfile();
    // Navigation handled by useEffect above
  };

  const handleSignOut = async () => {
    await signOut();
    navigate('/auth', { replace: true });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-stat p-4">
      <Card
        className="max-w-md w-full p-6 text-center space-y-4"
        data-testid="pending-approval-card"
      >
        <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-950/40 mx-auto">
          <Hourglass className="h-6 w-6 text-amber-600" />
        </div>
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">Account awaiting Admin approval</h1>
          <p className="text-sm text-muted-foreground">
            Hi {profile?.first_name ?? 'there'} — your account has been
            created. An Administrator must approve it before you can access
            the PWRI Monitoring console.
          </p>
        </div>
        <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-left space-y-1">
          <div>
            Status: <strong>{profile?.status ?? 'Pending'}</strong>
          </div>
          <div>
            Designation:{' '}
            <strong>{profile?.designation ?? '—'}</strong>
          </div>
          <div className="text-muted-foreground">
            You'll be redirected to the dashboard automatically once approved.
            Try the refresh button below after the Admin has confirmed your
            account.
          </div>
        </div>
        <div className="flex gap-2 justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            data-testid="pending-refresh-btn"
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1" />
            Refresh status
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSignOut}
            data-testid="pending-signout-btn"
          >
            <LogOut className="h-3.5 w-3.5 mr-1" />
            Sign out
          </Button>
        </div>
      </Card>
    </div>
  );
}
