import { useState } from "react";
import { getSiteUrl } from "@/lib/siteUrl";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthShell } from "./Login";
import { toast } from "sonner";
import { translateAuthError } from "@/lib/authErrors";
import { Loader2 } from "lucide-react";
import { TelegramDeeplinkButton } from "@/components/TelegramDeeplinkButton";

export default function Signup() {
  const nav = useNavigate();
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const onGoogle = async () => {
    const r = await lovable.auth.signInWithOAuth("google", { redirect_uri: getSiteUrl() });
    if (r.error) toast.error(t("auth.googleFailed"));
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) { toast.error(t("auth.passwordMin")); return; }
    setLoading(true);
    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: {
        emailRedirectTo: getSiteUrl(),
        data: { name, last_name: lastName || null },
      },
    });
    setLoading(false);
    if (error) { toast.error(translateAuthError(t, error.message)); return; }
    if (lastName && data.user) {
      await supabase.from("profiles").update({ last_name: lastName } as any).eq("id", data.user.id);
    }
    if (data.session) {
      toast.success(t("auth.welcomeToast"));
      nav("/dashboard");
    } else {
      toast.success(t("auth.checkEmail"));
      nav("/login");
    }
  };

  const onTelegramSuccess = () => {
    nav("/dashboard", { replace: true });
  };

  return (
    <AuthShell title={t("auth.createAccount")} subtitle={t("auth.startLearning")}>
      <Button variant="outline" className="w-full" onClick={onGoogle}>{t("auth.continueGoogle")}</Button>
      <TelegramDeeplinkButton onSuccess={onTelegramSuccess} />
      <div className="relative my-2"><div className="absolute inset-0 flex items-center"><span className="w-full border-t" /></div><div className="relative flex justify-center text-xs uppercase"><span className="bg-background px-2 text-muted-foreground">{t("common.or")}</span></div></div>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5"><Label htmlFor="name">{t("auth.firstName")}</Label><Input id="name" value={name} onChange={(e) => setName(e.target.value)} required /></div>
          <div className="space-y-1.5"><Label htmlFor="last_name">{t("auth.lastName")}</Label><Input id="last_name" value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder={t("common.optional")} /></div>
        </div>
        <div className="space-y-1.5"><Label htmlFor="email">{t("auth.email")}</Label><Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" /></div>
        <div className="space-y-1.5"><Label htmlFor="password">{t("auth.password")}</Label><Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete="new-password" /></div>
        <Button type="submit" className="w-full" disabled={loading}>{loading && <Loader2 className="h-4 w-4 animate-spin" />}{t("auth.createAccountBtn")}</Button>
      </form>
      <p className="text-sm text-center text-muted-foreground">{t("auth.haveAccount")} <Link to="/login" className="text-foreground font-medium hover:underline">{t("auth.signIn")}</Link></p>
    </AuthShell>
  );
}
