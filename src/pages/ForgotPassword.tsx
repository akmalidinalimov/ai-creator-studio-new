import { useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthShell } from "./Login";
import { toast } from "sonner";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/reset-password` });
    setLoading(false);
    if (error) toast.error(error.message);
    else toast.success("Reset link sent — check your email");
  };
  return (
    <AuthShell title="Reset your password" subtitle="We'll email you a secure link.">
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1.5"><Label htmlFor="email">Email</Label><Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
        <Button type="submit" className="w-full" disabled={loading}>Send reset link</Button>
      </form>
      <p className="text-sm text-center text-muted-foreground"><Link to="/login" className="hover:underline">Back to sign in</Link></p>
    </AuthShell>
  );
}
