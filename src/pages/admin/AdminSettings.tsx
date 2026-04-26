import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Eye, EyeOff } from "lucide-react";

export default function AdminSettings() {
  const { user } = useAuth();
  const [botUsername, setBotUsername] = useState("");
  const [botToken, setBotToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    supabase.from("platform_settings").select("value").eq("key", "telegram").maybeSingle().then(({ data }) => {
      const v = (data?.value as any) || {};
      setBotUsername(v.bot_username || "");
      setBotToken(v.bot_token || "");
    });
  }, []);

  const save = async () => {
    setSaving(true);
    const value = { bot_username: botUsername.replace(/^@/, ""), bot_token: botToken };
    const { error } = await supabase.from("platform_settings").upsert({
      key: "telegram", value, updated_by: user?.id,
    } as any, { onConflict: "key" });
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("Saved");
  };

  return (
    <PageShell>
      <div className="max-w-3xl space-y-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
          <p className="text-muted-foreground mt-1">Platform integrations and configuration.</p>
        </div>

        <Card className="p-6 shadow-soft space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Telegram Login</h2>
            <p className="text-sm text-muted-foreground mt-1">Let students sign in with their Telegram account.</p>
          </div>

          <div className="space-y-1.5">
            <Label>Telegram bot username</Label>
            <Input value={botUsername} onChange={(e) => setBotUsername(e.target.value)} placeholder="AICreatorsBot" />
          </div>

          <div className="space-y-1.5">
            <Label>Telegram bot token</Label>
            <div className="flex gap-2">
              <Input
                type={showToken ? "text" : "password"}
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder="123456:ABC-DEF..."
              />
              <Button type="button" variant="outline" size="icon" onClick={() => setShowToken((s) => !s)}>
                {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          <div className="rounded-lg border bg-muted/30 p-4 text-sm space-y-2">
            <p className="font-medium">How to set up</p>
            <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
              <li>Open <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="underline">@BotFather</a> on Telegram → <code>/newbot</code> → pick a name and username → save the token.</li>
              <li>Run <code>/setdomain</code> in BotFather → paste your live domain (e.g. <code>{window.location.hostname}</code>).</li>
              <li>Paste the username and token here, then save.</li>
              <li>To link a student's account, set their <code>telegram_username</code> on the Users page.</li>
            </ol>
          </div>

          <div className="flex justify-end">
            <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
          </div>
        </Card>
      </div>
    </PageShell>
  );
}
