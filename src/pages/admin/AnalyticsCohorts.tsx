import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { AnalyticsShell } from "@/components/admin/AnalyticsShell";

interface Row { cohort_week: string; week_offset: number; active_users: number; cohort_size: number; retention_pct: number; }

function bgFor(pct: number | null): string {
  if (pct === null) return "bg-muted/30";
  if (pct >= 40) return "bg-emerald-500/70 text-white";
  if (pct >= 20) return "bg-amber-400/70 text-foreground";
  return "bg-rose-500/70 text-white";
}

export default function AnalyticsCohorts() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.rpc("analytics_cohorts" as any);
      setRows((data as Row[]) || []);
      setLoading(false);
    })();
  }, []);

  const { weeks, matrix, sizeByWeek, maxOffset } = useMemo(() => {
    const map = new Map<string, Map<number, number>>();
    const sizes = new Map<string, number>();
    let maxOff = 0;
    rows.forEach((r) => {
      if (!map.has(r.cohort_week)) map.set(r.cohort_week, new Map());
      map.get(r.cohort_week)!.set(r.week_offset, Number(r.retention_pct));
      sizes.set(r.cohort_week, Number(r.cohort_size));
      if (r.week_offset > maxOff) maxOff = r.week_offset;
    });
    const ws = Array.from(map.keys()).sort().reverse();
    return { weeks: ws, matrix: map, sizeByWeek: sizes, maxOffset: Math.max(maxOff, 4) };
  }, [rows]);

  return (
    <AnalyticsShell title="Kohortalar saqlanishi" subtitle="Ro'yxatdan o'tgan haftaga ko'ra retention foizi.">
      <Card className="p-5 shadow-soft overflow-x-auto">
        {loading ? (
          <p className="text-sm text-muted-foreground">Yuklanmoqda…</p>
        ) : weeks.length === 0 ? (
          <p className="text-sm text-muted-foreground">Hali ma'lumot yo'q.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground">
                <th className="text-left p-2 font-medium">Kohorta</th>
                <th className="text-right p-2 font-medium">Hajm</th>
                {Array.from({ length: maxOffset + 1 }, (_, i) => (
                  <th key={i} className="p-2 font-medium text-center">W{i}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeks.map((w) => (
                <tr key={w} className="border-t">
                  <td className="p-2 whitespace-nowrap">{w}</td>
                  <td className="p-2 text-right tabular-nums">{sizeByWeek.get(w)}</td>
                  {Array.from({ length: maxOffset + 1 }, (_, i) => {
                    const v = matrix.get(w)?.get(i);
                    return (
                      <td key={i} className="p-1">
                        <div className={`rounded text-center py-1.5 tabular-nums ${bgFor(v ?? null)}`}>
                          {v !== undefined ? `${v}%` : "—"}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <div className="flex gap-3 text-xs text-muted-foreground no-print">
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-emerald-500/70" /> ≥40%</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-amber-400/70" /> 20–39%</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-rose-500/70" /> &lt;20%</span>
      </div>
    </AnalyticsShell>
  );
}
