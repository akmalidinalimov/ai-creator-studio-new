import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export function NudgePreferencesCard({ userId }: { userId?: string }) {
  const [optIn, setOptIn] = useState(true);
  const [pausedUntil, setPausedUntil] = useState<string>("");

  useEffect(() => {
    if (!userId) return;
    (async () => {
      const { data } = await supabase
        .from("nudge_preferences")
        .select("opt_in, paused_until")
        .eq("profile_id", userId)
        .maybeSingle();
      if (data) {
        setOptIn(data.opt_in ?? true);
        setPausedUntil(data.paused_until || "");
      }
    })();
  }, [userId]);

  async function save(next: { opt_in?: boolean; paused_until?: string | null }) {
    if (!userId) return;
    const payload: any = { profile_id: userId, opt_in: optIn, paused_until: pausedUntil || null, ...next };
    const { error } = await supabase.from("nudge_preferences").upsert(payload, { onConflict: "profile_id" });
    if (error) toast.error(error.message);
    else toast.success("Saqlandi");
  }

  return (
    <Card className="p-5 shadow-soft space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="font-semibold">🔔 Eslatmalar olish</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Eslatmalar haftada 3 martagacha, 22:00 dan oldin yoki 08:00 dan keyin yuboriladi.
          </p>
        </div>
        <Switch
          checked={optIn}
          onCheckedChange={(v) => {
            setOptIn(v);
            save({ opt_in: v });
          }}
        />
      </div>
      <div className="space-y-1.5">
        <Label>Vaqtinchalik to'xtatish (qaytadan boshlash sanasi)</Label>
        <Input
          type="date"
          value={pausedUntil}
          onChange={(e) => setPausedUntil(e.target.value)}
          onBlur={() => save({ paused_until: pausedUntil || null })}
        />
      </div>
    </Card>
  );
}
