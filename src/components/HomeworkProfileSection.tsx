import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  effectiveLeafGrades,
  summarizeHomework,
  leavesFromAssignments,
  type LeafEffective,
} from "@/lib/homeworkStats";
import { FeedbackVoicePlayer } from "@/components/homework/FeedbackVoicePlayer";

interface ModuleAgg {
  module_id: string;
  module_title: string;
  course_title?: string;
  scored_tasks: number;
  total_active_tasks: number;
  earned: number;
  max_scored: number;
  tasks: {
    id: string;
    task_number: number;
    sap_number: number | null;
    title: string;
    max_score: number;
    score: number | null;
    feedback: string | null;
    is_stale: boolean;
    // Voice feedback (2026-08-20 voice-homework-feedback, Task 5): submissionId is the LIVE
    // submission row's id (not the assignment id) — FeedbackVoicePlayer resolves audio by
    // submission_id. hasVoice mirrors `feedback` in reading straight off the live row
    // (resubmission doesn't clear score_feedback_voice_path — TeacherProfile.tsx precedent),
    // not through the effective/previous_attempts fallback.
    submissionId: string | null;
    hasVoice: boolean;
  }[];
}

export function HomeworkProfileSection() {
  const { user } = useAuth();
  const [mods, setMods] = useState<ModuleAgg[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [overall, setOverall] = useState<{ submitted: number; total: number; scored: number; earned: number; maxTotal: number } | null>(null);

  useEffect(() => {
    if (!user) return;
    (async () => {
      // Resolve student's course scope (group → course, else enrollments).
      let courseIds: string[] = [];
      const { data: prof } = await supabase.from("profiles").select("group_id").eq("id", user.id).maybeSingle();
      if (prof?.group_id) {
        const { data: g } = await supabase.from("groups").select("course_id").eq("id", prof.group_id).maybeSingle();
        if (g?.course_id) courseIds = [g.course_id];
      }
      if (!courseIds.length) {
        const { data: enr } = await supabase.from("enrollments").select("course_id").eq("user_id", user.id);
        courseIds = Array.from(new Set((enr || []).map((r: any) => r.course_id).filter(Boolean)));
      }

      const { data: subs } = await supabase
        .from("homework_submissions")
        .select(
          "id, assignment_id, score, score_feedback, score_feedback_voice_path, score_feedback_voice_file_id, scored_at, score_is_stale, previous_attempts",
        )
        .eq("user_id", user.id);

      let assignsQuery = supabase
        .from("homework_assignments")
        .select("id, title, max_score, task_number, sap_number, parent_id, is_active, module_id, modules!inner(id, title, course_id, courses(title))")
        .eq("is_active", true)
        .order("task_number");
      if (courseIds.length) assignsQuery = assignsQuery.in("modules.course_id", courseIds);
      const { data: assigns } = await assignsQuery;

      const all = (assigns as any[]) || [];
      const leafIds = new Set(leavesFromAssignments(all).map((a) => a.id));

      const byMod = new Map<string, ModuleAgg>();
      const allEff: LeafEffective[] = [];
      for (const a of all) {
        if (!leafIds.has(a.id)) continue; // only leaves count toward stats
        const mid = a.module_id;
        if (!byMod.has(mid)) {
          byMod.set(mid, {
            module_id: mid,
            module_title: a.modules?.title || "—",
            course_title: a.modules?.courses?.title,
            scored_tasks: 0,
            total_active_tasks: 0,
            earned: 0,
            max_scored: 0,
            tasks: [],
          });
        }
        const agg = byMod.get(mid)!;
        agg.total_active_tasks++;
        const eff = effectiveLeafGrades(
          [{ id: a.id, max_score: a.max_score }],
          (subs as any[]) || [],
        )[0];
        allEff.push(eff);
        const liveSub: any = (subs || []).find((s: any) => s.assignment_id === a.id);
        agg.tasks.push({
          id: a.id,
          task_number: a.task_number,
          sap_number: a.sap_number,
          title: a.title,
          max_score: a.max_score,
          score: eff.effective_score,
          feedback: eff.effective_feedback,
          is_stale: !!liveSub?.score_is_stale,
          submissionId: liveSub?.id ?? null,
          hasVoice: !!(liveSub?.score_feedback_voice_path || liveSub?.score_feedback_voice_file_id),
        });
        if (eff.effective_score != null) {
          agg.scored_tasks++;
          agg.earned += eff.effective_score;
          agg.max_scored += a.max_score;
        }
      }

      const list = Array.from(byMod.values()).map((m) => {
        m.tasks.sort((a, b) => a.task_number - b.task_number || (a.sap_number ?? 0) - (b.sap_number ?? 0));
        return m;
      });
      setMods(list);

      const summary = summarizeHomework(allEff);
      setOverall({
        submitted: summary.submittedCount,
        total: summary.totalLeaves,
        scored: summary.scoredCount,
        earned: summary.earned,
        maxTotal: summary.maxTotal,
      });
    })();
  }, [user]);

  return (
    <Card className="p-5 space-y-3 shadow-soft">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <h2 className="font-semibold">📝 Uy vazifalari</h2>
        {overall && overall.total > 0 && (
          <div className="text-sm text-right">
            <div>
              Topshirildi: <span className="font-semibold">{overall.submitted}/{overall.total}</span>
              {overall.scored > 0 && <span className="text-muted-foreground"> · {overall.scored} baholandi</span>}
            </div>
            {overall.maxTotal > 0 && (
              <div>
                Ball: <span className="font-semibold">{overall.earned}/{overall.maxTotal}</span>
              </div>
            )}
          </div>
        )}
      </div>
      {mods.length === 0 && <p className="text-sm text-muted-foreground">Hali topshiriqlar yo'q.</p>}
      <div className="space-y-2">
        {mods.map((m) => {
          const isOpen = !!open[m.module_id];
          const avg = m.max_scored > 0 ? +((m.earned / m.max_scored) * 10).toFixed(1) : null;
          return (
            <div key={m.module_id} className="border rounded-lg">
              <button type="button" onClick={() => setOpen((o) => ({ ...o, [m.module_id]: !o[m.module_id] }))}
                className="w-full flex items-center justify-between p-3 hover:bg-muted/30 text-left">
                <div className="min-w-0">
                  {m.course_title && <div className="text-xs text-muted-foreground">{m.course_title}</div>}
                  <div className="font-medium truncate">{m.module_title}</div>
                  <div className="text-xs text-muted-foreground">
                    {m.scored_tasks}/{m.total_active_tasks} baholangan
                    {avg != null && ` · O'rtacha ${avg}/10`}
                  </div>
                </div>
                {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </button>
              {isOpen && (
                <div className="p-3 border-t space-y-2">
                  {m.tasks.map((t) => (
                    <div key={t.id} className="flex items-start gap-3 text-sm">
                      <Badge variant="outline">
                        V{t.task_number}{t.sap_number ? `.${t.sap_number}` : ""}
                      </Badge>
                      <div className="flex-1 min-w-0">
                        <div className="truncate">{t.title}</div>
                        {t.feedback && <div className="text-xs text-muted-foreground italic mt-0.5">"{t.feedback}"</div>}
                        {t.hasVoice && t.submissionId && (
                          <div className="mt-1 min-w-0">
                            <FeedbackVoicePlayer submissionId={t.submissionId} />
                          </div>
                        )}
                        {t.is_stale && t.score != null && (
                          <div className="text-[10px] text-amber-600 mt-0.5">Qayta yuborilgan — yangi baholashni kuting</div>
                        )}
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
