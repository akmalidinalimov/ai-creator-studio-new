import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AnalyticsShell, exportCsv } from "@/components/admin/AnalyticsShell";
import { Download } from "lucide-react";

const LABELS: Record<string, string> = {
  registered: "Ro'yxatdan o'tdi",
  logged_in: "Tizimga kirdi",
  watched_30s: "Birinchi darsni ko'rdi (30s+)",
  finished_m1: "1 modulni tugatdi",
  finished_m3: "3 modulni tugatdi",
  finished_all: "Butun kursni tugatdi",
};

interface Stage { stage_order: number; stage_key: string; users: number; }

export default function AnalyticsFunnel() {
  const [rows, setRows] = useState<Stage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.rpc("analytics_funnel" as any);
      setRows((data as Stage[]) || []);
      setLoading(false);
    })();
  }, []);

  const total = rows[0]?.users || 0;
  const max = Math.max(1, ...rows.map((r) => Number(r.users)));

  return (
    <AnalyticsShell title="Konversiya voronkasi" subtitle="Har bir bosqichda nechta talaba qoladi.">
      <div className="flex justify-end no-print">
        <Button variant="outline" size="sm" onClick={() => exportCsv("funnel.csv", rows.map((r) => ({
          stage: LABELS[r.stage_key] || r.stage_key, users: r.users,
        })))}>
          <Download className="h-3.5 w-3.5" /> CSV
        </Button>
      </div>
      <Card className="p-5 shadow-soft">
        {loading ? (
          <p className="text-sm text-muted-foreground">Yuklanmoqda…</p>
        ) : (
          <div className="space-y-3">
            {rows.map((r, i) => {
              const prev = i === 0 ? r.users : Number(rows[i - 1].users);
              const dropPct = i === 0 ? 0 : Math.round((1 - Number(r.users) / Math.max(prev, 1)) * 100);
              const overallPct = total > 0 ? Math.round((Number(r.users) / total) * 100) : 0;
              const widthPct = (Number(r.users) / max) * 100;
              return (
                <div key={r.stage_key} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">{LABELS[r.stage_key] || r.stage_key}</span>
                    <span className="tabular-nums">
                      <span className="font-semibold">{r.users}</span>
                      <span className="text-muted-foreground"> · {overallPct}%</span>
                      {i > 0 && (
                        <span className={`ml-2 text-xs ${dropPct > 50 ? "text-destructive" : "text-muted-foreground"}`}>
                          (-{dropPct}%)
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="h-7 bg-muted rounded-md overflow-hidden">
                    <div className="h-full bg-primary/80 rounded-md" style={{ width: `${widthPct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </AnalyticsShell>
  );
}
