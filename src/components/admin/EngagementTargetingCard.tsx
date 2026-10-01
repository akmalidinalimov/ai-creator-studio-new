import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { saveWithToast } from "@/lib/mutate";
import type { Json } from "@/integrations/supabase/types";
import {
  ENGAGEMENT_TARGETING_KEY,
  parseEngagementTargeting,
  type TargetingSwitch,
  TARGETING_SWITCHES,
  withTargetingSwitch,
} from "@/lib/engagementTargeting";

// «Eslatmalar kimga boradi» — the owner's switches for WHO the automatic student reminders go to
// (platform_settings.engagement_targeting; see src/lib/engagementTargeting.ts). cron-engagement and
// detect-and-nudge read them within 60 s. Off (or an absent row) is the old behaviour. Each flip is one guarded
// write (saveWithToast): a 0-row write is "not saved", never a false "Saqlandi".

const COPY: Record<TargetingSwitch, { label: string; desc: string }> = {
  skip_closed_courses: {
    label: "Yopiq kurs talabalariga eslatma yubormaslik",
    desc:
      "Kursi yopilgan (nashr qilinmagan) va boshqa ochiq kursi yoʻq talabaga kunlik eslatma, streak va qaytish " +
      "xabarlari yuborilmaydi (masalan, 4.0 bitiruvchilari — tugma yopiq darsga olib borardi). Ochiq kursga " +
      "yozilsa, eslatmalar oʻzi qayta boshlanadi.",
  },
  trial_to_course_page: {
    label: "Sinov (trial) talabaning tugmasi kurs sahifasini ochsin",
    desc:
      "Sinov hisobidagi talaba darsni ocha olmaydi. Eslatma tugmasi yopiq dars oʻrniga kurs sahifasini " +
      "(sinov haqidagi xabarni) ochadi.",
  },
  retire_smart_inactive_nudges: {
    label: "3 va 7 kunlik smart eslatmalarni toʻxtatish",
    desc:
      "Qaytish seriyasi (3 / 7 / 14 / 30 kun) baribir yuboriladi; smart eslatmalarning koʻpi u bilan 2 kun ichida " +
      "takrorlanardi. «Modul tugadi» tabrigi qoladi.",
  },
};

export function EngagementTargetingCard() {
  const { user } = useAuth();
  // The stored object as read (other keys are kept on write). undefined = loading, null = could not be read.
  const [stored, setStored] = useState<unknown>(undefined);
  const [busy, setBusy] = useState<TargetingSwitch | null>(null);

  useEffect(() => {
    let alive = true;
    supabase
      .from("platform_settings")
      .select("value")
      .eq("key", ENGAGEMENT_TARGETING_KEY)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!alive) return;
        setStored(error ? null : (data?.value ?? {}));
      });
    return () => {
      alive = false;
    };
  }, []);

  const unreadable = stored === null;
  const loading = stored === undefined;
  const on = parseEngagementTargeting(stored);

  async function flip(key: TargetingSwitch, next: boolean) {
    // Never write on top of a value we could not read: it would drop whatever else the row holds.
    if (loading || unreadable || busy) return;
    const value = withTargetingSwitch(stored, key, next);
    setBusy(key);
    const r = await saveWithToast(
      () =>
        supabase.from("platform_settings").upsert(
          { key: ENGAGEMENT_TARGETING_KEY, value: value as Json, updated_by: user?.id ?? null, updated_at: new Date().toISOString() },
          { onConflict: "key" },
        ),
      { success: "Saqlandi — 1 daqiqa ichida kuchga kiradi", failure: "Saqlanmadi", returning: "key" },
    );
    setBusy(null);
    if (r.ok) setStored(value);
  }

  return (
    <Card className="p-4 space-y-3" data-testid="engagement-targeting">
      <div>
        <div className="font-semibold">🎯 Eslatmalar kimga boradi</div>
        <div className="text-xs text-muted-foreground">
          Kunlik eslatma, streak, qaytish seriyasi va smart eslatmalar uchun. Oʻchirilgan — avvalgi holat.
        </div>
      </div>
      {unreadable && (
        <div className="text-sm text-destructive">Sozlamani oʻqib boʻlmadi — sahifani yangilang.</div>
      )}
      <ul className="divide-y">
        {TARGETING_SWITCHES.map((key) => (
          <li key={key} className="flex items-start justify-between gap-4 py-3">
            <div className="min-w-0">
              <div className="text-sm font-medium" id={`et-${key}`}>{COPY[key].label}</div>
              <div className="text-xs text-muted-foreground">{COPY[key].desc}</div>
            </div>
            <Switch
              aria-labelledby={`et-${key}`}
              checked={on[key]}
              disabled={loading || unreadable || busy !== null}
              onCheckedChange={(v) => flip(key, v)}
            />
          </li>
        ))}
      </ul>
    </Card>
  );
}
