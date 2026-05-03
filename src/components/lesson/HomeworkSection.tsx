import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Paperclip, ChevronDown, ChevronRight } from "lucide-react";

interface Props { lessonId: string }
interface Assignment {
  id: string; title: string; description: string | null;
  prompt_uz: string | null; prompt_ru: string | null; prompt_en: string | null;
  max_score: number; task_number: number; is_active: boolean;
}
interface Submission {
  id: string; assignment_id: string; submitted_text: string | null;
  submitted_image_url: string | null; score: number | null; score_feedback: string | null;
  is_late: boolean;
}

export function HomeworkSection({ lessonId }: Props) {
  const { user } = useAuth();
  const [isLast, setIsLast] = useState(false);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [subsByAssign, setSubsByAssign] = useState<Record<string, Submission>>({});

  const refresh = async () => {
    if (!user || !lessonId) return;
    const { data: l } = await supabase.from("lessons").select("module_id, position").eq("id", lessonId).maybeSingle();
    if (!l) return;
    const { data: siblings } = await supabase.from("lessons").select("position").eq("module_id", l.module_id).eq("published", true).order("position", { ascending: false }).limit(1);
    const lastPos = siblings?.[0]?.position;
    if (lastPos !== l.position) { setIsLast(false); return; }
    setIsLast(true);

    const { data: as } = await supabase
      .from("homework_assignments")
      .select("*")
      .eq("module_id", l.module_id)
      .eq("is_active", true)
      .order("task_number");
    const list = (as as any[] || []) as Assignment[];
    setAssignments(list);

    if (list.length) {
      const { data: ss } = await supabase
        .from("homework_submissions")
        .select("*")
        .eq("user_id", user.id)
        .in("assignment_id", list.map((a) => a.id));
      const m: Record<string, Submission> = {};
      (ss as any[] || []).forEach((s) => { m[s.assignment_id] = s as Submission; });
      setSubsByAssign(m);
    } else {
      setSubsByAssign({});
    }
  };

  useEffect(() => { refresh(); }, [user, lessonId]);

  if (!isLast || assignments.length === 0) return null;

  const scored = assignments.filter((a) => subsByAssign[a.id]?.score != null);
  const moduleAvg = scored.length
    ? +(
        (scored.reduce((acc, a) => acc + Number(subsByAssign[a.id].score) / a.max_score, 0) / scored.length) * 10
      ).toFixed(1)
    : null;

  return (
    <Card className="p-5 space-y-3 shadow-soft">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="font-semibold text-lg">📝 Modul vazifalari</h2>
        <div className="text-xs text-muted-foreground">
          {scored.length}/{assignments.length} baholangan
          {moduleAvg != null && ` · O'rtacha: ${moduleAvg}/10`}
        </div>
      </div>
      {assignments.map((a) => (
        <TaskCard key={a.id} assignment={a} submission={subsByAssign[a.id]} userId={user!.id} onSaved={refresh} />
      ))}
    </Card>
  );
}

function TaskCard({ assignment, submission, userId, onSaved }: {
  assignment: Assignment; submission?: Submission; userId: string; onSaved: () => void;
}) {
  const { i18n } = useTranslation();
  const [open, setOpen] = useState(!submission);
  const [text, setText] = useState(submission?.submitted_text || "");
  const [file, setFile] = useState<File | null>(null);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (submission?.submitted_image_url) {
      supabase.storage.from("homework_images").createSignedUrl(submission.submitted_image_url, 600)
        .then(({ data }) => setImgUrl(data?.signedUrl || null));
    }
  }, [submission?.submitted_image_url]);

  const lng = (i18n.language || "uz").slice(0, 2);
  const prompt = (lng === "ru" ? assignment.prompt_ru : lng === "en" ? assignment.prompt_en : assignment.prompt_uz) || assignment.description || "";
  const locked = submission?.score != null;

  const submit = async () => {
    if (!text.trim() && !file) { toast.error("Matn yoki rasm kerak"); return; }
    if (text.length > 2000) { toast.error("Matn juda uzun (max 2000)"); return; }
    setBusy(true);
    let imagePath = submission?.submitted_image_url || null;
    if (file) {
      if (file.size > 5 * 1024 * 1024) { toast.error("Rasm 5MB dan oshmasligi kerak"); setBusy(false); return; }
      const ext = file.name.split(".").pop() || "jpg";
      const path = `${userId}/${assignment.id}_${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from("homework_images").upload(path, file, { upsert: true, contentType: file.type });
      if (upErr) { toast.error(upErr.message); setBusy(false); return; }
      imagePath = path;
    }
    const payload = {
      assignment_id: assignment.id,
      user_id: userId,
      submitted_text: text.trim().slice(0, 2000),
      submitted_image_url: imagePath,
      submitted_at: new Date().toISOString(),
    };
    const { error } = submission
      ? await supabase.from("homework_submissions").update(payload).eq("id", submission.id)
      : await supabase.from("homework_submissions").insert(payload);
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    setFile(null);
    if (inputRef.current) inputRef.current.value = "";
    toast.success("Topshirildi! Baholashni kuting.");
    onSaved();
  };

  return (
    <div className="border rounded-lg">
      <button type="button" onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-3 hover:bg-muted/30 text-left">
        <div className="flex items-center gap-2 min-w-0">
          <Badge>V{assignment.task_number}</Badge>
          <span className="font-medium truncate">{assignment.title}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {submission?.score != null ? (
            <Badge className="bg-green-600 text-white">{submission.score}/{assignment.max_score}</Badge>
          ) : submission ? (
            <Badge variant="secondary">Topshirildi</Badge>
          ) : (
            <Badge variant="outline">Boshlanmagan</Badge>
          )}
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </div>
      </button>
      {open && (
        <div className="p-3 pt-0 space-y-3 border-t">
          {prompt && <div className="text-sm text-muted-foreground whitespace-pre-wrap">{prompt}</div>}
          {submission?.score != null && submission.score_feedback && (
            <Card className="p-3 bg-muted/40 text-sm">
              <div className="text-xs font-semibold mb-1">O'qituvchi izohi:</div>
              <div className="whitespace-pre-wrap">{submission.score_feedback}</div>
            </Card>
          )}
          <Textarea rows={4} maxLength={2000} placeholder="Javobingizni yozing..."
            value={text} onChange={(e) => setText(e.target.value)} disabled={locked || busy} />
          <div className="text-xs text-muted-foreground text-right">{text.length}/2000</div>
          {imgUrl && <img src={imgUrl} alt="topshiriq" className="max-h-72 rounded-lg border" />}
          {!locked && (
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex items-center gap-1.5 text-sm cursor-pointer px-3 py-2 border rounded-md hover:bg-muted">
                <Paperclip className="h-4 w-4" /><span>📎 Rasm</span>
                <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
                  onChange={(e) => setFile(e.target.files?.[0] || null)} />
              </label>
              {file && <span className="text-xs text-muted-foreground">{file.name}</span>}
              <Button onClick={submit} disabled={busy}>{submission ? "♻️ Yangilash" : "Topshirish"}</Button>
            </div>
          )}
          {locked && <div className="text-xs text-muted-foreground">Bu vazifa baholangan.</div>}
        </div>
      )}
    </div>
  );
}
