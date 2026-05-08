import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Download, Copy, Instagram, Send } from "lucide-react";
import { toast } from "sonner";

interface Celebration {
  id: string;
  module_id: string;
  image_url: string | null;
  caption: string | null;
}

export function ModuleCelebrationModal() {
  const { user } = useAuth();
  const [celebration, setCelebration] = useState<Celebration | null>(null);
  const [moduleTitle, setModuleTitle] = useState<string>("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("module_celebrations")
        .select("id, module_id, image_url, caption")
        .eq("user_id", user.id)
        .is("seen_at", null)
        .not("image_url", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled || !data) return;
      const { data: m } = await supabase
        .from("modules")
        .select("title, position")
        .eq("id", data.module_id)
        .maybeSingle();
      if (cancelled) return;
      setModuleTitle(m ? `Modul ${(m.position ?? 0) + 1} — ${m.title}` : "Modul tugatildi");
      setCelebration(data as Celebration);
      setOpen(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const dismiss = async () => {
    setOpen(false);
    if (celebration) {
      await supabase
        .from("module_celebrations")
        .update({ seen_at: new Date().toISOString() })
        .eq("id", celebration.id);
    }
  };

  if (!celebration) return null;
  const caption = celebration.caption || "AI Creators kursini davom ettiryapman! 🚀";

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) dismiss(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-2xl text-center">🎉 Tabriklaymiz!</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-center text-muted-foreground">{moduleTitle} muvaffaqiyatli tugatildi!</p>
          {celebration.image_url && (
            <div className="rounded-lg overflow-hidden border bg-muted/40">
              <img src={celebration.image_url} alt="Module reward" className="w-full block" />
            </div>
          )}
          <div className="text-xs text-muted-foreground bg-muted/40 rounded-md p-3 whitespace-pre-line">
            {caption}
          </div>
          <div className="space-y-2">
            <Button
              className="w-full"
              onClick={async () => {
                if (!celebration.image_url) return;
                const a = document.createElement("a");
                a.href = celebration.image_url;
                a.download = `ai-creators-module.png`;
                a.target = "_blank";
                a.rel = "noreferrer";
                document.body.appendChild(a);
                a.click();
                a.remove();
              }}
            >
              <Download className="h-4 w-4 mr-1" /> Rasmni yuklab olish
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={async () => {
                await navigator.clipboard.writeText(caption);
                toast.success("Caption nusxalandi");
              }}
            >
              <Copy className="h-4 w-4 mr-1" /> Captionni nusxalash
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" asChild>
                <a href="https://www.instagram.com/" target="_blank" rel="noreferrer">
                  <Instagram className="h-4 w-4 mr-1" /> Instagram
                </a>
              </Button>
              <Button variant="outline" asChild>
                <a
                  href={`https://t.me/share/url?url=${encodeURIComponent(celebration.image_url || "")}&text=${encodeURIComponent(caption)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Send className="h-4 w-4 mr-1" /> Telegram
                </a>
              </Button>
            </div>
          </div>
          <button className="text-xs text-muted-foreground hover:underline w-full text-center" onClick={dismiss}>
            Yopish
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
