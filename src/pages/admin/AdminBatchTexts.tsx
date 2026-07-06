import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Save, Megaphone, Info } from "lucide-react";

/**
 * Batch texts — editable Telegram DM captions for achievement badges.
 * Each row is a tailored praise paragraph; the special "__share__" row is the
 * shared "why share + tags" block appended to every badge card caption.
 * {{name}} is replaced with the student's first name at send time.
 * Stored in public.badge_messages; read by the notify-badge-award function.
 */

const SHARE_CODE = "__share__";

// Display order + friendly labels for each editable text.
const BADGES: { code: string; label: string }[] = [
  { code: "first_lesson", label: "🚀 Birinchi dars" },
  { code: "first_homework", label: "✍️ Birinchi vazifa" },
  { code: "five_lessons", label: "📚 5 dars" },
  { code: "ten_lessons", label: "🎯 10 dars" },
  { code: "module_complete", label: "🎓 Modul tamom" },
  { code: "streak_3", label: "🔥 3 kunlik streak" },
  { code: "streak_7", label: "🔥 7 kunlik streak" },
  { code: "streak_14", label: "🔥 14 kunlik streak" },
  { code: "streak_30", label: "👑 30 kunlik streak" },
  { code: "streak_60", label: "👑 60 kunlik streak" },
  { code: "streak_100", label: "👑 100 kunlik streak" },
  { code: "course_complete", label: "🏆 Kurs tamom" },
];

const ALL_CODES = [SHARE_CODE, ...BADGES.map((b) => b.code)];

export default function AdminBatchTexts() {
  const { t } = useTranslation();
  const { user } = useAuth();

  const [texts, setTexts] = useState<Record<string, string>>({});
  const [initial, setInitial] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sampleName, setSampleName] = useState("Aziz");

  useEffect(() => {
    let alive = true;
    // badge_messages isn't in the generated types yet (like xp_events); cast.
    (supabase as any)
      .from("badge_messages")
      .select("code, body_uz")
      .then(({ data, error }: { data: { code: string; body_uz: string }[] | null; error: { message: string } | null }) => {
        if (!alive) return;
        if (error) toast.error(error.message);
        const map: Record<string, string> = {};
        ALL_CODES.forEach((c) => (map[c] = ""));
        (data || []).forEach((r: { code: string; body_uz: string }) => {
          map[r.code] = r.body_uz ?? "";
        });
        setTexts(map);
        setInitial(map);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const dirtyCodes = useMemo(
    () => ALL_CODES.filter((c) => (texts[c] ?? "") !== (initial[c] ?? "")),
    [texts, initial]
  );

  const set = (code: string, v: string) => setTexts((m) => ({ ...m, [code]: v }));

  const preview = (code: string) => {
    const base = (texts[code] || "").replace(/\{\{name\}\}/g, sampleName || "Aziz");
    if (code === SHARE_CODE) return base;
    const share = (texts[SHARE_CODE] || "").replace(/\{\{name\}\}/g, sampleName || "Aziz");
    return share ? `${base}\n\n${share}` : base;
  };

  const save = async () => {
    if (!dirtyCodes.length) {
      toast.info(t("admin.batchTexts.noChanges", { defaultValue: "O'zgarishlar yo'q" }));
      return;
    }
    setSaving(true);
    const rows = dirtyCodes.map((code) => ({
      code,
      body_uz: texts[code] ?? "",
      updated_by: user?.id ?? null,
    }));
    const { error } = await (supabase as any)
      .from("badge_messages")
      .upsert(rows, { onConflict: "code" });
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setInitial({ ...texts });
    toast.success(t("admin.batchTexts.saved", { defaultValue: "Matnlar saqlandi ✓" }));
  };

  const renderCard = (code: string, label: string, isShare = false) => {
    const dirty = (texts[code] ?? "") !== (initial[code] ?? "");
    return (
      <Card key={code} className={`p-4 space-y-3 ${isShare ? "border-primary/40 bg-primary/[0.03]" : ""}`}>
        <div className="flex items-center justify-between gap-2">
          <Label className="text-sm font-semibold flex items-center gap-2">
            {isShare && <Megaphone className="h-4 w-4 text-primary" />}
            {label}
          </Label>
          {dirty && <span className="text-[11px] text-amber-500 font-medium">● saqlanmagan</span>}
        </div>
        {isShare && (
          <p className="text-xs text-muted-foreground">
            Bu matn <b>har bir nishon</b> ostiga qo'shiladi — nega ulashish kerakligini tushuntiradi va teglarni beradi.
          </p>
        )}
        <Textarea
          value={texts[code] ?? ""}
          onChange={(e) => set(code, e.target.value)}
          rows={isShare ? 7 : 5}
          className="text-sm leading-relaxed"
          placeholder="Matn kiriting…"
        />
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground select-none">
            Namunani ko'rish
          </summary>
          <div className="mt-2 rounded-md border border-border bg-muted/40 p-3 whitespace-pre-wrap text-[13px] leading-relaxed">
            {preview(code) || <span className="text-muted-foreground">—</span>}
          </div>
        </details>
      </Card>
    );
  };

  return (
    <PageShell>
      <div className="max-w-3xl space-y-6 pb-28">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            {t("admin.batchTexts.title", { defaultValue: "Batch matnlar" })}
          </h1>
          <p className="text-muted-foreground mt-1">
            {t("admin.batchTexts.subtitle", {
              defaultValue:
                "Nishon qo'lga kiritilganda Telegram'da yuboriladigan tabrik matnlari. Istalgan vaqtda tahrirlang.",
            })}
          </p>
        </div>

        <Card className="p-4 flex items-start gap-3 bg-muted/30">
          <Info className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
          <div className="text-sm text-muted-foreground space-y-1">
            <p>
              <code className="text-foreground">{"{{name}}"}</code> — talabaning ismi bilan almashtiriladi.
            </p>
            <p>Har bir nishon matni + pastdagi «Ulashish bloki» birga yuboriladi (rasm bilan).</p>
          </div>
        </Card>

        <div className="flex items-center gap-2">
          <Label className="text-sm text-muted-foreground shrink-0">Namuna ismi:</Label>
          <Input value={sampleName} onChange={(e) => setSampleName(e.target.value)} className="h-8 w-40" />
        </div>

        {loading ? (
          <p className="text-muted-foreground text-sm">Yuklanmoqda…</p>
        ) : (
          <div className="space-y-4">
            {renderCard(SHARE_CODE, "Ulashish bloki (umumiy)", true)}
            <div className="pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              Nishon matnlari
            </div>
            {BADGES.map((b) => renderCard(b.code, b.label))}
          </div>
        )}
      </div>

      {/* Sticky save bar */}
      <div className="fixed bottom-0 inset-x-0 z-30 border-t border-border bg-background/95 backdrop-blur md:pl-[220px]">
        <div className="max-w-3xl mx-auto px-4 md:px-6 py-3 flex items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">
            {dirtyCodes.length > 0
              ? `${dirtyCodes.length} ta saqlanmagan o'zgarish`
              : "Hammasi saqlangan"}
          </span>
          <Button onClick={save} disabled={saving || dirtyCodes.length === 0}>
            <Save className="h-4 w-4 mr-2" />
            {saving ? "Saqlanmoqda…" : "Saqlash"}
            {dirtyCodes.length > 0 ? ` (${dirtyCodes.length})` : ""}
          </Button>
        </div>
      </div>
    </PageShell>
  );
}
