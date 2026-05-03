import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Trophy, Download, Share2, Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface Cert {
  id: string;
  serial_no: string;
  pdf_url: string | null;
  verification_token: string;
  issued_at: string;
  student_full_name: string;
  revoked_at: string | null;
}

export function CertificateSection() {
  const { user } = useAuth();
  const [cert, setCert] = useState<Cert | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  const load = async () => {
    if (!user) return;
    const { data } = await supabase.from("certificates").select("*").eq("profile_id", user.id).maybeSingle();
    setCert(data as Cert | null);
    if (!data) {
      // count modules done vs total for this user's enrolled courses
      const { data: enr } = await supabase.from("enrollments").select("course_id").eq("user_id", user.id);
      const courseIds = (enr || []).map((e: any) => e.course_id);
      if (courseIds.length) {
        const { data: mods } = await supabase.from("modules").select("id").in("course_id", courseIds);
        const moduleIds = (mods || []).map((m: any) => m.id);
        const total = moduleIds.length;
        // module is "done" if all its lessons completed
        const { data: lessons } = await supabase.from("lessons").select("id, module_id").in("module_id", moduleIds.length ? moduleIds : ["00000000-0000-0000-0000-000000000000"]);
        const lessonIds = (lessons || []).map((l: any) => l.id);
        const { data: lp } = await supabase.from("lesson_progress").select("lesson_id").eq("user_id", user.id).not("completed_at", "is", null).in("lesson_id", lessonIds.length ? lessonIds : ["00000000-0000-0000-0000-000000000000"]);
        const doneSet = new Set((lp || []).map((p: any) => p.lesson_id));
        let done = 0;
        for (const m of mods || []) {
          const ml = (lessons || []).filter((l: any) => l.module_id === m.id);
          if (ml.length && ml.every((l: any) => doneSet.has(l.id))) done++;
        }
        setProgress({ done, total });
      }
    }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [user]);

  const generate = async () => {
    if (!user) return;
    setGenerating(true);
    try {
      const { data, error } = await supabase.functions.invoke("generate-certificate", {
        body: { profile_id: user.id, send_telegram: false },
      });
      if (error) throw error;
      toast.success("Sertifikat tayyor!");
      await load();
      if ((data as any)?.pdf_url) window.open((data as any).pdf_url, "_blank");
    } catch (e: any) {
      toast.error(e?.message || "Xatolik yuz berdi");
    } finally {
      setGenerating(false);
    }
  };

  if (loading) return null;

  if (!cert) {
    return (
      <Card className="p-5">
        <div className="flex items-center gap-2 mb-2">
          <Trophy className="h-5 w-5 text-muted-foreground" />
          <h3 className="font-semibold">🏆 Sertifikat</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          Kursni tugatish uchun barcha modullarni yakunlang. Hozirgi: <b>{progress.done}/{progress.total || "—"}</b>
        </p>
      </Card>
    );
  }

  const verifyUrl = `${window.location.origin}/verify/${cert.verification_token}`;
  const tgShareUrl = `https://t.me/share/url?url=${encodeURIComponent(verifyUrl)}&text=${encodeURIComponent("AI Creators kursini tugatdim! 🎉")}`;

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Trophy className="h-5 w-5 text-amber-500" />
          <h3 className="font-semibold">🏆 Sertifikat</h3>
        </div>
        {cert.revoked_at && <span className="text-xs px-2 py-0.5 rounded bg-destructive/10 text-destructive">Bekor qilingan</span>}
      </div>
      <div className="text-sm space-y-1 mb-4">
        <div><span className="text-muted-foreground">Serial:</span> <span className="font-mono">{cert.serial_no}</span></div>
        <div><span className="text-muted-foreground">Sana:</span> {new Date(cert.issued_at).toLocaleDateString("en-CA")}</div>
      </div>
      <div className="flex flex-wrap gap-2">
        {cert.pdf_url ? (
          <Button asChild size="sm"><a href={cert.pdf_url} target="_blank" rel="noreferrer"><Download className="h-4 w-4 mr-1" /> Yuklab olish</a></Button>
        ) : (
          <Button size="sm" onClick={generate} disabled={generating}>
            {generating ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Download className="h-4 w-4 mr-1" />}
            PDFni yaratish
          </Button>
        )}
        <Button size="sm" variant="outline" asChild><a href={tgShareUrl} target="_blank" rel="noreferrer"><Share2 className="h-4 w-4 mr-1" /> Telegram</a></Button>
        <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(verifyUrl); toast.success("Link nusxalandi"); }}>
          <Copy className="h-4 w-4 mr-1" /> Verifikatsiya linki
        </Button>
      </div>
    </Card>
  );
}
