import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";

interface Props {
  onAuth: (tg: any) => void;
  size?: "small" | "medium" | "large";
  /** Label override for the disabled fallback button. */
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
 * Always-visible "Continue with Telegram" button.
 * - When the bot is configured (bot_username present), mounts the official Telegram widget.
 * - Otherwise renders a styled, disabled-looking button with a tooltip explaining setup.
 */
export function TelegramLoginButton({ onAuth, size = "large", fallbackLabel = "Continue with Telegram" }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [botUsername, setBotUsername] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    supabase.rpc("get_public_setting", { _key: "telegram" }).then(({ data }) => {
      const u = (data as any)?.bot_username as string | undefined;
      if (u && u.trim()) setBotUsername(u.replace(/^@/, ""));
      setResolved(true);
    });
  }, []);

  useEffect(() => {
    if (!botUsername || !ref.current) return;
    (window as any).onTelegramAuth = (user: any) => onAuth(user);
    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.async = true;
    script.setAttribute("data-telegram-login", botUsername);
    script.setAttribute("data-size", size);
    script.setAttribute("data-onauth", "onTelegramAuth(user)");
    script.setAttribute("data-request-access", "write");
    script.setAttribute("data-userpic", "false");
    ref.current.innerHTML = "";
    ref.current.appendChild(script);
    return () => { ref.current && (ref.current.innerHTML = ""); };
  }, [botUsername, size, onAuth]);

  if (!resolved) {
    // Reserve space — no flash
    return <div className="h-10" />;
  }

  if (botUsername) {
    return <div ref={ref} className="flex justify-center" />;
  }

  // Not configured — always render styled fallback so the button is visible
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
