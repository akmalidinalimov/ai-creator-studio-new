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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    (async () => {
      try {
        const [allRes, mineRes] = await Promise.all([
          supabase.from("badges").select("*").order("position"),
          user ? supabase.from("user_badges").select("badge_id").eq("user_id", user.id) : Promise.resolve({ data: [], error: null } as any),
        ]);
        if (allRes.error) throw allRes.error;
        if ((mineRes as any).error) throw (mineRes as any).error;
        if (cancelled) return;
        setBadges((allRes.data as any) || []);
        setEarned(new Set((((mineRes as any).data) || []).map((r: any) => r.badge_id)));
      } catch (e) {
        if (cancelled) return;
        console.error("[Badges] load failed", e);
        setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user, reloadKey]);

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
        {loading && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Card key={i} className="p-5 h-28 animate-pulse bg-muted/40" />
            ))}
          </div>
        )}
        {!loading && error && (
          <Card className="p-8 text-center">
            <p className="text-sm text-muted-foreground">Nishonlarni yuklab bo'lmadi.</p>
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              className="mt-3 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              Qayta urinish
            </button>
          </Card>
        )}
        {!loading && !error && badges.length === 0 && (
          <Card className="p-8 text-center text-sm text-muted-foreground">Hali nishonlar yo'q</Card>
        )}
        {!loading && !error && badges.length > 0 && (
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
        )}
      </div>
    </PageShell>
  );
}
