import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useMiniApp } from "./MiniAppContext";
import TgNotLinked from "@/pages/TgNotLinked";

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

export function TelegramGate({ children }: { children: ReactNode }) {
  const { initData } = useMiniApp();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>("loading");
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    if (initData === undefined) { setPhase("loading"); return; }
    if (initData === null) { setPhase("web"); return; }

    let cancelled = false;
    (async () => {
      setPhase("authing");
      try {
        const parsed = JSON.parse(new URLSearchParams(initData).get("user") || "{}") as { id?: number };
        const tgId = Number(parsed?.id) || 0;

        // Fast re-open: is there already a session, and does it belong to THIS Telegram user?
        const { data: sess } = await supabase.auth.getSession();
        if (sess?.session) {
          const { data: prof } = await supabase
            .from("profiles")
            .select("telegram_id")
            .eq("id", sess.session.user.id)
            .maybeSingle();
          const owns = prof && Number((prof as { telegram_id: number | null }).telegram_id) === tgId && tgId > 0;
          if (owns) { if (!cancelled) setPhase("ready"); return; }
          await supabase.auth.signOut(); // cross-account mismatch → drop it and re-auth as the Telegram user
        }

        const { data, error } = await supabase.functions.invoke("tg-miniapp-auth", { body: { initData } });
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

        const target = (data as { target_path?: string }).target_path || "/dashboard";
        navigate(target, { replace: true });
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
