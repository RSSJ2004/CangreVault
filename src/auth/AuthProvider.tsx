import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';

interface AuthState {
  session: Session | null;
  user: User | null;
  loading: boolean;
  signInWithPassword: (email: string, password: string) => Promise<string | null>;
  signUp: (email: string, password: string, displayName: string) => Promise<string | null>;
  sendMagicLink: (email: string) => Promise<string | null>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

function translate(msg: string): string {
  if (/invalid login credentials/i.test(msg)) return 'Correo o contraseña incorrectos.';
  if (/email not confirmed/i.test(msg)) return 'Confirma tu correo antes de iniciar sesión.';
  if (/already registered/i.test(msg)) return 'Ese correo ya está registrado.';
  if (/password should be at least/i.test(msg)) return 'La contraseña es demasiado corta.';
  if (/rate limit/i.test(msg)) return 'Demasiados intentos. Espera unos minutos.';
  return msg;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(Boolean(supabase));

  useEffect(() => {
    if (!supabase) return;
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  const value: AuthState = {
    session,
    user: session?.user ?? null,
    loading,
    async signInWithPassword(email, password) {
      const { error } = await supabase!.auth.signInWithPassword({ email, password });
      return error ? translate(error.message) : null;
    },
    async signUp(email, password, displayName) {
      const { error } = await supabase!.auth.signUp({
        email, password, options: { data: { display_name: displayName }, emailRedirectTo: window.location.origin },
      });
      return error ? translate(error.message) : null;
    },
    async sendMagicLink(email) {
      const { error } = await supabase!.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
      return error ? translate(error.message) : null;
    },
    async signOut() {
      await supabase?.auth.signOut();
    },
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth fuera de AuthProvider');
  return ctx;
}
