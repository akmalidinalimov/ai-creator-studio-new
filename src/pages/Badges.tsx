import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";

interface Badge {
  id: string; code: string; icon: string | null;
  name_uz: string; name_ru: string; name_en: string;
  description_uz: string | null; description_ru: string | null; description_en: string | null;
  position: number;
}

export default function Badges() {
  const { user } = useAuth();
  const { i18n } = useTranslation();
  const [badges, setBadges] = useState<Badge[]>([]);
  const [earned, setEarned] = useState<Set<string>>(new Set());

  useEffect(() => {
    (async () => {
      const [{ data: all }, { data: mine }] = await Promise.all([
        supabase.from("badges").select("*").order("position"),
        user ? supabase.from("user_badges").select("badge_id").eq("user_id", user.id) : Promise.resolve({ data: [] } as any),
      ]);
      setBadges((all as any) || []);
      setEarned(new Set(((mine as any) || []).map((r: any) => r.badge_id)));
    })();
  }, [user]);

  const lng = (i18n.language || "uz").slice(0, 2);
  const pickName = (b: Badge) => (lng === "ru" ? b.name_ru : lng === "en" ? b.name_en : b.name_uz);
  const pickDesc = (b: Badge) => (lng === "ru" ? b.description_ru : lng === "en" ? b.description_en : b.description_uz) || "";

  const earnedCount = badges.filter(b => earned.has(b.id)).length;

  return (
    <PageShell>
      <div className="max-w-4xl space-y-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">🏅 Nishonlar</h1>
          <p className="text-sm text-muted-foreground mt-1">{earnedCount} / {badges.length} olingan</p>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {badges.map((b) => {
            const got = earned.has(b.id);
            return (
              <Card key={b.id} className={`p-5 text-center ${got ? "" : "opacity-40 grayscale"}`}>
                <div className="text-4xl mb-2">{b.icon || "🏅"}</div>
                <div className="font-semibold text-sm">{pickName(b)}</div>
                <div className="text-xs text-muted-foreground mt-1">{pickDesc(b)}</div>
              </Card>
            );
          })}
        </div>
      </div>
    </PageShell>
  );
}
