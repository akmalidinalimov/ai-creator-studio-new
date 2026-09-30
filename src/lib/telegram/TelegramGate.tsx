import { useEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useMiniApp } from "./MiniAppContext";
import { applyTelegramChrome } from "./appShell";
import { useTelegramViewport } from "./useTelegramViewport";
import { useTelegramBackButton } from "./useTelegramBackButton";
import TgNotLinked from "@/pages/TgNotLinked";
import { readTrack, startParamFromInitData, startParamToPath, stripTrack, type MiniAppSrc } from "@/lib/miniappLinks";
import { fastPathRedirect, resolveLanding } from "./landing";

/**
 * TelegramGate — the "two doors" boot layer.
 *
 *   initData === undefined → still detecting the SDK        → spinner
 *   initData === null      → NOT in Telegram (WEB MODE)     → render children unchanged (strict no-op)
 *   initData is a string   → in a Telegram Mini App         → auth bridge, then render children
 *
 * In Mini App mode it (1) reuses a live Supabase session if it belongs to THIS Telegram
 * user (fast re-open), else (2) calls the `tg-miniapp-auth` edge fn to mint one, then
 * `setSession` and lets the existing app (AuthProvider/RLS/routes) take over.
 *
 * The web path must stay behaviourally identical to before the Mini App existed.
 */
type Phase = "loading" | "web" | "authing" | "ready" | "notlinked" | "error";

/** Read the `{ error }` code from a supabase-js function response (2xx body or non-2xx context). */
async function functionErrorCode(error: unknown, data: unknown): Promise<string | null> {
  const inBody = (data as { error?: string } | null)?.error;
  if (inBody) return inBody;
  const ctx = (error as { context?: unknown } | null)?.context;
  if (ctx && typeof (ctx as Response).json === "function") {
    try {
      const body = (await (ctx as Response).json()) as { error?: string };
      return body?.error ?? "error";
    } catch {
      return "error";
    }
  }
  return error ? "error" : null;
}

/** The open signal a watch button carries: ?src=&ref= on a web_app URL, or the "__<src>" start_param suffix. */
type OpenSignal = { src: MiniAppSrc; ref: string | null; path: string };

function openSignal(pathname: string, search: string, startParam: string | null): OpenSignal | null {
  const q = readTrack(search);
  if (q) return { src: q.src, ref: q.ref, path: pathname };
  const sp = startParamToPath(startParam);
  if (sp?.src && (pathname === "/" || pathname === "")) return { src: sp.src, ref: null, path: sp.path.split("?")[0] };
  return null;
}

/**
 * Report each open ONCE per Mini App session: a reload (stale-build watcher, pull-to-refresh) re-runs the gate
 * with the same URL and must not count the same tap twice. Storage can be unavailable (private mode, blocked
 * site data) — then it simply reports; the page never depends on it.
 */
const openKey = (sig: OpenSignal) => `mo:${sig.src}:${sig.ref ?? "-"}`;

function openReported(sig: OpenSignal): boolean {
  try {
    return !!window.sessionStorage.getItem(openKey(sig));
  } catch {
    return false; // no storage → report anyway
  }
}

function markOpenReported(sig: OpenSignal): void {
  try {
    window.sessionStorage.setItem(openKey(sig), "1");
  } catch { /* no storage: nothing to remember */ }
}

export function TelegramGate({ children }: { children: ReactNode }) {
  const { webApp, initData } = useMiniApp();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>("loading");
  const [retryTick, setRetryTick] = useState(0);

  // Native feel: full-height viewport + safe areas + swipe guard, and the header BackButton
  // drives the router. Both no-op in web mode (webApp === null).
  useTelegramViewport(webApp);
  useTelegramBackButton(webApp);

  // Match Telegram's native chrome (header/background) to the app's own dark ground. The app
  // NEVER wears Telegram's theme colors anymore (owner decision — dark-only palette; see
  // index.html's pre-paint script), so there's no themeChanged re-application here, just the
  // one-time chrome match as soon as the SDK is present.
  useEffect(() => {
    if (!webApp) return;
    applyTelegramChrome(webApp);
  }, [webApp]);

  useEffect(() => {
    if (initData === undefined) { setPhase("loading"); return; }
    if (initData === null) { setPhase("web"); return; }

    let cancelled = false;
    (async () => {
      setPhase("authing");
      try {
        const parsed = JSON.parse(new URLSearchParams(initData).get("user") || "{}") as { id?: number };
        const tgId = Number(parsed?.id) || 0;
        const startParam = startParamFromInitData(initData);

        // Fast re-open: is there already a session, and does it belong to THIS Telegram user?
        const { data: sess } = await supabase.auth.getSession();
        if (sess?.session) {
          const { data: prof } = await supabase
            .from("profiles")
            .select("telegram_id")
            .eq("id", sess.session.user.id)
            .maybeSingle();
          const owns = prof && Number((prof as { telegram_id: number | null }).telegram_id) === tgId && tgId > 0;
          if (owns) {
            if (cancelled) return;
            // Fast re-open keeps the requested path (a web_app deep link already points at it). Two extras:
            //  - a named-app direct link (t.me/<bot>/app?startapp=…) always opens at the root, so honour its
            //    start_param here — otherwise Landing's own "/" → "/dashboard" redirect swallows it;
            //  - a watch button's open signal is reported (fire-and-forget) and its src/ref stripped.
            const sig = openSignal(location.pathname, location.search, startParam);
            if (sig && !openReported(sig)) {
              markOpenReported(sig);
              void supabase.functions
                .invoke("tg-miniapp-auth", { body: { initData, mode: "open", src: sig.src, ref: sig.ref, path: sig.path } })
                .catch(() => { /* best-effort signal */ });
            }
            const jump = fastPathRedirect(location.pathname, startParam);
            if (jump) navigate(jump, { replace: true });
            else if (readTrack(location.search)) navigate(location.pathname + stripTrack(location.search), { replace: true });
            setPhase("ready");
            return;
          }
          await supabase.auth.signOut(); // cross-account mismatch → drop it and re-auth as the Telegram user
        }

        // A watch button's open signal rides along with the sign-in (recorded server-side as cold:true).
        const sig = openSignal(location.pathname, location.search, startParam);
        const open = sig && !openReported(sig) ? sig : undefined;
        const { data, error } = await supabase.functions.invoke("tg-miniapp-auth", { body: open ? { initData, open } : { initData } });
        if (cancelled) return;

        const session = (data as { session?: { access_token: string; refresh_token: string } } | null)?.session;
        if (error || !session) {
          const code = await functionErrorCode(error, data);
          if (cancelled) return;
          setPhase(code === "not_linked" ? "notlinked" : "error");
          return;
        }

        await supabase.auth.setSession({
          access_token: session.access_token,
          refresh_token: session.refresh_token,
        });
        if (cancelled) return;
        if (open) markOpenReported(open); // only once the sign-in (which carried it) succeeded

        // Deep links survive the gate (a watch button to /lesson/…, /continue/…, /tg/teacher/grade); the root and
        // /dashboard (🚀 Ilovani ochish, ☰ menu) take the server's role-aware target_path; a direct-link
        // start_param at the root maps through the shared grammar. See landing.ts (pinned by landing.test.ts).
        const serverTarget = (data as { target_path?: string }).target_path || "/dashboard";
        const dest = resolveLanding({ pathname: location.pathname, search: location.search, startParam, serverTarget });
        if (dest !== location.pathname + location.search) navigate(dest, { replace: true });
        setPhase("ready");
      } catch {
        if (!cancelled) setPhase("error");
      }
    })();

    return () => { cancelled = true; };
    // retryTick lets the error screen re-run the flow; initData is the real trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initData, retryTick]);

  if (phase === "web" || phase === "ready") return <>{children}</>;
  if (phase === "notlinked") return <TgNotLinked />;

  if (phase === "error") {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-background text-foreground">
        <div className="w-full max-w-sm space-y-4 text-center">
          <h1 className="text-lg font-semibold">{t("miniapp.errorTitle")}</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">{t("miniapp.errorBody")}</p>
          <button
            type="button"
            onClick={() => setRetryTick((n) => n + 1)}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            {t("miniapp.retry")}
          </button>
        </div>
      </div>
    );
  }

  // loading | authing
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-background text-foreground">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{t("miniapp.signingIn")}</p>
    </div>
  );
}
