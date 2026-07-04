import { useEffect, useState } from "react";
import { getSiteUrl } from "@/lib/siteUrl";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { translateAuthError } from "@/lib/authErrors";
import { Loader2, Mail, Lock } from "lucide-react";
import { TelegramDeeplinkButton } from "@/components/TelegramDeeplinkButton";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";

const REMEMBER_KEY = "auth.remember";

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

/**
 * If "remember me" is unchecked, ensure the supabase session is dropped
 * from localStorage when the tab/window closes — so reopening requires login.
 */
function installSessionExpiryOnClose() {
  const handler = () => {
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith("sb-") && k.endsWith("-auth-token"))
        .forEach((k) => localStorage.removeItem(k));
    } catch { /* ignore */ }
  };
  window.addEventListener("pagehide", handler, { once: true });
}

export default function Login() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { user, role, loading: authLoading } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
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

  const onMagicLink = async () => {
    if (!email) { toast.error(t("auth.enterEmailFirst")); return; }
    setLoading(true);
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${getSiteUrl()}/dashboard` },
    });
    setLoading(false);
    if (error) toast.error(translateAuthError(t, error.message));
    else toast.success(t("auth.magicSent"));
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setLoading(true);

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
      toast.error(translateAuthError(t, error.message));
      const recheck = await callGuard("check");
      if (recheck.status === 429 && recheck.data?.locked) {
        setLockedUntil(recheck.data.locked_until_ms);
        setLockMessage(recheck.data.message);
      }
    } else {
      try { localStorage.setItem(REMEMBER_KEY, remember ? "1" : "0"); } catch { /* ignore */ }
      if (!remember) installSessionExpiryOnClose();
    }
    setLoading(false);
  };

  const onTelegramSuccess = () => {
    navigate(role === "admin" ? "/admin" : "/dashboard", { replace: true });
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

      {/* Primary: Telegram */}
      <section className="space-y-3">
        <div className="text-center space-y-1">
          <p className="text-sm font-medium">{t("auth.telegramQuickTitle")}</p>
          <p className="text-xs text-muted-foreground">{t("auth.telegramQuickSub")}</p>
        </div>
        <TelegramDeeplinkButton onSuccess={onTelegramSuccess} />
      </section>

      <div className="relative my-2">
        <div className="absolute inset-0 flex items-center"><span className="w-full border-t" /></div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-background px-2 text-muted-foreground">{t("common.or")}</span>
        </div>
      </div>

      {/* Secondary: email + password */}
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="email">{t("auth.email")}</Label>
          <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">{t("auth.password")}</Label>
            <Link to="/forgot-password" className="text-xs text-muted-foreground hover:text-foreground">{t("auth.forgot")}</Link>
          </div>
          <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none">
          <Checkbox checked={remember} onCheckedChange={(v) => setRemember(v === true)} />
          {t("auth.rememberMe")}
        </label>
        <Button type="submit" className="w-full" disabled={loading || isLocked}>
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          <Lock className="h-4 w-4" />
          {t("auth.signInPassword")}
        </Button>
        <button
          type="button"
          onClick={onMagicLink}
          disabled={loading || isLocked || !email}
          className="w-full text-xs text-muted-foreground hover:text-foreground inline-flex items-center justify-center gap-1.5"
        >
          <Mail className="h-3.5 w-3.5" /> {t("auth.magicLink")}
        </button>
      </form>
      <p className="text-sm text-center text-muted-foreground">
        {t("auth.noAccount")} <Link to="/signup" className="text-foreground font-medium hover:underline">{t("auth.signUp")}</Link>
      </p>
    </AuthShell>
  );
}
