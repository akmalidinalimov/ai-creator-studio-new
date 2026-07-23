// Telegram Mini App broadcast composer. Opened from the bot's admin "📣 Ommaviy xabar" web_app
// button — runs INSIDE Telegram with no Supabase session. It reads Telegram's signed initData and
// sends it to the tg-broadcast edge function, which validates it and checks admin role. Same composer
// as the web /admin/broadcast page, Telegram-native.
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Loader2, Megaphone, ImagePlus, X } from "lucide-react";

interface Course { id: string; title: string; reachable: number }
interface Status { status: string; total: number; sent: number; failed: number; pending: number; mode?: string }

export default function TgBroadcast() {
  const [initData, setInitData] = useState<string | null | undefined>(undefined); // undefined=loading, null=not in TG
  const [courses, setCourses] = useState<Course[]>([]);
  const [courseId, setCourseId] = useState("");

  const [imageB64, setImageB64] = useState<string | null>(null);
  const [imageExt, setImageExt] = useState<string>("jpg");
  const [imagePreview, setImagePreview] = useState<string | null>(null);

  const [bodyUz, setBodyUz] = useState("");
  const [showOverrides, setShowOverrides] = useState(false);
  const [bodyRu, setBodyRu] = useState("");
  const [bodyEn, setBodyEn] = useState("");
  const [btnLabel, setBtnLabel] = useState("");
  const [btnUrl, setBtnUrl] = useState("");

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const pollRef = useRef<number | null>(null);

  const reachable = courses.find((c) => c.id === courseId)?.reachable ?? null;
  const limit = imageB64 ? 1024 : 4096;

  // Load the Telegram Web App SDK, then fetch courses via the signed initData.
  useEffect(() => {
    const s = document.createElement("script");
    s.src = "https://telegram.org/js/telegram-web-app.js";
    s.onload = () => {
      const wa = (window as unknown as { Telegram?: { WebApp?: any } }).Telegram?.WebApp;
      if (wa && wa.initData) { wa.ready(); wa.expand(); setInitData(wa.initData); }
      else setInitData(null);
    };
    s.onerror = () => setInitData(null);
    document.body.appendChild(s);
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
  }, []);

  useEffect(() => {
    if (!initData) return;
    (async () => {
      const { data, error } = await supabase.functions.invoke("tg-broadcast", { body: { action: "init", initData } });
      if (error) { toast.error("Ruxsat yo'q yoki xatolik"); return; }
      setCourses(((data as { courses?: Course[] })?.courses || []));
    })();
  }, [initData]);

  const onPickImage = (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { toast.error("Faqat rasm"); return; }
    if (file.size > 5 * 1024 * 1024) { toast.error("Rasm 5MB dan katta"); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      setImageB64(dataUrl.split(",")[1] || null);
      setImageExt((file.name.split(".").pop() || "jpg").toLowerCase());
      setImagePreview(dataUrl);
    };
    reader.readAsDataURL(file);
  };
  const clearImage = () => { setImageB64(null); setImagePreview(null); };

  const startPolling = (broadcast_id: string) => {
    if (pollRef.current) window.clearInterval(pollRef.current);
    const tick = async () => {
      const { data } = await supabase.functions.invoke("tg-broadcast", { body: { action: "status", initData, broadcast_id } });
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
    for (const [n, v] of [["O'zbek", bodyUz], ["Rus", bodyRu], ["Ingliz", bodyEn]] as const) {
      if (v && v.length > limit) { toast.error(`${n} matni ${limit} belgidan oshdi`); return; }
    }
    if ((btnLabel && !btnUrl) || (btnUrl && !btnLabel)) { toast.error("Tugma uchun matn va havola kerak"); return; }
    if (mode === "all" && !window.confirm(`${reachable ?? "?"} ta talabaga yuborilsinmi?`)) return;

    setBusy(true); setStatus(null);
    const { data, error } = await supabase.functions.invoke("tg-broadcast", {
      body: {
        action: "send", initData, course_id: courseId,
        image_b64: imageB64, image_ext: imageExt,
        body_uz: bodyUz.trim(), body_ru: bodyRu.trim() || null, body_en: bodyEn.trim() || null,
        button_label: btnLabel.trim() || null, button_url: btnUrl.trim() || null, mode,
      },
    });
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    const res = data as { broadcast_id?: string; total?: number; error?: string };
    if (res?.error) { toast.error(res.error); return; }
    toast.success(mode === "test" ? "Test yuborilmoqda…" : `${res.total} ta talabaga yuborilmoqda…`);
    if (res.broadcast_id) startPolling(res.broadcast_id);
  };

  if (initData === undefined) {
    return <div className="min-h-screen flex items-center justify-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  }
  if (initData === null) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Bu sahifani Telegram bot ichidagi <b>📣 Ommaviy xabar</b> tugmasi orqali oching.
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground p-4">
      <div className="max-w-lg mx-auto space-y-4">
        <div className="flex items-center gap-2">
          <Megaphone className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold">Ommaviy xabar</h1>
        </div>

        <div className="space-y-1.5">
          <Label>Kurs</Label>
          <select value={courseId} onChange={(e) => setCourseId(e.target.value)}
            className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm">
            <option value="">— Kursni tanlang —</option>
            {courses.map((c) => <option key={c.id} value={c.id}>{c.title} ({c.reachable})</option>)}
          </select>
          {reachable !== null && <p className="text-xs text-muted-foreground">→ <b>{reachable}</b> ta talaba botga ulangan</p>}
        </div>

        <div className="space-y-1.5">
          <Label>Rasm (ixtiyoriy)</Label>
          {imagePreview ? (
            <div className="relative inline-block">
              <img src={imagePreview} alt="" className="max-h-40 rounded-md border" />
              <button onClick={clearImage} className="absolute -top-2 -right-2 bg-background border rounded-full p-1 shadow"><X className="h-3.5 w-3.5" /></button>
            </div>
          ) : (
            <label className="flex items-center gap-2 h-10 px-3 rounded-md border border-dashed cursor-pointer text-sm text-muted-foreground w-fit">
              <ImagePlus className="h-4 w-4" /> Rasm yuklash
              <input type="file" accept="image/*" className="hidden" onChange={(e) => onPickImage(e.target.files?.[0] || null)} />
            </label>
          )}
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label>Xabar (O'zbek)</Label>
            <span className={`text-xs ${bodyUz.length > limit ? "text-destructive" : "text-muted-foreground"}`}>{bodyUz.length}/{limit}</span>
          </div>
          <Textarea rows={6} value={bodyUz} onChange={(e) => setBodyUz(e.target.value)} placeholder="Assalomu alaykum! …" />
        </div>

        <button className="text-xs text-primary underline" onClick={() => setShowOverrides((s) => !s)}>
          {showOverrides ? "Rus / Ingliz yashirish" : "Rus / Ingliz qo'shish"}
        </button>
        {showOverrides && (
          <div className="grid gap-3">
            <div className="space-y-1"><Label className="text-xs">Русский</Label><Textarea rows={4} value={bodyRu} onChange={(e) => setBodyRu(e.target.value)} /></div>
            <div className="space-y-1"><Label className="text-xs">English</Label><Textarea rows={4} value={bodyEn} onChange={(e) => setBodyEn(e.target.value)} /></div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1"><Label className="text-xs">Tugma matni</Label><Input value={btnLabel} onChange={(e) => setBtnLabel(e.target.value)} placeholder="🌐 Saytga kirish" /></div>
          <div className="space-y-1"><Label className="text-xs">Havola</Label><Input value={btnUrl} onChange={(e) => setBtnUrl(e.target.value)} placeholder="https://aicreator.academy" /></div>
        </div>

        <div className="flex gap-2 pt-1">
          <Button variant="outline" className="flex-1" onClick={() => send("test")} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Menga test
          </Button>
          <Button className="flex-1" onClick={() => send("all")} disabled={busy || !courseId}>
            Yuborish{reachable !== null ? ` → ${reachable}` : ""}
          </Button>
        </div>

        {status && (
          <div className="rounded-lg border p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-medium text-sm">{status.status === "done" ? "✅ Yakunlandi" : "Yuborilmoqda…"}{status.mode === "test" ? " (test)" : ""}</span>
              {status.status !== "done" && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div className="h-full bg-primary transition-all" style={{ width: `${status.total ? Math.round(((status.sent + status.failed) / status.total) * 100) : 0}%` }} />
            </div>
            <p className="text-sm text-muted-foreground"><b className="text-foreground">{status.sent}</b> yuborildi · <b className="text-foreground">{status.failed}</b> yetmadi · {status.pending} / {status.total}</p>
          </div>
        )}
      </div>
    </div>
  );
}
