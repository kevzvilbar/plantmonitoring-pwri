import { createContext, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAppStore } from '@/store/appStore';

type Role = 'Operator' | 'Technician' | 'Manager' | 'Admin';

export interface AuthUser    { id: string; email?: string; }
export interface AuthSession { access_token: string; refresh_token?: string; user: AuthUser; }

export interface Profile {
  id: string; username: string | null; first_name: string | null;
  middle_name: string | null; last_name: string | null; suffix: string | null;
  designation: string | null; immediate_head_id: string | null;
  plant_assignments: string[]; status: 'Pending' | 'Active' | 'Suspended';
  profile_complete: boolean; confirmed?: boolean;
}

interface AuthContextValue {
  session: AuthSession | null; user: AuthUser | null; profile: Profile | null;
  activeOperator: Profile | null; roles: Role[]; isAdmin: boolean;
  isManager: boolean; loading: boolean;
  refreshProfile: () => Promise<void>; signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession]             = useState<AuthSession | null>(null);
  const [user, setUser]                   = useState<AuthUser | null>(null);
  const [profile, setProfile]             = useState<Profile | null>(null);
  const [operatorProfile, setOperatorProfile] = useState<Profile | null>(null);
  const [roles, setRoles]                 = useState<Role[]>([]);
  const [loading, setLoading]             = useState(true);

  const activeOperatorId       = useAppStore((s) => s.activeOperatorId);
  const setActiveOperatorIdRef = useRef(useAppStore.getState().setActiveOperatorId);

  const loadProfileAndRoles = async (uid: string) => {
    const [{ data: prof }, { data: roleRows }] = await Promise.all([
      supabase.from('user_profiles').select('*').eq('id', uid).maybeSingle(),
      supabase.from('user_roles').select('role').eq('user_id', uid),
    ]);
    setProfile((prof as Profile) ?? null);
    setRoles(((roleRows ?? []) as { role: Role }[]).map((r) => r.role));
  };

  useEffect(() => {
    if (!activeOperatorId) { setOperatorProfile(null); return; }
    supabase.from('user_profiles').select('*').eq('id', activeOperatorId).maybeSingle().then(({ data }) => {
      if (!data) { setActiveOperatorIdRef.current(null); setOperatorProfile(null); return; }
      setOperatorProfile(data as Profile);
    });
  }, [activeOperatorId]);

  useEffect(() => {
    const { data: subscription } = supabase.auth.onAuthStateChange((_event: any, sess: AuthSession | null) => {
      setSession(sess); setUser(sess?.user ?? null);
      if (sess?.user) {
        setLoading(true);
        setTimeout(() => loadProfileAndRoles(sess.user.id).finally(() => setLoading(false)), 0);
      } else {
        setProfile(null); setOperatorProfile(null);
        setActiveOperatorIdRef.current(null); setRoles([]); setLoading(false);
      }
    });

    supabase.auth.getSession().then(({ data: { session: sess } }: any) => {
      setSession(sess); setUser(sess?.user ?? null);
      if (sess?.user) loadProfileAndRoles(sess.user.id).finally(() => setLoading(false));
      else setLoading(false);
    });

    return () => subscription.subscription.unsubscribe();
  }, []);

  const refreshProfile = async () => { if (user) await loadProfileAndRoles(user.id); };
  const signOut = async () => { setActiveOperatorIdRef.current(null); await supabase.auth.signOut(); };
  const isAdmin   = roles.includes('Admin');
  const isManager = isAdmin || roles.includes('Manager');
  const activeOperator = operatorProfile ?? profile;

  return (
    <AuthContext.Provider value={{ session, user, profile, activeOperator, roles, isAdmin, isManager, loading, refreshProfile, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
