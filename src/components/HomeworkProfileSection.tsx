import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface Row {
  id: string; assignment_id: string; submitted_at: string;
  score: number | null; is_late: boolean;
  module_id: string; assignment_title: string; max_score: number;
  course_id: string; lesson_id: string | null;
}

export function HomeworkProfileSection() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data: subs } = await supabase
        .from("homework_submissions")
        .select("id, assignment_id, submitted_at, score, is_late")
        .eq("user_id", user.id);
      if (!subs || !subs.length) { setRows([]); return; }
      const aIds = subs.map((s: any) => s.assignment_id);
      const { data: assigns } = await supabase
        .from("homework_assignments")
        .select("id, title, max_score, module_id, modules(course_id, lessons(id, position))")
        .in("id", aIds);
      const aMap = new Map((assigns || []).map((a: any) => {
        const lastLesson = (a.modules?.lessons || []).sort((x: any, y: any) => y.position - x.position)[0];
        return [a.id, { ...a, course_id: a.modules?.course_id, lesson_id: lastLesson?.id }];
      }));
      setRows(subs.map((s: any) => {
        const a: any = aMap.get(s.assignment_id) || {};
        return { ...s, assignment_title: a.title || "", max_score: a.max_score || 10, module_id: a.module_id, course_id: a.course_id, lesson_id: a.lesson_id };
      }));
    })();
  }, [user]);

  const scored = rows.filter(r => r.score != null);
  const avg = scored.length ? scored.reduce((s, r) => s + (r.score || 0), 0) / scored.length : null;

  return (
    <Card className="p-5 space-y-3 shadow-soft">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">📝 Uy vazifalari</h2>
        {avg != null && <div className="text-sm">O'rtacha baho: <span className="font-semibold">{avg.toFixed(1)} / 10</span></div>}
      </div>
      {rows.length === 0 && <p className="text-sm text-muted-foreground">Hali topshiriqlar yo'q.</p>}
      {rows.length > 0 && (
        <div className="overflow-x-auto -mx-5">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="text-left px-5 py-2 font-medium">Vazifa</th>
                <th className="text-left px-5 py-2 font-medium">Topshirilgan</th>
                <th className="text-right px-5 py-2 font-medium">Baho</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="px-5 py-2.5">{r.assignment_title}</td>
                  <td className="px-5 py-2.5 text-xs">
                    {new Date(r.submitted_at).toLocaleDateString()}
                    {r.is_late && <Badge variant="destructive" className="ml-2">Kech</Badge>}
                  </td>
                  <td className="px-5 py-2.5 text-right tabular-nums">
                    {r.score != null ? <span className="font-semibold">{r.score}/{r.max_score}</span> : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    {r.course_id && r.lesson_id && (
                      <Link to={`/lesson/${r.course_id}/${r.lesson_id}`} className="text-primary text-xs hover:underline">Ko'rish</Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
