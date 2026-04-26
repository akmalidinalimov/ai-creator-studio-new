import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { Loader2, Mail, Lock } from "lucide-react";
import { TelegramLoginButton } from "@/components/TelegramLoginButton";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";

const GoogleIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
);

export const AuthShell = ({ children, title, subtitle }: { children: React.ReactNode; title: string; subtitle: string }) => {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen grid lg:grid-cols-2 relative">
      <div className="absolute top-3 right-3 z-10">
        <LanguageSwitcher variant="compact" />
      </div>
      <div className="hidden lg:flex flex-col justify-between p-10 bg-foreground text-background">
        <div className="flex items-center gap-2 font-semibold">
          <span className="inline-block w-6 h-6 rounded-md bg-background" />
          AI Creators
        </div>
        <div className="space-y-6 max-w-md">
          <h2 className="text-4xl font-semibold tracking-tight leading-tight">{t("auth.tagline")}</h2>
          <p className="text-background/70 leading-relaxed">{t("auth.taglineSub")}</p>
          <div className="grid grid-cols-3 gap-4 pt-4">
            <Stat n="14h" label={t("auth.statHours")} />
            <Stat n="20" label={t("auth.statLessons")} />
            <Stat n="∞" label={t("auth.statTutor")} />
          </div>
        </div>
        <p className="text-xs text-background/50">© AI Creators</p>
      </div>
      <div className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm space-y-6 animate-fade-in">
          <div className="lg:hidden flex items-center gap-2 font-semibold mb-6">
            <span className="inline-block w-6 h-6 rounded-md bg-foreground" /> AI Creators
          </div>
          <div className="space-y-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
};

const Stat = ({ n, label }: { n: string; label: string }) => (
  <div><div className="text-2xl font-semibold">{n}</div><div className="text-xs text-background/60">{label}</div></div>
);

export default function Login() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { user, role, loading: authLoading } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [magicMode, setMagicMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [lockMessage, setLockMessage] = useState<string>("");
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!authLoading && user) {
      navigate(role === "admin" ? "/admin" : "/dashboard", { replace: true });
    }
  }, [user, role, authLoading, navigate]);

  useEffect(() => {
    if (!lockedUntil) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= lockedUntil) {
        setLockedUntil(null);
        setLockMessage("");
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [lockedUntil]);

  const remainingMs = lockedUntil ? Math.max(0, lockedUntil - now) : 0;
  const remainingMin = Math.floor(remainingMs / 60_000);
  const remainingSec = Math.floor((remainingMs % 60_000) / 1000);

  const callGuard = async (action: "check" | "record", body: Record<string, unknown> = {}) => {
    try {
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/login-guard`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, email: email.trim().toLowerCase(), ...body }),
      });
      const data = await r.json();
      return { status: r.status, data };
    } catch {
      return { status: 0, data: null };
    }
  };

  const onGoogle = async () => {
    setLoading(true);
    const r = await lovable.auth.signInWithOAuth("google", { redirect_uri: window.location.origin });
    if (r.error) { toast.error(t("auth.googleFailed")); setLoading(false); }
  };

  const onMagicLink = async () => {
    if (!email) { toast.error(t("auth.enterEmailFirst")); return; }
    setLoading(true);
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/dashboard` },
    });
    setLoading(false);
    if (error) toast.error(error.message);
    else toast.success(t("auth.magicSent"));
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setLoading(true);

    if (magicMode) {
      await onMagicLink();
      setLoading(false);
      return;
    }

    const check = await callGuard("check");
    if (check.status === 429 && check.data?.locked) {
      setLockedUntil(check.data.locked_until_ms);
      setLockMessage(check.data.message || t("auth.lockedTitle"));
      toast.error(check.data.message);
      setLoading(false);
      return;
    }

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    callGuard("record", { success: !error });

    if (error) {
      toast.error(error.message);
      const recheck = await callGuard("check");
      if (recheck.status === 429 && recheck.data?.locked) {
        setLockedUntil(recheck.data.locked_until_ms);
        setLockMessage(recheck.data.message);
      }
    }
    setLoading(false);
  };

  const onTelegram = async (tg: any) => {
    setLoading(true);
    try {
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/telegram-auth`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tg, redirectTo: `${window.location.origin}/dashboard` }),
      });
      const res = await r.json();
      if (res?.url) { window.location.href = res.url; return; }
      toast.error(res?.error || t("auth.telegramFailed"));
    } finally {
      setLoading(false);
    }
  };

  const isLocked = lockedUntil !== null && remainingMs > 0;
  const timeStr = `${String(remainingMin).padStart(2, "0")}:${String(remainingSec).padStart(2, "0")}`;

  return (
    <AuthShell title={t("auth.welcomeBack")} subtitle={t("auth.signInToContinue")}>
      {isLocked && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 space-y-2">
          <p className="text-sm font-medium text-destructive">{lockMessage || t("auth.lockedTitle")}</p>
          <p className="text-xs text-muted-foreground tabular-nums">
            {t("auth.tryAgainIn", { time: timeStr })}
          </p>
          <Link to="/forgot-password" className="text-xs font-medium text-foreground underline underline-offset-2">
            {t("auth.resetInstead")}
          </Link>
        </div>
      )}

      <Button variant="outline" className="w-full" onClick={onGoogle} disabled={loading || isLocked}>
        <GoogleIcon /> {t("auth.continueGoogle")}
      </Button>
      <TelegramLoginButton onAuth={onTelegram} />
      <Button variant="outline" className="w-full" onClick={onMagicLink} disabled={loading || isLocked || !email}>
        <Mail className="h-4 w-4" /> {t("auth.magicLink")}
      </Button>

      <div className="relative my-2"><div className="absolute inset-0 flex items-center"><span className="w-full border-t" /></div><div className="relative flex justify-center text-xs uppercase"><span className="bg-background px-2 text-muted-foreground">{t("common.or")}</span></div></div>

      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="email">{t("auth.email")}</Label>
          <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </div>
        {!magicMode && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">{t("auth.password")}</Label>
              <Link to="/forgot-password" className="text-xs text-muted-foreground hover:text-foreground">{t("auth.forgot")}</Link>
            </div>
            <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
          </div>
        )}
        <Button type="submit" className="w-full" disabled={loading || isLocked}>
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          <Lock className="h-4 w-4" />
          {t("auth.signInPassword")}
        </Button>
      </form>
      <p className="text-sm text-center text-muted-foreground">
        {t("auth.noAccount")} <Link to="/signup" className="text-foreground font-medium hover:underline">{t("auth.signUp")}</Link>
      </p>
    </AuthShell>
  );
}
