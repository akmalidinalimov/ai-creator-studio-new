import { useEffect, useState } from "react";
import { getSiteUrl } from "@/lib/siteUrl";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Download, Share2, Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";

const SEEN_KEY = "cert_celebration_seen";

export function CertificateCelebrationModal() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [cert, setCert] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      if (!user) return;
      const { data } = await supabase.from("certificates").select("*").eq("profile_id", user.id).maybeSingle();
      if (!data) return;
      const seen = localStorage.getItem(`${SEEN_KEY}_${data.id}`);
      setCert(data);
      if (!seen) setOpen(true);
    })();
  }, [user]);

  const dismiss = () => {
    if (cert) localStorage.setItem(`${SEEN_KEY}_${cert.id}`, "1");
    setOpen(false);
  };

  const ensurePdf = async (): Promise<string | null> => {
    if (cert?.pdf_url) return cert.pdf_url;
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("generate-certificate", {
        body: { profile_id: user!.id, send_telegram: true },
      });
      if (error) throw error;
      const url = (data as any)?.pdf_url as string;
      setCert((c: any) => ({ ...c, pdf_url: url }));
      return url;
    } catch (e: any) {
      toast.error(e?.message || "Xatolik");
      return null;
    } finally {
      setBusy(false);
    }
  };

  if (!cert) return null;
  const verifyUrl = `${getSiteUrl()}/verify/${cert.verification_token}`;
  const tgShare = `https://t.me/share/url?url=${encodeURIComponent(verifyUrl)}&text=${encodeURIComponent("AI Creators kursini tugatdim! 🎉")}`;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) dismiss(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-2xl text-center">🎉 Tabriklaymiz!</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-center">
          <p className="text-muted-foreground">Siz AI Creators kursini muvaffaqiyatli tugatdingiz!</p>
          <div className="bg-muted/40 rounded-lg p-3 text-sm">
            <div>Serial: <span className="font-mono">{cert.serial_no}</span></div>
          </div>
          <div className="space-y-2">
            <Button className="w-full" disabled={busy} onClick={async () => { const u = await ensurePdf(); if (u) window.open(u, "_blank"); }}>
              {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Download className="h-4 w-4 mr-1" />}
              📥 Sertifikatni yuklab olish
            </Button>
            <Button variant="outline" className="w-full" asChild>
              <a href={tgShare} target="_blank" rel="noreferrer"><Share2 className="h-4 w-4 mr-1" /> 📱 Telegram orqali ulashish</a>
            </Button>
            <Button variant="outline" className="w-full" onClick={() => { navigator.clipboard.writeText(verifyUrl); toast.success("Link nusxalandi"); }}>
              <Copy className="h-4 w-4 mr-1" /> 🔗 Verifikatsiya linki
            </Button>
          </div>
          <button className="text-xs text-muted-foreground hover:underline" onClick={dismiss}>Yopish</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
