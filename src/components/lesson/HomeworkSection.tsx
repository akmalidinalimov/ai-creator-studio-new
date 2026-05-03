import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ExternalLink } from "lucide-react";

interface Props { lessonId: string }
interface Assignment {
  id: string; title: string; description: string | null;
  prompt_uz: string | null; prompt_ru: string | null; prompt_en: string | null;
  max_score: number; task_number: number; is_active: boolean;
}
interface Submission {
  id: string; assignment_id: string;
  score: number | null; score_feedback: string | null;
}

export function HomeworkSection({ lessonId }: Props) {
  const { user } = useAuth();
  const { i18n } = useTranslation();
  const [isLast, setIsLast] = useState(false);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [subsByAssign, setSubsByAssign] = useState<Record<string, Submission>>({});
  const [groupId, setGroupId] = useState<string | null>(null);
  const [topicUrl, setTopicUrl] = useState<string | null>(null);
  const [moduleNum, setModuleNum] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      if (!user || !lessonId) return;
      const { data: l } = await supabase.from("lessons").select("module_id, position").eq("id", lessonId).maybeSingle();
      if (!l) return;
      const { data: siblings } = await supabase.from("lessons").select("position").eq("module_id", l.module_id).eq("published", true).order("position", { ascending: false }).limit(1);
      const lastPos = siblings?.[0]?.position;
      if (lastPos !== l.position) { setIsLast(false); return; }
      setIsLast(true);

      const { data: mod } = await supabase.from("modules").select("position").eq("id", l.module_id).maybeSingle();
      setModuleNum((mod?.position ?? 0) + 1);

      const { data: as } = await supabase
        .from("homework_assignments").select("*")
        .eq("module_id", l.module_id).eq("is_active", true).order("task_number");
      const list = (as as any[] || []) as Assignment[];
      setAssignments(list);

      if (list.length) {
        const { data: ss } = await supabase
          .from("homework_submissions").select("id, assignment_id, score, score_feedback")
          .eq("user_id", user.id).in("assignment_id", list.map((a) => a.id));
        const m: Record<string, Submission> = {};
        (ss as any[] || []).forEach((s) => { m[s.assignment_id] = s as Submission; });
        setSubsByAssign(m);
      }

      const { data: prof } = await supabase.from("profiles").select("group_id").eq("id", user.id).maybeSingle();
      const gid = prof?.group_id || null;
      setGroupId(gid);
      if (gid) {
        const { data: gmt } = await supabase
          .from("group_module_topics" as any)
          .select("telegram_topic_url")
          .eq("group_id", gid).eq("module_id", l.module_id).maybeSingle();
        setTopicUrl((gmt as any)?.telegram_topic_url || null);
      }
    })();
  }, [user, lessonId]);

  if (!isLast || assignments.length === 0) return null;

  const lng = (i18n.language || "uz").slice(0, 2);
  const promptOf = (a: Assignment) =>
    (lng === "ru" ? a.prompt_ru : lng === "en" ? a.prompt_en : a.prompt_uz) || a.description || "";

  const scored = assignments.filter((a) => subsByAssign[a.id]?.score != null);
  const moduleAvg = scored.length
    ? +(
        (scored.reduce((acc, a) => acc + Number(subsByAssign[a.id].score) / a.max_score, 0) / scored.length) * 10
      ).toFixed(1)
    : null;

  return (
    <Card className="p-5 space-y-4 shadow-soft">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="font-semibold text-lg">📝 Modul vazifalari</h2>
        <div className="text-xs text-muted-foreground">
          {scored.length}/{assignments.length} baholangan
          {moduleAvg != null && ` · O'rtacha: ${moduleAvg}/10`}
        </div>
      </div>

      {!groupId && (
        <div className="text-sm rounded-md bg-amber-500/10 text-amber-900 dark:text-amber-200 p-3">
          Sizning guruhingiz biriktirilmagan. Ustozingiz bilan bog'laning.
        </div>
      )}
      {groupId && !topicUrl && (
        <div className="text-sm rounded-md bg-amber-500/10 text-amber-900 dark:text-amber-200 p-3">
          Topshirish manzili sozlanmagan. Ustozingiz bilan bog'laning.
        </div>
      )}

      {assignments.map((a) => {
        const s = subsByAssign[a.id];
        return (
          <div key={a.id} className="border rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge>V{a.task_number}</Badge>
              <span className="font-medium">{a.title}</span>
              <span className="ml-auto text-xs text-muted-foreground">Max: {a.max_score} ball</span>
            </div>
            {promptOf(a) && (
              <div className="text-sm text-muted-foreground whitespace-pre-wrap">{promptOf(a)}</div>
            )}
            <div className="text-sm">
              📲 Vazifani guruhdagi topikka topshiring:
            </div>
            {topicUrl ? (
              <Button asChild variant="outline" className="w-full sm:w-auto">
                <a href={topicUrl} target="_blank" rel="noopener noreferrer">
                  📌 Modul {moduleNum ?? ""} topikga o'tish
                  <ExternalLink className="h-4 w-4 ml-1" />
                </a>
              </Button>
            ) : null}
            <div className="text-xs text-muted-foreground">
              Ustoz baholaganidan keyin natija bu yerda ko'rinadi.
            </div>
            <div className="border-t pt-3">
              <div className="text-xs font-semibold text-muted-foreground mb-1">Sizning natijangiz</div>
              {s?.score != null ? (
                <div className="space-y-1">
                  <Badge className="bg-green-600 text-white">✅ {s.score}/{a.max_score}</Badge>
                  {s.score_feedback && (
                    <div className="text-sm whitespace-pre-wrap mt-1">"{s.score_feedback}"</div>
                  )}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">⏳ Hali baholanmagan</div>
              )}
            </div>
          </div>
        );
      })}
    </Card>
  );
}
