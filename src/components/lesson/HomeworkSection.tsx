import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ExternalLink } from "lucide-react";
import { effectiveLeafGrades, summarizeHomework } from "@/lib/homeworkStats";

interface Props { lessonId: string }
interface Assignment {
  id: string; title: string; description: string | null;
  prompt_uz: string | null; prompt_ru: string | null; prompt_en: string | null;
  max_score: number; task_number: number; is_active: boolean;
  parent_id: string | null; sap_number: number | null;
}
interface Submission {
  id: string; assignment_id: string;
  score: number | null; score_feedback: string | null;
  previous_attempts: any[] | null;
}

export function HomeworkSection({ lessonId }: Props) {
  const { user } = useAuth();
  const { i18n } = useTranslation();
  const [isLast, setIsLast] = useState(false);
  const [parents, setParents] = useState<Assignment[]>([]);
  const [sapsByParent, setSapsByParent] = useState<Record<string, Assignment[]>>({});
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
        .eq("module_id", l.module_id).eq("is_active", true)
        .order("task_number").order("sap_number", { nullsFirst: true });
      const all = (as as any[] || []) as Assignment[];
      const ps = all.filter(a => !a.parent_id).sort((a, b) => a.task_number - b.task_number);
      const sapMap: Record<string, Assignment[]> = {};
      all.filter(a => !!a.parent_id).forEach(s => {
        (sapMap[s.parent_id!] ||= []).push(s);
      });
      Object.values(sapMap).forEach(arr => arr.sort((a, b) => (a.sap_number || 0) - (b.sap_number || 0)));
      setParents(ps);
      setSapsByParent(sapMap);

      // Submissions are keyed off whichever id (parent without SAPs OR each SAP) is active.
      const ids: string[] = [];
      ps.forEach(p => {
        const saps = sapMap[p.id] || [];
        if (saps.length) saps.forEach(s => ids.push(s.id));
        else ids.push(p.id);
      });
      if (ids.length) {
        const { data: ss } = await supabase
          .from("homework_submissions").select("id, assignment_id, score, score_feedback, previous_attempts")
          .eq("user_id", user.id).in("assignment_id", ids);
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
        let url = (gmt as any)?.telegram_topic_url || null;
        if (!url) {
          const { data: gr } = await supabase
            .from("groups").select("homework_topic_url")
            .eq("id", gid).maybeSingle();
          url = (gr as any)?.homework_topic_url || null;
        }
        setTopicUrl(url);
      }
    })();
  }, [user, lessonId]);

  if (!isLast || parents.length === 0) return null;

  const lng = (i18n.language || "uz").slice(0, 2);
  const promptOf = (a: Assignment) =>
    (lng === "ru" ? a.prompt_ru : lng === "en" ? a.prompt_en : a.prompt_uz) || a.description || "";

  // Build leaves (each parent without saps OR each sap)
  const leaves: { leaf: Assignment; parent: Assignment }[] = [];
  parents.forEach(p => {
    const saps = sapsByParent[p.id] || [];
    if (saps.length) saps.forEach(s => leaves.push({ leaf: s, parent: p }));
    else leaves.push({ leaf: p, parent: p });
  });

  // Effective per-leaf grades: resubmitted-but-currently-null scores fall back to the
  // last scored attempt (mirrors HomeworkProfileSection.tsx).
  const effRows = effectiveLeafGrades(
    leaves.map(({ leaf }) => ({ id: leaf.id, max_score: leaf.max_score })),
    Object.values(subsByAssign).map((s) => ({
      assignment_id: s.assignment_id,
      score: s.score,
      score_feedback: s.score_feedback,
      previous_attempts: s.previous_attempts,
    })),
  );
  const effByLeaf = new Map(effRows.map((r) => [r.assignment_id, r]));
  const summary = summarizeHomework(effRows);
  const scoredLeaves = leaves.filter(({ leaf }) => effByLeaf.get(leaf.id)?.effective_score != null);
  const totalScore = summary.earned;
  // Denominator spans ALL leaves' max_score, not just scored ones (15/30, not 15/20).
  const totalMax = summary.maxTotal;

  const renderLeaf = (leaf: Assignment, parent: Assignment) => {
    const s = subsByAssign[leaf.id];
    const eff = effByLeaf.get(leaf.id);
    const effScore = eff?.effective_score ?? null;
    const effFeedback = eff?.effective_feedback ?? null;
    const isSap = !!leaf.parent_id;
    const label = isSap ? `V${parent.task_number}.S${leaf.sap_number}` : `V${parent.task_number}`;
    return (
      <div key={leaf.id} className="border rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge>{label}</Badge>
          <span className="font-medium">{leaf.title}</span>
          <span className="ml-auto text-xs text-muted-foreground">Max: {leaf.max_score} ball</span>
        </div>
        {promptOf(leaf) && (
          <div className="text-sm text-muted-foreground whitespace-pre-wrap">{promptOf(leaf)}</div>
        )}
        <div className="text-sm">📲 Vazifani guruhdagi topikka topshiring:</div>
        {topicUrl ? (
          <Button asChild variant="outline" className="w-full sm:w-auto">
            <a href={topicUrl} target="_blank" rel="noopener noreferrer">
              📌 Modul {moduleNum ?? ""} topikga o'tish
              <ExternalLink className="h-4 w-4 ml-1" />
            </a>
          </Button>
        ) : null}
        <div className="border-t pt-3">
          <div className="text-xs font-semibold text-muted-foreground mb-1">Sizning natijangiz</div>
          {/* Resubmitted: live score is null but a previous attempt was scored.
              Show a distinct "awaiting re-grade" state (the old score, no green
              tick, no resubmit button) instead of the previous grade as current. */}
          {effScore != null && (s?.score == null) ? (
            <div className="space-y-1">
              <Badge className="bg-amber-500 text-white">🔄 Qayta topshirildi — yangi baholashni kuting</Badge>
              <div className="text-xs text-muted-foreground">Oldingi natija: {effScore}/{leaf.max_score}</div>
            </div>
          ) : effScore != null ? (
            <div className="space-y-2">
              <Badge className="bg-green-600 text-white">✅ {effScore}/{leaf.max_score}</Badge>
              {effFeedback && (
                <div className="text-sm whitespace-pre-wrap mt-1">"{effFeedback}"</div>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  const ok = window.confirm("Vazifani qayta topshirmoqchimisiz? Oldingi natija arxivlanadi.");
                  if (!ok) return;
                  const { error } = await supabase.rpc("start_homework_resubmission", { p_submission_id: s.id });
                  if (error) { alert(error.message); return; }
                  setSubsByAssign((prev) => {
                    const m = { ...prev };
                    delete m[leaf.id];
                    return m;
                  });
                  if (topicUrl) window.open(topicUrl, "_blank", "noopener,noreferrer");
                }}
              >
                🔁 Qayta topshirish
              </Button>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">⏳ Hali baholanmagan</div>
          )}
        </div>
      </div>
    );
  };

  return (
    <Card className="p-5 space-y-4 shadow-soft">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="font-semibold text-lg">📝 Modul vazifalari</h2>
        <div className="text-xs text-muted-foreground">
          {scoredLeaves.length}/{leaves.length} baholangan
          {totalMax > 0 && ` · Jami: ${totalScore}/${totalMax}`}
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

      {parents.map((p) => {
        const saps = sapsByParent[p.id] || [];
        if (saps.length === 0) return renderLeaf(p, p);
        // Parent with SAPs: header + nested SAPs
        const sapScored = saps.filter(s => effByLeaf.get(s.id)?.effective_score != null);
        const pScore = sapScored.reduce((acc, s) => acc + Number(effByLeaf.get(s.id)!.effective_score), 0);
        const pMax = saps.reduce((acc, s) => acc + s.max_score, 0);
        return (
          <div key={p.id} className="space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="secondary">V{p.task_number}</Badge>
              <span className="font-semibold">{p.title}</span>
              <span className="ml-auto text-xs text-muted-foreground">
                {sapScored.length}/{saps.length} · {pMax > 0 ? `${pScore}/${pMax}` : "—"}
              </span>
            </div>
            <div className="pl-3 border-l-2 space-y-3">
              {saps.map(s => renderLeaf(s, p))}
            </div>
          </div>
        );
      })}
    </Card>
  );
}
