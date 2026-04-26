import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

interface Props {
  onAuth: (tg: any) => void;
  size?: "small" | "medium" | "large";
}

// Mounts the official Telegram Login Widget if a bot username is configured.
export function TelegramLoginButton({ onAuth, size = "large" }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [botUsername, setBotUsername] = useState<string | null>(null);

  useEffect(() => {
    supabase.from("platform_settings").select("value").eq("key", "telegram").maybeSingle().then(({ data }) => {
      const u = (data?.value as any)?.bot_username as string | undefined;
      if (u) setBotUsername(u.replace(/^@/, ""));
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

  if (!botUsername) return null;
  return <div ref={ref} className="flex justify-center" />;
}
