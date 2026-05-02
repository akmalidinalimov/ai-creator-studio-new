import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Paperclip } from "lucide-react";

interface Props { lessonId: string }

export function HomeworkSection({ lessonId }: Props) {
  const { user } = useAuth();
  const { i18n } = useTranslation();
  const [assignment, setAssignment] = useState<any>(null);
  const [submission, setSubmission] = useState<any>(null);
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [isLast, setIsLast] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!user || !lessonId) return;
    (async () => {
      const { data: l } = await supabase.from("lessons").select("module_id, position").eq("id", lessonId).maybeSingle();
      if (!l) return;
      const { data: siblings } = await supabase.from("lessons").select("position").eq("module_id", l.module_id).eq("published", true).order("position", { ascending: false }).limit(1);
      const lastPos = siblings?.[0]?.position;
      if (lastPos !== l.position) { setIsLast(false); return; }
      setIsLast(true);
      const { data: a } = await supabase.from("homework_assignments").select("*").eq("module_id", l.module_id).maybeSingle();
      setAssignment(a);
      if (!a) return;
      const { data: s } = await supabase.from("homework_submissions").select("*").eq("assignment_id", a.id).eq("user_id", user.id).maybeSingle();
      if (s) {
        setSubmission(s);
        setText(s.submitted_text || "");
        if (s.submitted_image_url) {
          const { data } = await supabase.storage.from("homework_images").createSignedUrl(s.submitted_image_url, 600);
          setImgUrl(data?.signedUrl || null);
        }
      }
    })();
  }, [user, lessonId]);

  if (!isLast || !assignment) return null;

  const lng = (i18n.language || "uz").slice(0, 2);
  const prompt = (lng === "ru" ? assignment.prompt_ru : lng === "en" ? assignment.prompt_en : assignment.prompt_uz) || assignment.description || "";
  const locked = submission?.score != null;

  const submit = async () => {
    if (!user || !assignment) return;
    if (!text.trim() && !file) { toast.error("Matn yoki rasm kerak"); return; }
    if (text.length > 2000) { toast.error("Matn juda uzun (max 2000)"); return; }
    setBusy(true);
    let imagePath = submission?.submitted_image_url || null;
    if (file) {
      if (file.size > 5 * 1024 * 1024) { toast.error("Rasm 5MB dan oshmasligi kerak"); setBusy(false); return; }
      const ext = file.name.split(".").pop() || "jpg";
      const path = `${user.id}/${assignment.id}_${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from("homework_images").upload(path, file, { upsert: true, contentType: file.type });
      if (upErr) { toast.error(upErr.message); setBusy(false); return; }
      imagePath = path;
    }
    const payload = {
      assignment_id: assignment.id,
      user_id: user.id,
      submitted_text: text.trim().slice(0, 2000),
      submitted_image_url: imagePath,
      submitted_at: new Date().toISOString(),
    };
    const { data, error } = submission
      ? await supabase.from("homework_submissions").update(payload).eq("id", submission.id).select().maybeSingle()
      : await supabase.from("homework_submissions").insert(payload).select().maybeSingle();
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    setSubmission(data);
    setFile(null);
    if (inputRef.current) inputRef.current.value = "";
    if (imagePath) {
      const { data: u } = await supabase.storage.from("homework_images").createSignedUrl(imagePath, 600);
      setImgUrl(u?.signedUrl || null);
    }
    toast.success("Topshirildi! Baholashni kuting.");
  };

  return (
    <Card className="p-5 shadow-soft space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="font-semibold text-lg">📝 Modul uy vazifasi: {assignment.title}</h2>
        {submission?.score != null && (
          <Badge className="bg-green-600 text-white">✓ Baholandi: {submission.score}/{assignment.max_score}</Badge>
        )}
        {submission && submission.score == null && <Badge variant="secondary">Topshirildi · baholanmoqda</Badge>}
        {submission?.is_late && <Badge variant="destructive">Kech topshirilgan</Badge>}
      </div>
      {prompt && <div className="text-sm text-muted-foreground whitespace-pre-wrap">{prompt}</div>}

      {submission?.score != null && submission.score_feedback && (
        <Card className="p-3 bg-muted/40 text-sm">
          <div className="text-xs font-semibold mb-1">O'qituvchi izohi:</div>
          <div className="whitespace-pre-wrap">{submission.score_feedback}</div>
        </Card>
      )}

      <Textarea
        rows={5}
        maxLength={2000}
        placeholder="Javobingizni yozing..."
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={locked || busy}
      />
      <div className="text-xs text-muted-foreground text-right">{text.length}/2000</div>

      {imgUrl && <img src={imgUrl} alt="topshiriq" className="max-h-72 rounded-lg border" />}

      {!locked && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-1.5 text-sm cursor-pointer px-3 py-2 border rounded-md hover:bg-muted">
            <Paperclip className="h-4 w-4" />
            <span>📎 Rasm yuklash</span>
            <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] || null)} />
          </label>
          {file && <span className="text-xs text-muted-foreground">{file.name}</span>}
          <Button onClick={submit} disabled={busy}>{submission ? "♻️ Yangilash" : "Topshirish"}</Button>
        </div>
      )}
      {locked && <div className="text-xs text-muted-foreground">Bu vazifa baholangan. Qayta topshirish o'qituvchi ruxsati bilan mumkin.</div>}
    </Card>
  );
}
