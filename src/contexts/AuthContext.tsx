import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { AppRole, resolveRole, hasSuperadmin } from "@/lib/roles";
import i18n from "@/i18n";

interface AuthCtx {
  session: Session | null;
  user: User | null;
  role: AppRole | null;
  /** True if the user holds the superadmin role. `role` is "admin" for them. */
  isSuperadmin: boolean;
  loading: boolean;
  signOut: () => Promise<void>;
  refreshRole: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>({
  session: null,
  user: null,
  role: null,
  isSuperadmin: false,
  loading: true,
  signOut: async () => {},
  refreshRole: async () => {},
});

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<AppRole | null>(null);
  const [isSuperadmin, setIsSuperadmin] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadRole = async (uid: string) => {
    const { data } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", uid);
    const roles = (data ?? []).map((r: any) => r.role as string);
    // Centralized precedence (handles superadmin >= admin) — see src/lib/roles.ts.
    setRole(resolveRole(roles));
    setIsSuperadmin(hasSuperadmin(roles));
  };

  useEffect(() => {
    // Set up listener FIRST
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      setUser(s?.user ?? null);
      if (s?.user) {
        // defer DB call
        setTimeout(() => loadRole(s.user.id), 0);
        // Sync preferred language from profile
        setTimeout(() => {
          supabase
            .from("profiles")
            .select("preferred_language")
            .eq("id", s.user.id)
            .maybeSingle()
            .then(({ data }) => {
              const lng = (data as any)?.preferred_language;
              if (lng && ["uz", "ru", "en"].includes(lng) && i18n.language !== lng) {
                i18n.changeLanguage(lng);
              }
            });
        }, 0);
        if (event === "SIGNED_IN") {
          // Notify admins on first sign-in (new student) — fire-and-forget.
          setTimeout(() => {
            supabase
              .from("profiles")
              .select("created_at")
              .eq("id", s.user.id)
              .maybeSingle()
              .then(({ data }) => {
                const created = (data as any)?.created_at;
                if (!created) return;
                if (Date.now() - new Date(created).getTime() < 5 * 60 * 1000) {
                  supabase.functions.invoke("notify-admin-new-student", {
                    body: { user_id: s.user.id },
                  }).catch(() => {});
                }
              });
          }, 0);
          setTimeout(() => {
            // Server-side capture (gets real IP from request headers)
            supabase.functions.invoke("log-auth-event", {
              body: { event: "sign_in" },
            }).catch(() => {
              // Fallback: client-side insert (no IP)
              supabase.from("auth_events").insert({
                user_id: s.user.id,
                event: "sign_in",
                user_agent: navigator.userAgent.slice(0, 200),
              } as any).then(() => {});
            });
          }, 0);
        }
      } else {
        setRole(null);
        setIsSuperadmin(false);
      }
    });

    // Then read existing session
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      setUser(s?.user ?? null);
      if (s?.user) loadRole(s.user.id).finally(() => setLoading(false));
      else setLoading(false);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  const refreshRole = async () => {
    if (user) await loadRole(user.id);
  };

  return (
    <Ctx.Provider value={{ session, user, role, isSuperadmin, loading, signOut, refreshRole }}>
      {children}
    </Ctx.Provider>
  );
};

export const useAuth = () => useContext(Ctx);
