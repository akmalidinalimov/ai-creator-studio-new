import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Loader2, Megaphone, ImagePlus, X } from "lucide-react";

interface Course { id: string; title: string }
interface Status { status: string; total: number; sent: number; failed: number; pending: number; mode?: string }

export default function AdminBroadcast() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [courseId, setCourseId] = useState("");
  const [reachable, setReachable] = useState<number | null>(null);

  const [imagePath, setImagePath] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const [bodyUz, setBodyUz] = useState("");
  const [showOverrides, setShowOverrides] = useState(false);
  const [bodyRu, setBodyRu] = useState("");
  const [bodyEn, setBodyEn] = useState("");
  const [btnLabel, setBtnLabel] = useState("");
  const [btnUrl, setBtnUrl] = useState("");

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const pollRef = useRef<number | null>(null);

  const limit = imagePath ? 1024 : 4096;

  useEffect(() => {
    supabase.from("courses").select("id, title").order("created_at", { ascending: false })
      .then(({ data }) => setCourses((data || []) as Course[]));
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
  }, []);

  useEffect(() => {
    setReachable(null);
    if (!courseId) return;
    // RPC not yet in generated types → cast.
    (supabase as any).rpc("broadcast_reachable", { _course_id: courseId })
      .then(({ data }: { data: unknown }) => setReachable(typeof data === "number" ? data : null));
  }, [courseId]);

  const onPickImage = async (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { toast.error("Faqat rasm fayli"); return; }
    if (file.size > 5 * 1024 * 1024) { toast.error("Rasm 5MB dan katta"); return; }
    setUploading(true);
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const key = `${crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage.from("broadcast-images").upload(key, file, { contentType: file.type });
    setUploading(false);
    if (error) { toast.error(error.message); return; }
    setImagePath(key);
    setImagePreview(URL.createObjectURL(file));
  };

  const clearImage = () => { setImagePath(null); setImagePreview(null); };

  const startPolling = (broadcast_id: string) => {
    if (pollRef.current) window.clearInterval(pollRef.current);
    const tick = async () => {
      const { data } = await (supabase as any).rpc("broadcast_status", { _broadcast_id: broadcast_id });
      const s = data as Status;
      setStatus(s);
      if (s?.status === "done" && pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
    };
    tick();
    pollRef.current = window.setInterval(tick, 3000);
  };

  const send = async (mode: "test" | "all") => {
    if (!courseId) { toast.error("Kursni tanlang"); return; }
    if (!bodyUz.trim()) { toast.error("Xabar matnini kiriting"); return; }
    for (const [name, v] of [["O'zbek", bodyUz], ["Rus", bodyRu], ["Ingliz", bodyEn]] as const) {
      if (v && v.length > limit) { toast.error(`${name} matni ${limit} belgidan oshdi`); return; }
    }
    if ((btnLabel && !btnUrl) || (btnUrl && !btnLabel)) { toast.error("Tugma uchun matn va havola kerak"); return; }
    if (mode === "all" && !window.confirm(`${reachable ?? "?"} ta talabaga yuborilsinmi? Bu amalni bekor qilib bo'lmaydi.`)) return;

    setBusy(true); setStatus(null);
    const { data, error } = await supabase.functions.invoke("admin-broadcast", {
      body: {
        course_id: courseId, image_path: imagePath, body_uz: bodyUz.trim(),
        body_ru: bodyRu.trim() || null, body_en: bodyEn.trim() || null,
        button_label: btnLabel.trim() || null, button_url: btnUrl.trim() || null, mode,
      },
    });
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    const res = data as { broadcast_id: string; total: number };
    toast.success(mode === "test" ? "Test xabar sizga yuborilmoqda…" : `${res.total} ta talabaga yuborilmoqda…`);
    startPolling(res.broadcast_id);
  };

  return (
    <PageShell>
      <div className="max-w-2xl space-y-6">
        <div className="flex items-center gap-2">
          <Megaphone className="h-6 w-6 text-primary" />
          <h1 className="text-3xl font-semibold tracking-tight">Ommaviy xabar</h1>
        </div>
        <p className="text-muted-foreground -mt-2">
          Tanlangan kurs talabalariga botdan shaxsiy xabar yuboradi. Avval o'zingizga test yuboring.
        </p>

        <Card className="p-5 space-y-4">
          <div className="space-y-1.5">
            <Label>Kurs</Label>
            <select
              value={courseId}
              onChange={(e) => setCourseId(e.target.value)}
              className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">— Kursni tanlang —</option>
              {courses.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
            {reachable !== null && (
              <p className="text-xs text-muted-foreground">→ <b>{reachable}</b> ta talaba botga ulangan (DM yetadi)</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Rasm (ixtiyoriy)</Label>
            {imagePreview ? (
              <div className="relative inline-block">
                <img src={imagePreview} alt="" className="max-h-40 rounded-md border" />
                <button onClick={clearImage} className="absolute -top-2 -right-2 bg-background border rounded-full p-1 shadow">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <label className="flex items-center gap-2 h-10 px-3 rounded-md border border-dashed cursor-pointer text-sm text-muted-foreground hover:bg-muted w-fit">
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
                Rasm yuklash
                <input type="file" accept="image/*" className="hidden" onChange={(e) => onPickImage(e.target.files?.[0] || null)} />
              </label>
            )}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>Xabar (O'zbek)</Label>
              <span className={`text-xs ${bodyUz.length > limit ? "text-destructive" : "text-muted-foreground"}`}>{bodyUz.length}/{limit}</span>
            </div>
            <Textarea rows={6} value={bodyUz} onChange={(e) => setBodyUz(e.target.value)} placeholder="Assalomu alaykum! …  (HTML: <b>qalin</b>, <a href>havola</a>)" />
          </div>

          <button className="text-xs text-primary underline underline-offset-2" onClick={() => setShowOverrides((s) => !s)}>
            {showOverrides ? "Rus / Ingliz variantlarini yashirish" : "Rus / Ingliz variantlarini qo'shish (ixtiyoriy)"}
          </button>
          {showOverrides && (
            <div className="grid gap-3">
              <div className="space-y-1.5"><Label className="text-xs">Русский</Label>
                <Textarea rows={4} value={bodyRu} onChange={(e) => setBodyRu(e.target.value)} /></div>
              <div className="space-y-1.5"><Label className="text-xs">English</Label>
                <Textarea rows={4} value={bodyEn} onChange={(e) => setBodyEn(e.target.value)} /></div>
              <p className="text-xs text-muted-foreground">Bo'sh qoldirilsa, talaba O'zbek matnini oladi.</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label className="text-xs">Tugma matni (ixtiyoriy)</Label>
              <Input value={btnLabel} onChange={(e) => setBtnLabel(e.target.value)} placeholder="🌐 Saytga kirish" /></div>
            <div className="space-y-1.5"><Label className="text-xs">Tugma havolasi</Label>
              <Input value={btnUrl} onChange={(e) => setBtnUrl(e.target.value)} placeholder="https://aicreator.academy" /></div>
          </div>

          <div className="flex flex-wrap gap-2 pt-2">
            <Button variant="outline" onClick={() => send("test")} disabled={busy || uploading}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Menga test yuborish
            </Button>
            <Button onClick={() => send("all")} disabled={busy || uploading || !courseId}>
              Yuborish{reachable !== null ? ` → ${reachable}` : ""}
            </Button>
          </div>
        </Card>

        {status && (
          <Card className="p-5 space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">{status.status === "done" ? "✅ Yakunlandi" : "Yuborilmoqda…"}{status.mode === "test" ? " (test)" : ""}</h2>
              {status.status !== "done" && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div className="h-full bg-primary transition-all"
                style={{ width: `${status.total ? Math.round(((status.sent + status.failed) / status.total) * 100) : 0}%` }} />
            </div>
            <p className="text-sm text-muted-foreground">
              <b className="text-foreground">{status.sent}</b> yuborildi · <b className="text-foreground">{status.failed}</b> yetmadi · {status.pending} kutilmoqda / {status.total}
            </p>
            {status.status === "done" && status.failed > 0 && (
              <p className="text-xs text-muted-foreground">Yetmaganlar — botni ishga tushirmagan yoki bloklagan talabalar (Telegram cheklovi).</p>
            )}
          </Card>
        )}
      </div>
    </PageShell>
  );
}
