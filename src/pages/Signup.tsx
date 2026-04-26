import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
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
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const onGoogle = async () => {
    const r = await lovable.auth.signInWithOAuth("google", { redirect_uri: window.location.origin });
    if (r.error) toast.error("Google sign in failed");
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 6) { toast.error("Password must be at least 6 characters"); return; }
    setLoading(true);
    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: { emailRedirectTo: window.location.origin, data: { name } },
    });
    setLoading(false);
    if (error) { toast.error(error.message); return; }
    if (data.session) {
      toast.success("Welcome to AI Creators!");
      nav("/dashboard");
    } else {
      toast.success("Check your email to verify your account");
      nav("/login");
    }
  };

  const onTelegram = async (tg: any) => {
    try {
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/telegram-auth`;
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tg, redirectTo: `${window.location.origin}/dashboard` }) });
      const res = await r.json();
      if (res?.url) { window.location.href = res.url; return; }
      toast.error(res?.error || "Telegram sign-in failed");
    } catch (e: any) { toast.error(e.message || "Telegram sign-in failed"); }
  };

  return (
    <AuthShell title="Create your account" subtitle="Start learning in under a minute.">
      <Button variant="outline" className="w-full" onClick={onGoogle}>Continue with Google</Button>
      <TelegramLoginButton onAuth={onTelegram} />
      <div className="relative my-2"><div className="absolute inset-0 flex items-center"><span className="w-full border-t" /></div><div className="relative flex justify-center text-xs uppercase"><span className="bg-background px-2 text-muted-foreground">or</span></div></div>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1.5"><Label htmlFor="name">Name</Label><Input id="name" value={name} onChange={(e) => setName(e.target.value)} required /></div>
        <div className="space-y-1.5"><Label htmlFor="email">Email</Label><Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" /></div>
        <div className="space-y-1.5"><Label htmlFor="password">Password</Label><Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} autoComplete="new-password" /></div>
        <Button type="submit" className="w-full" disabled={loading}>{loading && <Loader2 className="h-4 w-4 animate-spin" />}Create account</Button>
      </form>
      <p className="text-sm text-center text-muted-foreground">Already have an account? <Link to="/login" className="text-foreground font-medium hover:underline">Sign in</Link></p>
    </AuthShell>
  );
}
