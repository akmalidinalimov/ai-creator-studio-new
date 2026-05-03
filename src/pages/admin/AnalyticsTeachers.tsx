import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AnalyticsShell } from "@/components/admin/AnalyticsShell";

interface Row {
  teacher_id: string; teacher_name: string; teacher_email: string;
  students_count: number; active_7d_pct: number; avg_completion_pct: number;
  avg_homework_score: number; finished_course: number; quality_score: number;
}

function scoreColor(s: number): string {
  if (s >= 70) return "text-emerald-600";
  if (s >= 50) return "text-amber-600";
  return "text-rose-600";
}

export default function AnalyticsTeachers() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [minStudents, setMinStudents] = useState(5);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data } = await supabase.rpc("analytics_teacher_quality" as any, { _min_students: minStudents });
      setRows((data as Row[]) || []);
      setLoading(false);
    })();
  }, [minStudents]);

  return (
    <AnalyticsShell title="O'qituvchilar sifati" subtitle="Composite quality score — barcha guruhlar bo'yicha.">
      <Card className="p-4 shadow-soft no-print">
        <Label className="text-xs">Minimal talabalar soni</Label>
        <Input
          type="number" min={1} max={500} className="w-32 mt-1"
          value={minStudents} onChange={(e) => setMinStudents(parseInt(e.target.value) || 1)}
        />
      </Card>
      <Card className="p-0 shadow-soft overflow-hidden">
        {loading ? (
          <p className="p-5 text-sm text-muted-foreground">Yuklanmoqda…</p>
        ) : rows.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">Bu shartga mos o'qituvchilar yo'q.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">O'qituvchi</th>
                  <th className="text-right px-4 py-2 font-medium">Talabalar</th>
                  <th className="text-right px-4 py-2 font-medium">Faol 7k</th>
                  <th className="text-right px-4 py-2 font-medium">Avg tugatish</th>
                  <th className="text-right px-4 py-2 font-medium">Avg vazifa</th>
                  <th className="text-right px-4 py-2 font-medium">Tugatdi</th>
                  <th className="text-right px-4 py-2 font-medium">Sifat</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.teacher_id} className="border-t">
                    <td className="px-4 py-2">
                      <div className="font-medium">{r.teacher_name}</div>
                      <div className="text-xs text-muted-foreground">{r.teacher_email}</div>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.students_count}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.active_7d_pct}%</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.avg_completion_pct}%</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.avg_homework_score}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.finished_course}</td>
                    <td className={`px-4 py-2 text-right tabular-nums font-bold ${scoreColor(Number(r.quality_score))}`}>
                      {r.quality_score}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </AnalyticsShell>
  );
}
