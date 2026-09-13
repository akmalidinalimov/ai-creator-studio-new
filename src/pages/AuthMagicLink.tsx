import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { SB_BASE } from "@/lib/supabaseBase";
import { reportClientError } from "@/lib/beacon";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

// A magic-link token is SINGLE USE, so this page must POST it exactly once per open — which the
// previous implementation could not guarantee. Its effect listed `t` (from useTranslation) in the dep
// array, and AuthContext calls i18n.changeLanguage(profile.preferred_language) the instant a session
// is set (AuthContext.tsx:77-89). So a SUCCESSFUL redeem changed the language, `t` took a new
// identity, the effect re-ran, and the second POST of the same token came back 410 "already used" —
// painting "Couldn't sign in" over a sign-in that had just worked.
//
// Prod logs showed the signature plainly on 2026-09-13: a 200 followed by a 410 on the same token
// ~3 seconds later, and 48 of 98 redeem calls in 24h were 410s — about half of every student who
// opened a bot link.
//
// The redeem is therefore keyed by token in a module-level map: every mount (re-render, remount,
// StrictMode double-invoke, a second tab) awaits the SAME promise, so the token is spent once and
// every waiter gets the same outcome.
type RedeemResult =
  | { ok: true; target: string; hardNav: boolean }
  | { ok: false; code: string; message: string };

const INFLIGHT = new Map<string, Promise<RedeemResult>>();

async function redeemAndSignIn(token: string, imp: boolean, impAs: string): Promise<RedeemResult> {
  const r = await fetch(`${SB_BASE}/functions/v1/magic-link-redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const data = await r.json().catch(() => null as unknown as Record<string, unknown> | null);
  const d = (data || {}) as Record<string, any>;
  if (!r.ok || !d?.session) {
    return { ok: false, code: String(d?.error || r.status), message: String(d?.message || "") };
  }
  const { error: setErr } = await supabase.auth.setSession({
    access_token: d.session.access_token,
    refresh_token: d.session.refresh_token,
  });
  if (setErr) return { ok: false, code: "set_session", message: setErr.message };
  if (imp) {
    // Flag lives in localStorage (shared across tabs) so it agrees with the shared Supabase auth
    // token — every tab shows the banner + read-only guard.
    try { localStorage.setItem("impersonating", impAs); } catch { /* ignore */ }
  }
  return { ok: true, target: String(d.target_path || "/dashboard"), hardNav: imp };
}

function redeemOnce(token: string, imp: boolean, impAs: string): Promise<RedeemResult> {
  let p = INFLIGHT.get(token);
  if (!p) {
    p = redeemAndSignIn(token, imp, impAs);
    INFLIGHT.set(token, p);
  }
  return p;
}

export default function AuthMagicLink() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  // navigate/t are read through refs so they can stay OUT of the dep array: both take a new identity
  // on a language change, which is precisely what used to re-fire the redeem.
  const navRef = useRef(navigate);
  navRef.current = navigate;
  const tRef = useRef(t);
  tRef.current = t;

  const token = params.get("t") || "";
  const imp = params.get("imp") === "1";
  const impAs = params.get("as") || "user";

  useEffect(() => {
    if (!token) {
      setError(tRef.current("authMagic.invalid"));
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await redeemOnce(token, imp, impAs);
        if (cancelled) return;
        if (res.ok) {
          if (res.hardNav) window.location.assign(res.target);
          else navRef.current(res.target, { replace: true });
          return;
        }
        // The link is spent or expired. Before showing a dead end, check whether this browser is
        // ALREADY signed in — the everyday case is a second open of a link whose first open worked
        // (Telegram's in-app browser, then the real one; or a re-tap), where the right answer is
        // "come in", not "couldn't sign in".
        const { data } = await supabase.auth.getSession();
        if (cancelled) return;
        if (data?.session) {
          navRef.current("/dashboard", { replace: true });
          return;
        }
        // Genuinely dead AND not signed in: this student is stuck, so make it DB-visible (the server
        // records its own row; this one proves what the student actually saw).
        try {
          reportClientError({ type: "other", message: "magic_link_dead", extra: { code: res.code } });
        } catch { /* ignore */ }
        setError(res.message || tRef.current("authMagic.invalid"));
      } catch (e) {
        // Network-layer failure on the magic-link redeem = backend unreachable (the "Load failed"
        // login class). Beacon it so it's DB-visible even though this is a raw fetch (not the client).
        // A transport failure spent nothing, so drop the memo and let a reload genuinely retry.
        INFLIGHT.delete(token);
        try { reportClientError({ type: "backend_unreachable", message: `magic-link-redeem: ${e instanceof Error ? e.message : String(e)}` }); } catch { /* ignore */ }
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, imp, impAs]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-sm w-full text-center space-y-4">
          <h1 className="text-2xl font-semibold">{t("authMagic.invalidTitle")}</h1>
          <p className="text-muted-foreground text-sm">{error}</p>
          <Button asChild className="w-full"><Link to="/login">{t("authMagic.backToLogin")}</Link></Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="text-center space-y-3">
        <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t("authMagic.signingIn")}</p>
      </div>
    </div>
  );
}
