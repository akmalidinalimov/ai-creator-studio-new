import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { mutate } from "@/lib/mutate";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

interface Q { id: string; question: string; options: string[]; correct_index: number; explanation: string | null; position: number }

export const ModuleQuizEditor = ({ moduleId, onClose }: { moduleId: string; onClose: () => void }) => {
  const { t } = useTranslation();
  const [questions, setQuestions] = useState<Q[]>([]);

  const load = async () => {
    const { data } = await supabase.from("quiz_questions").select("*").eq("module_id", moduleId).order("position");
    setQuestions((data || []) as Q[]);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [moduleId]);

  const addQ = async () => {
    const { data, error } = await supabase.from("quiz_questions").insert({
      module_id: moduleId, question: t("admin.quiz.newQuestion"), options: ["", "", "", ""], correct_index: 0, position: questions.length,
    }).select("*").single();
    if (error) { toast.error(error.message); return; }
    setQuestions((qs) => [...qs, data as Q]);
  };

  const updateQ = async (id: string, patch: Partial<Q>) => {
    setQuestions((qs) => qs.map((q) => q.id === id ? { ...q, ...patch } as Q : q));
    const r = await mutate(() => supabase.from("quiz_questions").update(patch).eq("id", id));
    if (!r.ok && r.reason !== "impersonation_readonly") toast.error(r.message ?? "Saqlanmadi");
  };

  const deleteQ = async (id: string) => {
    const r = await mutate(() => supabase.from("quiz_questions").delete().eq("id", id));
    if (!r.ok) { if (r.reason !== "impersonation_readonly") toast.error(r.message ?? "Saqlanmadi"); return; }
    setQuestions((qs) => qs.filter((q) => q.id !== id));
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{t("admin.quiz.title", { count: questions.length })}</DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground -mt-2">{t("admin.quiz.passLine")}</p>
        <div className="space-y-4">
          {questions.map((q, qi) => (
            <div key={q.id} className="border rounded-md p-4 space-y-3 bg-card">
              <div className="flex items-start justify-between gap-2">
                <span className="text-xs text-muted-foreground">{t("admin.quiz.qLabel", { n: qi + 1 })}</span>
                <Button variant="ghost" size="icon" onClick={() => deleteQ(q.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
              </div>
              <Textarea
                value={q.question}
                onChange={(e) => setQuestions((qs) => qs.map((x) => x.id === q.id ? { ...x, question: e.target.value } : x))}
                onBlur={(e) => updateQ(q.id, { question: e.target.value })}
                rows={2}
              />
              <div className="space-y-2">
                {q.options.map((opt, oi) => (
                  <div key={oi} className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={q.correct_index === oi}
                      onChange={() => updateQ(q.id, { correct_index: oi })}
                      aria-label={t("admin.quiz.markCorrect", { n: oi + 1 })}
                    />
                    <Input
                      value={opt}
                      onChange={(e) => {
                        const next = [...q.options]; next[oi] = e.target.value;
                        setQuestions((qs) => qs.map((x) => x.id === q.id ? { ...x, options: next } : x));
                      }}
                      onBlur={() => updateQ(q.id, { options: q.options })}
                      placeholder={t("admin.quiz.optionPh", { n: oi + 1 })}
                    />
                  </div>
                ))}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t("admin.quiz.explanationLabel")}</Label>
                <Input
                  value={q.explanation || ""}
                  onChange={(e) => setQuestions((qs) => qs.map((x) => x.id === q.id ? { ...x, explanation: e.target.value } : x))}
                  onBlur={(e) => updateQ(q.id, { explanation: e.target.value })}
                />
              </div>
            </div>
          ))}
          <Button variant="outline" onClick={addQ} className="w-full"><Plus className="h-4 w-4" /> {t("admin.quiz.addQuestion")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
