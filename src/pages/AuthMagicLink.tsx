import { useEffect, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function AuthMagicLink() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = params.get("t");
    if (!token) {
      setError(t("authMagic.invalid"));
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/magic-link-redeem`;
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const data = await r.json();
        if (!r.ok || !data?.session) {
          if (!cancelled) setError(data?.message || t("authMagic.invalid"));
          return;
        }
        const { error: setErr } = await supabase.auth.setSession({
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
        });
        if (setErr) {
          if (!cancelled) setError(setErr.message);
          return;
        }
        try {
          if (params.get("imp") === "1") {
            sessionStorage.setItem("impersonating", params.get("as") || "user");
          }
        } catch { /* ignore */ }
        if (!cancelled) navigate(data.target_path || "/dashboard", { replace: true });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params, navigate, t]);

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
