import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export default function ImpersonationBanner() {
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    const read = () => {
      try {
        setName(sessionStorage.getItem("impersonating"));
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
      sessionStorage.removeItem("impersonating");
    } catch {}
    try {
      await supabase.auth.signOut();
    } catch {}
    window.location.href = "/";
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
