import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";

interface Row {
  group_id: string; group_name: string; course_name: string | null; teacher_name: string;
  students: number; active_7d: number; submissions_total: number; pending: number;
  graded_pct: number; median_wait_days: number | null; avg_score: number | null;
}

/** A1: all-groups homework health — "which group is falling behind?" in one screen. */
export default function AdminHomeworkHealth() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.rpc("admin_homework_health" as any).then(({ data, error }) => {
      if (error) console.error("[HomeworkHealth]", error);
      setRows(((data as any) || []) as Row[]);
      setLoading(false);
    });
  }, []);

  // Health: red = pending piling up or slow grading; amber = watch; green = fine.
  const health = (r: Row) => {
    if (r.pending >= 5 || (r.median_wait_days ?? 0) >= 3) return "red";
    if (r.pending > 0 || (r.median_wait_days ?? 0) >= 1.5 || (r.students > 0 && r.active_7d / r.students < 0.3)) return "amber";
    return "green";
  };
  const dot: Record<string, string> = { red: "bg-red-500", amber: "bg-amber-500", green: "bg-emerald-500" };

  return (
    <PageShell>
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">📝 Vazifalar salomatligi</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Barcha guruhlar bir ekranda — qizil/sariq qatorlar e'tibor talab qiladi (kutilayotgan vazifalar, sekin baholash yoki past faollik).
          </p>
        </div>
        <Card className="overflow-x-auto shadow-soft">
          <table className="w-full text-sm min-w-[760px]">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">Guruh</th>
                <th className="text-left px-4 py-2.5 font-medium">Ustoz</th>
                <th className="text-right px-4 py-2.5 font-medium">Talaba</th>
                <th className="text-right px-4 py-2.5 font-medium">Faol 7k</th>
                <th className="text-right px-4 py-2.5 font-medium">Topshirilgan</th>
                <th className="text-right px-4 py-2.5 font-medium">Kutmoqda</th>
                <th className="text-right px-4 py-2.5 font-medium">Baholangan</th>
                <th className="text-right px-4 py-2.5 font-medium" title="Median baholash vaqti">⏱ kun</th>
                <th className="text-right px-4 py-2.5 font-medium">O'rt. ball</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={9} className="px-4 py-6 text-center text-muted-foreground">Yuklanmoqda…</td></tr>}
              {!loading && rows.map((r) => {
                const h = health(r);
                return (
                  <tr key={r.group_id} className={`border-t ${h === "red" ? "bg-red-500/5" : h === "amber" ? "bg-amber-500/5" : ""}`}>
                    <td className="px-4 py-2.5">
                      <span className={`inline-block h-2 w-2 rounded-full ${dot[h]} mr-2 align-middle`} />
                      <b>{r.group_name}</b>
                      <span className="text-xs text-muted-foreground"> · {(r.course_name || "").replace(/AI CREATORS\s*/i, "")}</span>
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">{r.teacher_name}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{r.students}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{r.active_7d}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{r.submissions_total}</td>
                    <td className={`px-4 py-2.5 text-right tabular-nums font-semibold ${r.pending > 0 ? "text-amber-600" : ""}`}>{r.pending}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{r.graded_pct}%</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{r.median_wait_days ?? "—"}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{r.avg_score ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      </div>
    </PageShell>
  );
}
