import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AnalyticsShell } from "@/components/admin/AnalyticsShell";

interface Row {
  lesson_id: string; lesson_title: string; module_title: string;
  starts: number; completes: number; completion_rate: number; histogram: Record<string, number>;
}

function colorFor(pct: number): string {
  if (pct >= 80) return "text-emerald-600";
  if (pct >= 60) return "text-amber-600";
  return "text-rose-600";
}

export default function AnalyticsLessons() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [drill, setDrill] = useState<Row | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.rpc("analytics_lesson_dropoff" as any);
      setRows((data as Row[]) || []);
      setLoading(false);
    })();
  }, []);

  const buckets = drill ? Array.from({ length: 10 }, (_, i) => Number(drill.histogram?.[String(i)] || 0)) : [];
  const maxBucket = Math.max(1, ...buckets);

  return (
    <AnalyticsShell title="Darslar dropoff" subtitle="Eng yomon tugatish foizidan boshlab.">
      <Card className="p-0 shadow-soft overflow-hidden">
        {loading ? (
          <p className="p-5 text-sm text-muted-foreground">Yuklanmoqda…</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Dars</th>
                <th className="text-left px-4 py-2 font-medium hidden sm:table-cell">Modul</th>
                <th className="text-right px-4 py-2 font-medium">Boshlandi</th>
                <th className="text-right px-4 py-2 font-medium">Tugatildi</th>
                <th className="text-right px-4 py-2 font-medium">Tugatish %</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.lesson_id} className="border-t cursor-pointer hover:bg-muted/30" onClick={() => setDrill(r)}>
                  <td className="px-4 py-2">{r.lesson_title}</td>
                  <td className="px-4 py-2 text-muted-foreground hidden sm:table-cell">{r.module_title}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{r.starts}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{r.completes}</td>
                  <td className={`px-4 py-2 text-right tabular-nums font-semibold ${colorFor(Number(r.completion_rate))}`}>
                    {r.completion_rate}%
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">Dars ma'lumoti yo'q.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </Card>

      <Dialog open={!!drill} onOpenChange={(o) => !o && setDrill(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{drill?.lesson_title}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">Talabalar qaysi nuqtada to'xtagan (10% bucket).</p>
          <div className="space-y-1.5 mt-2">
            {buckets.map((c, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <span className="w-16 tabular-nums text-muted-foreground">{i * 10}–{(i + 1) * 10}%</span>
                <div className="flex-1 h-5 bg-muted rounded">
                  <div className="h-full bg-primary/70 rounded" style={{ width: `${(c / maxBucket) * 100}%` }} />
                </div>
                <span className="w-10 text-right tabular-nums">{c}</span>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </AnalyticsShell>
  );
}
