import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";

interface Props {
  onAuth: (tg: any) => void;
  size?: "small" | "medium" | "large";
  /** Label shown on the button. Defaults to Uzbek. */
  fallbackLabel?: string;
}

const TG_NOT_CONFIGURED_MSG =
  "Telegram login isn't configured yet — admin can set it up in Settings → Telegram Login.";

const TelegramIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.24 3.64 11.95c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/>
  </svg>
);

/**
 * Always-visible Telegram login button with a custom label.
 * - When the bot is configured, opens Telegram's OAuth popup (oauth.telegram.org/auth)
 *   and listens for the user payload via window.postMessage. This avoids the official
 *   widget script (which renders its own non-customizable label).
 * - When not configured, renders a styled, disabled-looking button with a tooltip.
 */
export function TelegramLoginButton({
  onAuth,
  size: _size = "large",
  fallbackLabel = "Telegram Bilan Kirish",
}: Props) {
  const [botUsername, setBotUsername] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    supabase.rpc("get_public_setting", { _key: "telegram" }).then(({ data }) => {
      const u = (data as any)?.bot_username as string | undefined;
      if (u && u.trim()) setBotUsername(u.replace(/^@/, ""));
      setResolved(true);
    });
  }, []);

  const openTelegramAuth = () => {
    if (!botUsername) return;
    setOpening(true);

    const origin = window.location.origin;
    const params = new URLSearchParams({
      bot_id: "", // Telegram resolves bot_id from domain when using username flow below
      origin,
      embed: "0",
      request_access: "write",
      return_to: origin,
    });
    // Telegram supports username-based auth via the /auth/?bot=... path
    const url = `https://oauth.telegram.org/auth?bot=${encodeURIComponent(
      botUsername,
    )}&origin=${encodeURIComponent(origin)}&request_access=write&return_to=${encodeURIComponent(origin)}`;

    const w = 550;
    const h = 470;
    const left = window.screenX + (window.outerWidth - w) / 2;
    const top = window.screenY + (window.outerHeight - h) / 2.5;
    const popup = window.open(
      url,
      "telegram-oauth",
      `width=${w},height=${h},left=${left},top=${top},scrollbars=yes`,
    );

    if (!popup) {
      setOpening(false);
      toast.error("Popup blocked — please allow popups for this site.");
      return;
    }

    let done = false;

    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      clearInterval(closedTimer);
      setOpening(false);
    };

    const onMessage = (ev: MessageEvent) => {
      // Telegram posts JSON strings from oauth.telegram.org
      if (typeof ev.data !== "string") return;
      if (!/oauth\.telegram\.org/.test(ev.origin)) return;
      try {
        const payload = JSON.parse(ev.data);
        const event = payload?.event || payload?.type;
        if (event === "auth_result" && payload.result) {
          done = true;
          try { popup.close(); } catch (_) { /* ignore */ }
          cleanup();
          onAuth(payload.result);
        } else if (event === "auth_user" && payload.auth_data) {
          done = true;
          try { popup.close(); } catch (_) { /* ignore */ }
          cleanup();
          onAuth(payload.auth_data);
        }
      } catch (_) {
        // ignore non-JSON messages
      }
    };

    const closedTimer = setInterval(() => {
      if (popup.closed) {
        cleanup();
        if (!done) toast.message("Telegram sign-in cancelled.");
      }
    }, 500);

    window.addEventListener("message", onMessage);
    void params; // retain for future flag tweaks
  };

  if (!resolved) {
    // Reserve space — no flash
    return <div className="h-10" />;
  }

  if (botUsername) {
    return (
      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={openTelegramAuth}
        disabled={opening}
      >
        <TelegramIcon /> {fallbackLabel}
      </Button>
    );
  }

  // Not configured — styled disabled fallback with tooltip
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="w-full opacity-60 cursor-not-allowed"
            onClick={(e) => { e.preventDefault(); toast.message(TG_NOT_CONFIGURED_MSG); }}
          >
            <TelegramIcon /> {fallbackLabel}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs text-center">
          {TG_NOT_CONFIGURED_MSG}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
