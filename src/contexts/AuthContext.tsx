import { createContext, useContext, useEffect, useRef, useState, ReactNode } from "react";
import { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { AppRole, resolveRole, hasSuperadmin } from "@/lib/roles";
import { isGenuineSignIn, stableUser } from "@/lib/authEvents";
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

  // Monotonic token so a slower role fetch can't overwrite a newer one
  // (both onAuthStateChange and getSession call loadRole — latest wins).
  const roleReqRef = useRef(0);
  // Last user id we've seen, to tell a genuine interactive sign-in apart from
  // a session restore / token refresh / tab-focus re-emit of SIGNED_IN.
  const prevUserIdRef = useRef<string | null>(null);

  const loadRole = async (uid: string) => {
    const reqId = ++roleReqRef.current;
    const { data } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", uid);
    // A newer load (or a sign-out) superseded this one — drop the stale result.
    if (reqId !== roleReqRef.current) return;
    const roles = (data ?? []).map((r: any) => r.role as string);
    // Centralized precedence (handles superadmin >= admin) — see src/lib/roles.ts.
    setRole(resolveRole(roles));
    setIsSuperadmin(hasSuperadmin(roles));
  };

  useEffect(() => {
    // Set up listener FIRST
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      // Keep the `user` object REFERENTIALLY STABLE when the identity is unchanged.
      // Supabase hands us a brand-new user object on EVERY event — including the
      // hourly TOKEN_REFRESHED and the SIGNED_IN re-emit that fires on tab-focus /
      // Mini-App re-open. Blindly calling setUser() with that new object churns
      // every consumer that depends on `user` (e.g. LessonPage's data-load effect),
      // which was refetching progress and reloading the Bunny <iframe> mid-video.
      // Swap the reference only on a genuine identity change (login / logout /
      // different user) or an explicit USER_UPDATED. `session` still updates every
      // time, so anything that needs the fresh access token is unaffected.
      setUser((prev) => stableUser(event, prev, s?.user ?? null));
      if (s?.user) {
        // Capture the id once so async closures below can't read a stale user.
        const uid = s.user.id;
        // defer DB call
        setTimeout(() => loadRole(uid), 0);
        // Sync preferred language from profile
        setTimeout(() => {
          supabase
            .from("profiles")
            .select("preferred_language")
            .eq("id", uid)
            .maybeSingle()
            .then(({ data }) => {
              const lng = (data as any)?.preferred_language;
              if (lng && ["uz", "ru", "en"].includes(lng) && i18n.language !== lng) {
                i18n.changeLanguage(lng);
              }
            });
        }, 0);
        // Only fire login side effects on a GENUINE sign-in — not on a token
        // refresh, tab-focus re-emit, or a page-reload session restore (those
        // keep the same uid or arrive as INITIAL_SESSION), which would spam
        // admin notifications and inflate the auth_events login count.
        if (isGenuineSignIn(event, prevUserIdRef.current, uid)) {
          // Notify admins on first sign-in (new student) — fire-and-forget.
          setTimeout(() => {
            supabase
              .from("profiles")
              .select("created_at")
              .eq("id", uid)
              .maybeSingle()
              .then(({ data }) => {
                const created = (data as any)?.created_at;
                if (!created) return;
                if (Date.now() - new Date(created).getTime() < 5 * 60 * 1000) {
                  supabase.functions.invoke("notify-admin-new-student", {
                    body: { user_id: uid },
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
                user_id: uid,
                event: "sign_in",
                user_agent: navigator.userAgent.slice(0, 200),
              } as any).then(() => {});
            });
          }, 0);
        }
        prevUserIdRef.current = uid;
      } else {
        // Sign-out: invalidate any in-flight role load and reset.
        roleReqRef.current++;
        prevUserIdRef.current = null;
        setRole(null);
        setIsSuperadmin(false);
      }
    });

    // Then read existing session
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      setUser(s?.user ?? null);
      if (s?.user) {
        // Mark this session as already-known so the listener's INITIAL_SESSION/
        // SIGNED_IN re-emit for the same user isn't treated as a new login.
        prevUserIdRef.current = s.user.id;
        loadRole(s.user.id).finally(() => setLoading(false));
      } else setLoading(false);
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
