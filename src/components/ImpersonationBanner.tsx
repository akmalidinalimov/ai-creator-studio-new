import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export default function ImpersonationBanner() {
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    const read = () => {
      try {
        setName(localStorage.getItem("impersonating"));
      } catch {
        setName(null);
      }
    };
    read();
    const onStorage = () => read();
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  if (!name) return null;

  const exit = async () => {
    try {
      localStorage.removeItem("impersonating");
    } catch {}
    // Restore the admin's stashed session instead of signing out (no re-login).
    let restored = false;
    try {
      const raw = localStorage.getItem("imp_admin_backup");
      if (raw) {
        const backup = JSON.parse(raw);
        if (backup?.access_token && backup?.refresh_token) {
          const { error } = await supabase.auth.setSession({
            access_token: backup.access_token,
            refresh_token: backup.refresh_token,
          });
          if (!error) restored = true;
        }
      }
    } catch {}
    try {
      localStorage.removeItem("imp_admin_backup");
    } catch {}
    if (restored) {
      window.location.href = "/admin/users";
      return;
    }
    // Fallback: no valid stashed admin session — log out cleanly (old behavior).
    try {
      await supabase.auth.signOut();
    } catch {}
    window.location.href = "/login";
  };

  return (
    <div
      style={{ zIndex: 2147483646 }}
      className="fixed top-0 left-0 right-0 bg-red-600 text-white text-sm px-4 py-2 flex items-center justify-center gap-3 shadow-md"
    >
      <span>👁 Viewing as {name} (read-only)</span>
      <button
        onClick={exit}
        className="underline font-semibold hover:opacity-80"
      >
        Exit
      </button>
    </div>
  );
}
