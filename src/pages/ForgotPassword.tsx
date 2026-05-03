import { useState } from "react";
import { getSiteUrl } from "@/lib/siteUrl";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthShell } from "./Login";
import { toast } from "sonner";

export default function ForgotPassword() {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${getSiteUrl()}/reset-password` });
    setLoading(false);
    if (error) toast.error(error.message);
    else toast.success(t("auth.resetSent"));
  };
  return (
    <AuthShell title={t("auth.forgotTitle")} subtitle={t("auth.forgotSubtitle")}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1.5"><Label htmlFor="email">{t("auth.email")}</Label><Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
        <Button type="submit" className="w-full" disabled={loading}>{t("auth.sendResetLink")}</Button>
      </form>
      <p className="text-sm text-center text-muted-foreground"><Link to="/login" className="hover:underline">← {t("auth.signIn")}</Link></p>
    </AuthShell>
  );
}
