import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { SB_BASE } from "@/lib/supabaseBase";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

const TelegramIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.24 3.64 11.95c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z" />
  </svg>
);

const POLL_INTERVAL_MS = 2000;
const MAX_DURATION_MS = 5 * 60 * 1000;

interface Props {
  onSuccess: () => void;
}

export function TelegramDeeplinkButton({ onSuccess }: Props) {
  const { t } = useTranslation();
  const [waiting, setWaiting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [deeplink, setDeeplink] = useState<string | null>(null);
  const [expiredMsg, setExpiredMsg] = useState<string | null>(null);
  const stopRef = useRef<{ poll?: number; deadline?: number }>({});
  // One poll at a time, and never after the sign-in landed — see the comment in poll().
  const inFlightRef = useRef(false);
  const doneRef = useRef(false);

  useEffect(() => {
    return () => {
      if (stopRef.current.poll) window.clearInterval(stopRef.current.poll);
    };
  }, []);

  const stopPolling = () => {
    if (stopRef.current.poll) {
      window.clearInterval(stopRef.current.poll);
      stopRef.current.poll = undefined;
    }
  };

  const begin = async () => {
    setStarting(true);
    setExpiredMsg(null);
    // Clear both latches: a previous attempt that won the poll but failed at setSession would
    // otherwise leave doneRef set, and every poll of the NEW token would return immediately —
    // a permanently stuck "Waiting…" that only a page reload could clear.
    doneRef.current = false;
    inFlightRef.current = false;
    try {
      const url = `${SB_BASE}/functions/v1/telegram-login-start`;
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await r.json();
      if (!r.ok || !data?.token || !data?.deeplink) {
        toast.error(data?.error || t("telegramDeeplink.startFailed"));
        setStarting(false);
        return;
      }
      setToken(data.token);
      setDeeplink(data.deeplink);
      window.open(data.deeplink, "_blank", "noopener,noreferrer");
      setWaiting(true);
      stopRef.current.deadline = Date.now() + MAX_DURATION_MS;
      stopRef.current.poll = window.setInterval(() => poll(data.token), POLL_INTERVAL_MS);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const poll = async (tok: string) => {
    if (doneRef.current) return;
    // Deadline BEFORE the in-flight guard: fetch has no timeout, so a hung request would otherwise
    // pin inFlightRef and the 5-minute expiry would never evaluate — a spinner that waits forever
    // and never tells the student anything.
    if (!stopRef.current.deadline || Date.now() > stopRef.current.deadline) {
      stopPolling();
      setWaiting(false);
      setExpiredMsg(t("telegramDeeplink.expired"));
      return;
    }
    // telegram-login-status BURNS the token — it deletes the row the moment it mints a session — so a
    // second poll overlapping the winning one finds nothing, reads "expired", and shows a dead end
    // over a sign-in that just succeeded. The same class as the magic-link double-redeem: a one-shot
    // token spent twice. The interval fires every 2s whether or not the previous call has returned,
    // and minting costs two server round-trips, so that overlap is ordinary rather than exotic.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const url = `${SB_BASE}/functions/v1/telegram-login-status`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: tok }),
      });
      const data = await r.json();
      if (data?.status === "authenticated" && data.session) {
        doneRef.current = true; // claim the win before awaiting, so a queued tick can't undo it
        stopPolling();
        const { error } = await supabase.auth.setSession({
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
        });
        if (error) {
          toast.error(error.message);
          setWaiting(false);
          return;
        }
        onSuccess();
      } else if (data?.status === "expired") {
        stopPolling();
        setWaiting(false);
        setExpiredMsg(t("telegramDeeplink.expired"));
      }
    } catch {
      // transient — keep polling
    } finally {
      inFlightRef.current = false;
    }
  };

  const retry = () => {
    setExpiredMsg(null);
    setToken(null);
    setDeeplink(null);
    setWaiting(false);
    void begin();
  };

  if (expiredMsg) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-destructive text-center">{expiredMsg}</p>
        <Button type="button" className="w-full" onClick={retry} variant="outline">
          {t("telegramDeeplink.retry")}
        </Button>
      </div>
    );
  }

  if (waiting) {
    return (
      <div className="space-y-2">
        <Button
          type="button"
          className="w-full bg-[#229ED9] hover:bg-[#1c8cc2] text-white border-transparent"
          disabled
        >
          <Loader2 className="h-4 w-4 animate-spin" /> {t("telegramDeeplink.waiting")}
        </Button>
        {deeplink && (
          <p className="text-xs text-muted-foreground text-center">
            {t("telegramDeeplink.didntOpen")}{" "}
            <a href={deeplink} target="_blank" rel="noopener noreferrer" className="underline">
              {t("telegramDeeplink.openAgain")}
            </a>
          </p>
        )}
      </div>
    );
  }

  return (
    <Button
      type="button"
      className="w-full bg-[#229ED9] hover:bg-[#1c8cc2] text-white border-transparent"
      onClick={begin}
      disabled={starting}
    >
      {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <TelegramIcon />}
      {t("telegramDeeplink.label")}
    </Button>
  );
}
