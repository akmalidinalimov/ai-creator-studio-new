import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { TelegramLoginButton } from "@/components/TelegramLoginButton";

const GoogleIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
);

export const AuthShell = ({ children, title, subtitle }: { children: React.ReactNode; title: string; subtitle: string }) => (
  <div className="min-h-screen grid lg:grid-cols-2">
    <div className="hidden lg:flex flex-col justify-between p-10 bg-foreground text-background">
      <div className="flex items-center gap-2 font-semibold">
        <span className="inline-block w-6 h-6 rounded-md bg-background" />
        AI Creators
      </div>
      <div className="space-y-6 max-w-md">
        <h2 className="text-4xl font-semibold tracking-tight leading-tight">Build, ship, and monetize with AI — end to end.</h2>
        <p className="text-background/70 leading-relaxed">A production-grade curriculum for the new generation of AI-native creators. 5 modules. 20 lessons. Built to compound.</p>
        <div className="grid grid-cols-3 gap-4 pt-4">
          <Stat n="14h" label="of lessons" />
          <Stat n="20" label="lessons" />
          <Stat n="∞" label="AI tutor" />
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

const Stat = ({ n, label }: { n: string; label: string }) => (
  <div><div className="text-2xl font-semibold">{n}</div><div className="text-xs text-background/60">{label}</div></div>
);

export default function Login() {
  const navigate = useNavigate();
  const { user, role, loading: authLoading } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [magic, setMagic] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!authLoading && user) {
      navigate(role === "admin" ? "/admin" : "/dashboard", { replace: true });
    }
  }, [user, role, authLoading, navigate]);

  const onGoogle = async () => {
    setLoading(true);
    const r = await lovable.auth.signInWithOAuth("google", { redirect_uri: window.location.origin });
    if (r.error) { toast.error("Google sign in failed"); setLoading(false); }
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    if (magic) {
      const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
      if (error) toast.error(error.message); else toast.success("Check your email for a sign-in link");
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) toast.error(error.message);
    }
    setLoading(false);
  };

  return (
    <AuthShell title="Welcome back" subtitle="Sign in to continue your learning.">
      <Button variant="outline" className="w-full" onClick={onGoogle} disabled={loading}>
        <GoogleIcon /> Continue with Google
      </Button>
      <div className="relative my-2"><div className="absolute inset-0 flex items-center"><span className="w-full border-t" /></div><div className="relative flex justify-center text-xs uppercase"><span className="bg-background px-2 text-muted-foreground">or</span></div></div>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </div>
        {!magic && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
              <Link to="/forgot-password" className="text-xs text-muted-foreground hover:text-foreground">Forgot?</Link>
            </div>
            <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
          </div>
        )}
        <div className="flex items-center gap-2">
          <Checkbox id="magic" checked={magic} onCheckedChange={(v) => setMagic(!!v)} />
          <Label htmlFor="magic" className="text-sm font-normal text-muted-foreground cursor-pointer">Email me a sign-in link instead</Label>
        </div>
        <Button type="submit" className="w-full" disabled={loading}>
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          {magic ? "Send sign-in link" : "Sign in"}
        </Button>
      </form>
      <p className="text-sm text-center text-muted-foreground">
        Don't have an account? <Link to="/signup" className="text-foreground font-medium hover:underline">Sign up</Link>
      </p>
    </AuthShell>
  );
}
