import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthShell } from "./Login";
import { toast } from "sonner";
import { translateAuthError } from "@/lib/authErrors";
import { Eye, EyeOff } from "lucide-react";

export default function ResetPassword() {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hasSession, setHasSession] = useState<boolean | null>(null);
  const nav = useNavigate();

  // Landing here without a recovery session (expired/opened directly) is a
  // dead-end: updateUser fails with "Auth session missing!". Detect it and
  // point the user back to request a fresh link.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setHasSession(!!data.session));
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) { toast.error(t("auth.passwordMin")); return; }
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (error) { toast.error(translateAuthError(t, error.message)); return; }
    toast.success(t("auth.passwordUpdated"));
    nav("/dashboard");
  };

  if (hasSession === false) {
    return (
      <AuthShell title={t("auth.newPassword")} subtitle={t("auth.forgotSubtitle")}>
        <div className="space-y-4 text-center">
          <p className="text-sm text-muted-foreground">{t("auth.resetLinkExpired", { defaultValue: "Havola muddati tugagan yoki noto'g'ri. Yangi havola so'rang." })}</p>
          <Button asChild className="w-full"><Link to="/forgot-password">{t("auth.sendResetLink")}</Link></Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={t("auth.newPassword")} subtitle={t("auth.forgotSubtitle")}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="password">{t("auth.newPassword")}</Label>
          <div className="relative">
            <Input
              id="password"
              type={show ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label={show ? t("auth.hidePassword") : t("auth.showPassword")}
            >
              {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">{t("settings.minChars")}</p>
        </div>
        <Button type="submit" className="w-full" disabled={loading}>{t("auth.updatePassword")}</Button>
      </form>
    </AuthShell>
  );
}
