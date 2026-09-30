import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useMiniApp } from "@/lib/telegram/MiniAppContext";
import { Button, Card } from "@/components/ui-kit";
import { impersonatingReadonly } from "@/lib/mutate";
import { recordWriteAccessGranted } from "@/lib/dailyTasks";

/**
 * "Let the bot message you" (spec C15, Daily Tasks PR-7). A student is DM-eligible for the daily-task morning /
 * evening messages once profiles.telegram_write_access_at is set. tg-miniapp-auth stamps it from the SIGNED initData
 * at sign-in; this covers a session that predates that (initDataUnsafe already says yes → record it silently) and
 * lets a student who never allowed it do so with Telegram's own prompt (WebApp.requestWriteAccess, Bot API 6.9+).
 * Renders nothing outside the Mini App, once stamped, or while an admin previews (the write is impersonation-gated).
 */
export function WriteAccessCard() {
  const { user } = useAuth();
  const { webApp } = useMiniApp();
  const { t } = useTranslation();
  const [need, setNeed] = useState(false);
  const [busy, setBusy] = useState(false);
  const silentTried = useRef(false);

  useEffect(() => {
    if (!user || !webApp || impersonatingReadonly()) return;
    let alive = true;
    (async () => {
      try {
        const { data, error } = await (supabase as unknown as { from: (t: string) => any })
          .from("profiles").select("telegram_write_access_at").eq("id", user.id).maybeSingle();
        if (error || !alive || data?.telegram_write_access_at) return;
        if (webApp.initDataUnsafe?.user?.allows_write_to_pm === true && !silentTried.current) {
          silentTried.current = true;
          if (await recordWriteAccessGranted()) return;
        }
        const canAsk = typeof webApp.requestWriteAccess === "function" && (webApp.isVersionAtLeast?.("6.9") ?? false);
        if (alive && canAsk) setNeed(true);
      } catch { /* optional card: nothing to show */ }
    })();
    return () => { alive = false; };
  }, [user, webApp]);

  if (!need || !webApp?.requestWriteAccess) return null;

  const ask = () => {
    if (busy || impersonatingReadonly()) return;
    setBusy(true);
    try {
      webApp.requestWriteAccess?.((granted) => {
        void (async () => {
          if (granted && (await recordWriteAccessGranted())) {
            toast.success(t("dailyTasks.notify.done"));
            setNeed(false);
          }
          setBusy(false);
        })();
      });
    } catch {
      setBusy(false);
    }
  };

  return (
    <Card className="flex items-center gap-3 p-4">
      <div className="text-2xl leading-none">🔔</div>
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-extrabold text-foreground">{t("dailyTasks.notify.title")}</div>
        <div className="text-xs font-semibold text-muted-foreground">{t("dailyTasks.notify.body")}</div>
      </div>
      <Button variant="secondary" size="sm" onClick={ask} disabled={busy}>{t("dailyTasks.notify.cta")}</Button>
    </Card>
  );
}
