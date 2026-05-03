import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight } from "lucide-react";

interface ModuleAgg {
  module_id: string;
  module_title: string;
  course_title?: string;
  scored_tasks: number;
  total_active_tasks: number;
  avg_norm: number | null;
  tasks: { id: string; task_number: number; title: string; max_score: number; score: number | null; feedback: string | null }[];
}

export function HomeworkProfileSection() {
  const { user } = useAuth();
  const [mods, setMods] = useState<ModuleAgg[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [overall, setOverall] = useState<number | null>(null);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data: subs } = await supabase
        .from("homework_submissions")
        .select("id, assignment_id, score, score_feedback")
        .eq("user_id", user.id);
      const subMap = new Map((subs || []).map((s: any) => [s.assignment_id, s]));

      const { data: assigns } = await supabase
        .from("homework_assignments")
        .select("id, title, max_score, task_number, is_active, module_id, modules(id, title, course_id, courses(title))")
        .eq("is_active", true)
        .order("task_number");

      const byMod = new Map<string, ModuleAgg>();
      (assigns as any[] || []).forEach((a) => {
        const mid = a.module_id;
        if (!byMod.has(mid)) {
          byMod.set(mid, {
            module_id: mid,
            module_title: a.modules?.title || "—",
            course_title: a.modules?.courses?.title,
            scored_tasks: 0,
            total_active_tasks: 0,
            avg_norm: null,
            tasks: [],
          });
        }
        const agg = byMod.get(mid)!;
        agg.total_active_tasks++;
        const s = subMap.get(a.id) as any;
        agg.tasks.push({
          id: a.id, task_number: a.task_number, title: a.title, max_score: a.max_score,
          score: s?.score ?? null, feedback: s?.score_feedback ?? null,
        });
        if (s?.score != null) agg.scored_tasks++;
      });

      const list = Array.from(byMod.values()).map((m) => {
        const scored = m.tasks.filter((t) => t.score != null);
        m.avg_norm = scored.length
          ? +((scored.reduce((acc, t) => acc + Number(t.score) / t.max_score, 0) / scored.length) * 10).toFixed(1)
          : null;
        m.tasks.sort((a, b) => a.task_number - b.task_number);
        return m;
      });
      setMods(list);

      const withScores = list.filter((m) => m.avg_norm != null);
      setOverall(withScores.length ? +(withScores.reduce((a, m) => a + (m.avg_norm || 0), 0) / withScores.length).toFixed(1) : null);
    })();
  }, [user]);

  return (
    <Card className="p-5 space-y-3 shadow-soft">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">📝 Uy vazifalari</h2>
        {overall != null && <div className="text-sm">Umumiy o'rtacha: <span className="font-semibold">{overall}/10</span></div>}
      </div>
      {mods.length === 0 && <p className="text-sm text-muted-foreground">Hali topshiriqlar yo'q.</p>}
      <div className="space-y-2">
        {mods.map((m) => {
          const isOpen = !!open[m.module_id];
          return (
            <div key={m.module_id} className="border rounded-lg">
              <button type="button" onClick={() => setOpen((o) => ({ ...o, [m.module_id]: !o[m.module_id] }))}
                className="w-full flex items-center justify-between p-3 hover:bg-muted/30 text-left">
                <div className="min-w-0">
                  {m.course_title && <div className="text-xs text-muted-foreground">{m.course_title}</div>}
                  <div className="font-medium truncate">{m.module_title}</div>
                  <div className="text-xs text-muted-foreground">
                    {m.scored_tasks}/{m.total_active_tasks} baholangan
                    {m.avg_norm != null && ` · O'rtacha: ${m.avg_norm}/10`}
                  </div>
                </div>
                {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </button>
              {isOpen && (
                <div className="p-3 border-t space-y-2">
                  {m.tasks.map((t) => (
                    <div key={t.id} className="flex items-start gap-3 text-sm">
                      <Badge variant="outline">V{t.task_number}</Badge>
                      <div className="flex-1 min-w-0">
                        <div className="truncate">{t.title}</div>
                        {t.feedback && <div className="text-xs text-muted-foreground italic mt-0.5">"{t.feedback}"</div>}
                      </div>
                      <div className="text-xs tabular-nums">
                        {t.score != null ? <span className="font-semibold">{t.score}/{t.max_score}</span> : <span className="text-muted-foreground">—</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
