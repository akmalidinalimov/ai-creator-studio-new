import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export function WeeklyDigestTile() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.rpc("weekly_digest_status" as any);
      setEnabled(!!data);
    })();
  }, []);

  const toggle = async (v: boolean) => {
    setBusy(true);
    const { error } = await supabase.rpc("weekly_digest_set_enabled" as any, { _enabled: v });
    setBusy(false);
    if (error) toast.error(error.message);
    else { setEnabled(v); toast.success(v ? "Haftalik digest yoqildi" : "Haftalik digest o'chirildi"); }
  };

  const sendTest = async () => {
    setBusy(true);
    const { data, error } = await supabase.functions.invoke("weekly-digest", { body: { dry_run: true } });
    setBusy(false);
    if (error) toast.error(error.message);
    else toast.success(`Test (dry run): ${(data as any)?.sent ?? 0} ga yuborilardi`);
  };

  return (
    <Card className="p-4 h-full flex flex-col gap-2">
      <div className="text-xs text-muted-foreground">📬 Haftalik digest</div>
      <div className="flex items-center justify-between">
        <span className={`text-sm font-semibold ${enabled ? "text-green-600" : "text-muted-foreground"}`}>
          {enabled === null ? "…" : enabled ? "Yoqilgan" : "O'chirilgan"}
        </span>
        <Switch checked={!!enabled} onCheckedChange={toggle} disabled={busy || enabled === null} />
      </div>
      <Button size="sm" variant="outline" onClick={sendTest} disabled={busy}>Dry-run sinash</Button>
    </Card>
  );
}
