import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2, XCircle } from "lucide-react";
import { toast } from "sonner";

export default function QuizPage() {
  const { moduleId } = useParams();
  const { user } = useAuth();
  const nav = useNavigate();
  const { t } = useTranslation();
  const [questions, setQuestions] = useState<any[]>([]);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [submitted, setSubmitted] = useState(false);
  const [moduleTitle, setModuleTitle] = useState("");
  const [courseId, setCourseId] = useState<string | null>(null);
  const [gradeMap, setGradeMap] = useState<Record<string, { correct_index: number; explanation: string | null; is_correct: boolean }>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!moduleId) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    (async () => {
      try {
        const { data: m, error: mErr } = await supabase.from("modules").select("title, course_id").eq("id", moduleId).maybeSingle();
        if (mErr) throw mErr;
        if (cancelled) return;
        setModuleTitle(m?.title || ""); setCourseId(m?.course_id || null);
        const { data, error: qErr } = await supabase.rpc("get_quiz_questions_for_module" as any, { _module_id: moduleId });
        if (qErr) throw qErr;
        if (cancelled) return;
        setQuestions((data as any[]) || []);
      } catch (e) {
        if (cancelled) return;
        console.error("[QuizPage] load failed", e);
        setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [moduleId, reloadKey]);

  const submit = async () => {
    if (!user || !moduleId || submitting) return;
    setSubmitting(true);
    const { data, error } = await supabase.rpc("grade_quiz_attempt" as any, { _module_id: moduleId, _answers: answers as any });
    setSubmitting(false);
    if (error) { toast.error(error.message); return; }
    const res = (data as any) || {};
    const pct = Number(res.score || 0);
    const map: Record<string, any> = {};
    for (const q of (res.questions || [])) map[q.id] = q;
    setGradeMap(map);
    setSubmitted(true);
    if (pct >= 80) toast.success(t("quiz.passedWith", { pct }));
    else toast.error(t("quiz.needToPass", { pct }));
  };

  return (
    <PageShell>
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <Link to={courseId ? `/course/${courseId}` : "/dashboard"} className="text-xs text-muted-foreground hover:text-foreground">{t("quiz.back")}</Link>
          <h1 className="text-3xl font-semibold tracking-tight mt-2">{t("quiz.headerWith", { title: moduleTitle })}</h1>
          <p className="text-muted-foreground mt-1">{t("quiz.passLine")}</p>
        </div>
        {loading && (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => <Card key={i} className="p-5 h-32 animate-pulse bg-muted/40" />)}
          </div>
        )}
        {!loading && error && (
          <Card className="p-8 text-center">
            <p className="text-sm text-muted-foreground">Testni yuklab bo'lmadi.</p>
            <Button variant="outline" className="mt-3" onClick={() => setReloadKey((k) => k + 1)}>Qayta urinish</Button>
          </Card>
        )}
        {!loading && !error && questions.length === 0 && (
          <Card className="p-8 text-center text-sm text-muted-foreground">Bu modul uchun test yo'q</Card>
        )}
        {!loading && !error && questions.map((q, i) => (
          <Card key={q.id} className="p-5 shadow-soft space-y-3">
            <div className="font-medium" id={`q-${q.id}`}>{i + 1}. {q.question}</div>
            <div className="space-y-2" role="radiogroup" aria-labelledby={`q-${q.id}`}>
              {(q.options as string[]).map((opt, oi) => {
                const selected = answers[q.id] === oi;
                const g = gradeMap[q.id];
                const correct = submitted && g && g.correct_index === oi;
                const wrong = submitted && selected && !correct;
                return (
                  <button key={oi} type="button" role="radio" aria-checked={selected} disabled={submitted}
                    onClick={() => !submitted && setAnswers({ ...answers, [q.id]: oi })}
                    className={`w-full text-left text-sm px-3 py-2.5 rounded-md border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
                      submitted ? (correct ? "border-foreground bg-muted" : wrong ? "border-destructive/40 bg-destructive/5" : "border-border")
                      : selected ? "border-foreground bg-muted" : "border-border hover:bg-muted/40"
                    }`}>
                    <span className="flex items-center gap-2">
                      {submitted && correct && <CheckCircle2 className="h-4 w-4" />}
                      {submitted && wrong && <XCircle className="h-4 w-4 text-destructive" />}
                      {opt}
                    </span>
                  </button>
                );
              })}
            </div>
            {submitted && gradeMap[q.id]?.explanation && <p className="text-xs text-muted-foreground pt-1">{gradeMap[q.id]?.explanation}</p>}
          </Card>
        ))}
        {!loading && !error && questions.length > 0 && (
        <div className="flex gap-3">
          {!submitted ? (
            <Button onClick={submit} disabled={submitting || Object.keys(answers).length < questions.length}>{submitting ? "…" : t("quiz.submitAnswers")}</Button>
          ) : (
            <>
              <Button onClick={() => { setAnswers({}); setSubmitted(false); setGradeMap({}); }}>{t("quiz.tryAgain")}</Button>
              {courseId && <Button variant="outline" onClick={() => nav(`/course/${courseId}`)}>{t("quiz.backToCourse")}</Button>}
            </>
          )}
        </div>
        )}
      </div>
    </PageShell>
  );
}
