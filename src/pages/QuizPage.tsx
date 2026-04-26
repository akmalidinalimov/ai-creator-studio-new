import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
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
  const [questions, setQuestions] = useState<any[]>([]);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [submitted, setSubmitted] = useState(false);
  const [moduleTitle, setModuleTitle] = useState("");
  const [courseId, setCourseId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      if (!moduleId) return;
      const { data: m } = await supabase.from("modules").select("title, course_id").eq("id", moduleId).maybeSingle();
      setModuleTitle(m?.title || ""); setCourseId(m?.course_id || null);
      const { data } = await supabase.from("quiz_questions").select("*").eq("module_id", moduleId).order("position");
      setQuestions(data || []);
    })();
  }, [moduleId]);

  const score = questions.reduce((s, q) => s + (answers[q.id] === q.correct_index ? 1 : 0), 0);
  const pct = questions.length ? Math.round((score / questions.length) * 100) : 0;

  const submit = async () => {
    setSubmitted(true);
    if (user && moduleId) {
      await supabase.from("quiz_attempts").insert({ user_id: user.id, module_id: moduleId, score: pct, answers });
    }
    if (pct >= 80) toast.success(`Passed with ${pct}%!`);
    else toast.error(`${pct}% — need 80% to pass`);
  };

  return (
    <PageShell>
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <Link to={courseId ? `/course/${courseId}` : "/dashboard"} className="text-xs text-muted-foreground hover:text-foreground">← Back</Link>
          <h1 className="text-3xl font-semibold tracking-tight mt-2">Quiz: {moduleTitle}</h1>
          <p className="text-muted-foreground mt-1">Pass with 80% or higher.</p>
        </div>
        {questions.map((q, i) => (
          <Card key={q.id} className="p-5 shadow-soft space-y-3">
            <div className="font-medium">{i + 1}. {q.question}</div>
            <div className="space-y-2">
              {(q.options as string[]).map((opt, oi) => {
                const selected = answers[q.id] === oi;
                const correct = submitted && q.correct_index === oi;
                const wrong = submitted && selected && !correct;
                return (
                  <button key={oi} onClick={() => !submitted && setAnswers({ ...answers, [q.id]: oi })}
                    className={`w-full text-left text-sm px-3 py-2.5 rounded-md border transition-colors ${
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
            {submitted && q.explanation && <p className="text-xs text-muted-foreground pt-1">{q.explanation}</p>}
          </Card>
        ))}
        <div className="flex gap-3">
          {!submitted ? (
            <Button onClick={submit} disabled={Object.keys(answers).length < questions.length}>Submit answers</Button>
          ) : (
            <>
              <Button onClick={() => { setAnswers({}); setSubmitted(false); }}>Try again</Button>
              {courseId && <Button variant="outline" onClick={() => nav(`/course/${courseId}`)}>Back to course</Button>}
            </>
          )}
        </div>
      </div>
    </PageShell>
  );
}
