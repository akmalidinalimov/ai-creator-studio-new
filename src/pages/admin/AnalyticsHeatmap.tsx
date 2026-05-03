import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { AnalyticsShell } from "@/components/admin/AnalyticsShell";

const DAYS = ["Du", "Se", "Ch", "Pa", "Ju", "Sh", "Ya"];

interface Cell { dow: number; hour: number; minutes: number; }

export default function AnalyticsHeatmap() {
  const [rows, setRows] = useState<Cell[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.rpc("analytics_heatmap" as any);
      setRows((data as Cell[]) || []);
      setLoading(false);
    })();
  }, []);

  const { grid, max } = useMemo(() => {
    const g: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
    let m = 0;
    rows.forEach((r) => {
      g[r.dow][r.hour] = Number(r.minutes);
      if (Number(r.minutes) > m) m = Number(r.minutes);
    });
    return { grid: g, max: m || 1 };
  }, [rows]);

  return (
    <AnalyticsShell title="O'qish issiqligi (30 kun)" subtitle="Toshkent vaqti bo'yicha kun×soat. To'q rang = ko'p faollik.">
      <Card className="p-5 shadow-soft overflow-x-auto">
        {loading ? (
          <p className="text-sm text-muted-foreground">Yuklanmoqda…</p>
        ) : (
          <div className="min-w-[720px]">
            <div className="grid" style={{ gridTemplateColumns: "32px repeat(24, minmax(22px, 1fr))" }}>
              <div></div>
              {Array.from({ length: 24 }, (_, h) => (
                <div key={h} className="text-[10px] text-muted-foreground text-center">{h}</div>
              ))}
              {DAYS.flatMap((d, di) => [
                <div key={`d${di}`} className="text-xs text-muted-foreground py-0.5">{d}</div>,
                ...Array.from({ length: 24 }, (_, h) => {
                  const v = grid[di][h];
                  const intensity = v / max;
                  return (
                    <div
                      key={`${di}-${h}`}
                      className="aspect-square rounded-sm m-px"
                      style={{
                        backgroundColor: v > 0
                          ? `hsl(var(--primary) / ${0.15 + intensity * 0.85})`
                          : "hsl(var(--muted))",
                      }}
                      title={`${d} ${h}:00 — ${Math.round(v)} daqiqa`}
                    />
                  );
                }),
              ])}
            </div>
          </div>
        )}
      </Card>
      <p className="text-xs text-muted-foreground">Eng faol soatlar — Telegram nudge yuborish uchun yaxshi vaqt.</p>
    </AnalyticsShell>
  );
}
