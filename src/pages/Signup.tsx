import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthShell } from "./Login";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { TelegramLoginButton } from "@/components/TelegramLoginButton";

export default function Signup() {
  const nav = useNavigate();
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const onGoogle = async () => {
    const r = await lovable.auth.signInWithOAuth("google", { redirect_uri: window.location.origin });
    if (r.error) toast.error(t("auth.googleFailed"));
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) { toast.error(t("auth.passwordMin")); return; }
    setLoading(true);
    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: {
        emailRedirectTo: window.location.origin,
        data: { name, last_name: lastName || null },
      },
    });
    setLoading(false);
    if (error) { toast.error(error.message); return; }
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

  const onTelegram = async (tg: any) => {
    try {
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/telegram-auth`;
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tg, redirectTo: `${window.location.origin}/dashboard` }) });
      const res = await r.json();
      if (res?.url) { window.location.href = res.url; return; }
      toast.error(res?.error || t("auth.telegramFailed"));
    } catch (e: any) { toast.error(e.message || t("auth.telegramFailed")); }
  };

  return (
    <AuthShell title={t("auth.createAccount")} subtitle={t("auth.startLearning")}>
      <Button variant="outline" className="w-full" onClick={onGoogle}>{t("auth.continueGoogle")}</Button>
      <TelegramLoginButton onAuth={onTelegram} />
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
