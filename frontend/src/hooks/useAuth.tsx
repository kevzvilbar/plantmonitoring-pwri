import { createContext, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { useAppStore } from '@/store/appStore';

type Role = 'Operator' | 'Technician' | 'Manager' | 'Admin';

export interface Profile {
  id: string;
  username: string | null;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  suffix: string | null;
  designation: string | null;
  immediate_head_id: string | null;
  plant_assignments: string[];
  status: 'Pending' | 'Active' | 'Suspended';
  profile_complete: boolean;
  /** Admin-approval flag (replaces Supabase email confirmation, iter 9) */
  confirmed?: boolean;
}

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  /** The currently selected shift operator profile.
   *  Falls back to own profile when no override is set. */
  activeOperator: Profile | null;
  roles: Role[];
  isAdmin: boolean;
  isManager: boolean;
  loading: boolean;
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [operatorProfile, setOperatorProfile] = useState<Profile | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);

  const activeOperatorId = useAppStore((s) => s.activeOperatorId);

  // Stable ref so effects never re-run just because Zustand recreated the setter
  const setActiveOperatorIdRef = useRef(useAppStore.getState().setActiveOperatorId);

  const loadProfileAndRoles = async (uid: string) => {
    const [{ data: prof }, { data: roleRows }] = await Promise.all([
      supabase.from('user_profiles').select('*').eq('id', uid).maybeSingle(),
      supabase.from('user_roles').select('role').eq('user_id', uid),
    ]);
    setProfile((prof as Profile) ?? null);
    setRoles(((roleRows ?? []) as { role: Role }[]).map((r) => r.role));
  };

  // Load the selected operator's profile whenever activeOperatorId changes
  useEffect(() => {
    if (!activeOperatorId) { setOperatorProfile(null); return; }
    supabase.from('user_profiles').select('*').eq('id', activeOperatorId).maybeSingle().then(({ data }) => {
      if (!data) { setActiveOperatorIdRef.current(null); setOperatorProfile(null); return; }
      setOperatorProfile(data as Profile);
    });
  }, [activeOperatorId]); // stable: no setter in deps

  useEffect(() => {
    // Set up listener FIRST (per Lovable Cloud auth knowledge)
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess);
      setUser(sess?.user ?? null);
      if (sess?.user) {
        setLoading(true);
        setTimeout(() => {
          loadProfileAndRoles(sess.user.id).finally(() => setLoading(false));
        }, 0);
      } else {
        setProfile(null);
        setOperatorProfile(null);
        setActiveOperatorIdRef.current(null); // use ref, not reactive setter
        setRoles([]);
        setLoading(false);
      }
    });

    supabase.auth.getSession().then(({ data: { session: sess } }) => {
      setSession(sess);
      setUser(sess?.user ?? null);
      if (sess?.user) loadProfileAndRoles(sess.user.id).finally(() => setLoading(false));
      else setLoading(false);
    });

    return () => subscription.subscription.unsubscribe();
  }, []); // intentionally empty — must only run once

  const refreshProfile = async () => {
    if (user) await loadProfileAndRoles(user.id);
  };

  const signOut = async () => {
    setActiveOperatorIdRef.current(null);
    await supabase.auth.signOut();
  };

  const isAdmin = roles.includes('Admin');
  const isManager = isAdmin || roles.includes('Manager');

  // activeOperator: prefer the explicitly selected operator, fallback to own profile
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