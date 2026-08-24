import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { getSiteUrl } from "@/lib/siteUrl";
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
import { Eye, EyeOff, CheckCircle2, Circle, ExternalLink, Copy, Save } from "lucide-react";
import { TelegramDeeplinkButton } from "@/components/TelegramDeeplinkButton";
import { KnowledgeManager } from "@/components/admin/KnowledgeManager";
import { AppSettingsSection } from "@/components/admin/AppSettingsSection";
import { mutate } from "@/lib/mutate";

/* ──────────────────────────────────────────────────────────────────────────
 * Save registry — lets the 4 settings cards share one sticky "Save" button.
 * Each card registers a save fn + reports its dirty state; the parent saves
 * every dirty section in parallel on one click.
 * ────────────────────────────────────────────────────────────────────────── */
type SaverEntry = { label: string; save: () => Promise<boolean> };
type SaveCtx = {
  register: (id: string, entry: SaverEntry) => void;
  unregister: (id: string) => void;
  setDirty: (id: string, dirty: boolean) => void;
};
const SettingsSaveContext = createContext<SaveCtx | null>(null);

/** Card-side hook: keeps the parent registry in sync with this card's save fn + dirty flag. */
function useRegisterSaver(id: string, label: string, dirty: boolean, save: () => Promise<boolean>) {
  const ctx = useContext(SettingsSaveContext);
  // Re-register every render so the latest `save` closure (current state) is used.
  useEffect(() => {
    ctx?.register(id, { label, save });
  });
  useEffect(() => {
    return () => ctx?.unregister(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => {
    ctx?.setDirty(id, dirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, id]);
}

export default function AdminSettings() {
  const { t } = useTranslation();
  const { user } = useAuth();

  // Registry state
  const saversRef = useRef<Map<string, SaverEntry>>(new Map());
  const [dirtyMap, setDirtyMap] = useState<Record<string, boolean>>({});
  const [savingAll, setSavingAll] = useState(false);

  const register = useCallback((id: string, entry: SaverEntry) => {
    saversRef.current.set(id, entry);
  }, []);
  const unregister = useCallback((id: string) => {
    saversRef.current.delete(id);
    setDirtyMap((m) => {
      if (!(id in m)) return m;
      const n = { ...m }; delete n[id]; return n;
    });
  }, []);
  const setDirty = useCallback((id: string, dirty: boolean) => {
    setDirtyMap((m) => (m[id] === dirty ? m : { ...m, [id]: dirty }));
  }, []);

  const ctxValue = useMemo(() => ({ register, unregister, setDirty }), [register, unregister, setDirty]);
  const dirtyCount = Object.values(dirtyMap).filter(Boolean).length;

  const saveAll = async () => {
    const entries = Array.from(saversRef.current.entries()).filter(([id]) => dirtyMap[id]);
    if (entries.length === 0) { toast.info(t("admin.settings.noChanges", { defaultValue: "O'zgarishlar yo'q" })); return; }
    setSavingAll(true);
    const results = await Promise.all(entries.map(([, e]) => e.save().catch(() => false)));
    setSavingAll(false);
    const ok = results.filter(Boolean).length;
    if (ok === results.length) toast.success(t("admin.settings.savedToast"));
    else toast.error(`${results.length - ok} ta bo'lim saqlanmadi`);
  };

  return (
    <PageShell>
      <SettingsSaveContext.Provider value={ctxValue}>
        <div className="max-w-3xl space-y-6 pb-24">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">{t("admin.settings.title")}</h1>
            <p className="text-muted-foreground mt-1">{t("admin.settings.subtitle")}</p>
          </div>

          <AppSettingsSection />

          <TelegramBotCard userId={user?.id} />

          <TestTelegramCard />

          <EnrollmentMessageCard userId={user?.id} />
          <AIAssistantCard userId={user?.id} />
          <ContentProtectionCard userId={user?.id} />
        </div>

        {/* Sticky save bar for the Telegram / AI / Protection / Enrollment cards */}
        <div className="fixed bottom-0 inset-x-0 z-30 border-t border-border bg-background/95 backdrop-blur md:pl-[220px]">
          <div className="max-w-3xl mx-auto px-4 md:px-6 py-3 flex items-center justify-between gap-3">
            <span className="text-sm text-muted-foreground">
              {dirtyCount > 0
                ? t("admin.settings.unsavedN", { defaultValue: `${dirtyCount} ta saqlanmagan o'zgarish`, n: dirtyCount })
                : t("admin.settings.allSaved", { defaultValue: "Hammasi saqlangan" })}
            </span>
            <Button onClick={saveAll} disabled={savingAll || dirtyCount === 0}>
              <Save className="h-4 w-4 mr-2" />
              {savingAll ? t("admin.settings.saving") : t("admin.settings.save")}
              {dirtyCount > 0 ? ` (${dirtyCount})` : ""}
            </Button>
          </div>
        </div>
      </SettingsSaveContext.Provider>
    </PageShell>
  );
}

/* ───────── Telegram bot ───────── */
function TelegramBotCard({ userId }: { userId?: string }) {
  const { t } = useTranslation();
  const [botUsername, setBotUsername] = useState("");
  const [botToken, setBotToken] = useState("");
  const [savedUsername, setSavedUsername] = useState("");
  const [savedToken, setSavedToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [botInfo, setBotInfo] = useState<{ username?: string; first_name?: string } | null>(null);
  const domain = typeof window !== "undefined" ? window.location.hostname : "";

  useEffect(() => {
    supabase.from("platform_settings").select("value").eq("key", "telegram").maybeSingle().then(({ data }) => {
      const v = (data?.value as any) || {};
      setBotUsername(v.bot_username || "");
      setBotToken(v.bot_token || "");
      setSavedUsername(v.bot_username || "");
      setSavedToken(v.bot_token || "");
    });
  }, []);

  const cleanUsername = botUsername.replace(/^@/, "").trim();
  const dirty = cleanUsername !== savedUsername || botToken.trim() !== savedToken;

  const save = async (): Promise<boolean> => {
    const value = { bot_username: cleanUsername, bot_token: botToken.trim() };
    const r = await mutate(() => supabase.from("platform_settings").upsert({
      key: "telegram", value, updated_by: userId,
    } as any, { onConflict: "key" }), "key");
    if (!r.ok) { if (r.reason !== "impersonation_readonly") toast.error(r.message ?? "Saqlanmadi"); return r.ok; }
    setSavedUsername(cleanUsername);
    setSavedToken(botToken.trim());
    return true;
  };
  useRegisterSaver("telegram", t("admin.settings.telegramTitle"), dirty, save);

  const verifyToken = async () => {
    if (!botToken.trim()) return toast.error(t("admin.settings.enterTokenFirst"));
    setVerifying(true);
    setBotInfo(null);
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken.trim()}/getMe`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.description || "Invalid token");
      setBotInfo(json.result);
      toast.success(`@${json.result.username}`);
      if (!botUsername || botUsername.replace(/^@/, "") !== json.result.username) {
        setBotUsername(json.result.username);
      }
    } catch (e: any) {
      toast.error(e.message || t("admin.settings.couldNotVerify"));
    } finally {
      setVerifying(false);
    }
  };

  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success(t("admin.common.copied"));
  };

  const steps = useMemo(() => {
    const tokenEntered = !!botToken.trim();
    const usernameEntered = !!botUsername.trim();
    const saved = !!savedToken && !!savedUsername;
    const verified = !!botInfo;
    const domainSet = !!domain;
    return [
      { done: tokenEntered, label: t("admin.settings.step1") },
      { done: verified, label: t("admin.settings.step2") },
      { done: usernameEntered, label: t("admin.settings.step3") },
      { done: domainSet, label: t("admin.settings.step4", { domain }) },
      { done: saved, label: t("admin.settings.step5") },
      { done: false, label: t("admin.settings.step6"), interactive: true },
    ];
  }, [botToken, botUsername, savedToken, savedUsername, botInfo, domain, t]);

  return (
    <Card className="p-6 shadow-soft space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            {t("admin.settings.telegramTitle")}
            {dirty && <span className="text-[10px] font-normal text-amber-600 dark:text-amber-400">● o'zgartirildi</span>}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">{t("admin.settings.telegramSub")}</p>
        </div>
      </div>

      <div className="rounded-lg border bg-muted/30 p-4">
        <p className="font-medium mb-3">{t("admin.settings.checklist")}</p>
        <ol className="space-y-2">
          {steps.map((s, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              {s.done ? (
                <CheckCircle2 className="h-4 w-4 text-primary mt-0.5 shrink-0" />
              ) : (
                <Circle className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              )}
              <span className={s.done ? "text-foreground" : "text-muted-foreground"}>
                {i + 1}. {s.label}
              </span>
            </li>
          ))}
        </ol>
      </div>

      <div className="space-y-1.5">
        <Label>{t("admin.settings.botToken")}</Label>
        <div className="flex gap-2">
          <Input
            type={showToken ? "text" : "password"}
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder="123456:ABC-DEF..."
          />
          <Button type="button" variant="outline" size="icon" onClick={() => setShowToken((s) => !s)}>
            {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
          <Button type="button" variant="outline" onClick={verifyToken} disabled={verifying || !botToken.trim()}>
            {verifying ? t("admin.settings.verifying") : t("admin.settings.verify")}
          </Button>
        </div>
        {botInfo && (
          <p className="text-xs text-primary mt-1">
            ✓ {t("admin.settings.connectedTo", { username: botInfo.username, name: botInfo.first_name })}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label>{t("admin.settings.botUsername")}</Label>
        <Input value={botUsername} onChange={(e) => setBotUsername(e.target.value)} placeholder="AICreatorsBot" />
      </div>

      <div className="rounded-lg border bg-muted/30 p-4 text-sm space-y-3">
        <p className="font-medium">{t("admin.settings.botFatherTitle")}</p>
        <ol className="list-decimal list-inside space-y-2 text-muted-foreground">
          <li>
            <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="underline inline-flex items-center gap-1">
              @BotFather <ExternalLink className="h-3 w-3" />
            </a> → <code className="px-1 bg-background rounded">/mybots</code>
          </li>
          <li>
            <strong>Bot Settings → Domain</strong> (<code className="px-1 bg-background rounded">/setdomain</code>)
            <div className="mt-1 flex items-center gap-2">
              <code className="px-2 py-1 bg-background rounded border text-foreground">{domain}</code>
              <Button size="sm" variant="ghost" onClick={() => copy(domain)}><Copy className="h-3 w-3" /></Button>
            </div>
          </li>
          <li><strong>{t("admin.settings.verify")}</strong> → <strong>{t("admin.settings.save")}</strong></li>
        </ol>
      </div>
    </Card>
  );
}

/* ───────── Test telegram (no save) ───────── */
function TestTelegramCard() {
  const { t } = useTranslation();
  const [savedUsername, setSavedUsername] = useState("");
  useEffect(() => {
    supabase.from("platform_settings").select("value").eq("key", "telegram").maybeSingle().then(({ data }) => {
      const v = (data?.value as any) || {};
      setSavedUsername(v.bot_username || "");
    });
  }, []);
  return (
    <Card className="p-6 shadow-soft space-y-4">
      <div>
        <h2 className="text-lg font-semibold">{t("admin.settings.testTitle")}</h2>
        <p className="text-sm text-muted-foreground mt-1">{t("admin.settings.testDesc")}</p>
      </div>
      {savedUsername ? (
        <div className="rounded-lg border bg-muted/30 p-6 flex justify-center">
          <TelegramDeeplinkButton onSuccess={() => { toast.success("✓"); window.location.href = `${getSiteUrl()}/dashboard`; }} />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground italic">{t("admin.settings.saveBotFirst")}</p>
      )}
      <div className="text-xs text-muted-foreground space-y-1">
        <p><strong>{t("admin.settings.commonIssues")}</strong></p>
        <ul className="list-disc list-inside space-y-0.5">
          <li>{t("admin.settings.issue1")}</li>
          <li>{t("admin.settings.issue2")}</li>
          <li>{t("admin.settings.issue3")}</li>
        </ul>
      </div>
    </Card>
  );
}

function AIAssistantCard({ userId }: { userId?: string }) {
  const { t } = useTranslation();
  const [prompt, setPrompt] = useState("");
  const [savedPrompt, setSavedPrompt] = useState("");

  useEffect(() => {
    supabase.from("platform_settings").select("value").eq("key", "ai_assistant").maybeSingle().then(({ data }) => {
      const v = (data?.value as any) || {};
      setPrompt(v.system_prompt || "");
      setSavedPrompt(v.system_prompt || "");
    });
  }, []);

  const dirty = prompt !== savedPrompt;
  const save = async (): Promise<boolean> => {
    const r = await mutate(() => supabase.from("platform_settings").upsert({
      key: "ai_assistant",
      value: { system_prompt: prompt },
      updated_by: userId,
    } as any, { onConflict: "key" }), "key");
    if (!r.ok) { if (r.reason !== "impersonation_readonly") toast.error(r.message ?? "Saqlanmadi"); return r.ok; }
    setSavedPrompt(prompt);
    return true;
  };
  useRegisterSaver("ai_assistant", t("admin.settings.ai.title"), dirty, save);

  return (
    <Card className="p-6 shadow-soft space-y-5">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          {t("admin.settings.ai.title")}
          {dirty && <span className="text-[10px] font-normal text-amber-600 dark:text-amber-400">● o'zgartirildi</span>}
        </h2>
        <p className="text-sm text-muted-foreground mt-1">{t("admin.settings.ai.desc")}</p>
      </div>
      <div className="space-y-1.5">
        <Label>{t("admin.settings.ai.systemPrompt")}</Label>
        <textarea
          className="w-full min-h-[160px] rounded-md border bg-background p-3 text-sm font-mono"
          value={prompt} onChange={(e) => setPrompt(e.target.value)}
          placeholder={t("admin.settings.ai.promptPh")}
        />
        <p className="text-xs text-muted-foreground">
          {t("admin.settings.ai.promptTip")}
        </p>
      </div>

      <div className="space-y-2 pt-4 border-t">
        <div>
          <Label className="text-base">{t("admin.settings.ai.kbLabel")}</Label>
          <p className="text-xs text-muted-foreground mt-1">
            {t("admin.settings.ai.kbDesc")}
          </p>
        </div>
        <KnowledgeManager scope="platform" />
      </div>
    </Card>
  );
}

function ContentProtectionCard({ userId }: { userId?: string }) {
  const { t } = useTranslation();
  const PROTECTION_KEYS = [
    { key: "watermark", label: t("admin.settings.protection.watermarkLabel"), desc: t("admin.settings.protection.watermarkDesc") },
    { key: "no_right_click", label: t("admin.settings.protection.noRightClickLabel"), desc: t("admin.settings.protection.noRightClickDesc") },
    { key: "pause_on_blur", label: t("admin.settings.protection.pauseOnBlurLabel"), desc: t("admin.settings.protection.pauseOnBlurDesc") },
    { key: "devtools_detect", label: t("admin.settings.protection.devtoolsLabel"), desc: t("admin.settings.protection.devtoolsDesc") },
    { key: "hardened_controls", label: t("admin.settings.protection.hardenedLabel"), desc: t("admin.settings.protection.hardenedDesc") },
  ];
  const DEFAULTS = { watermark: true, no_right_click: true, pause_on_blur: true, devtools_detect: true, hardened_controls: true };
  const [val, setVal] = useState<Record<string, boolean>>(DEFAULTS);
  const [savedVal, setSavedVal] = useState<Record<string, boolean>>(DEFAULTS);

  useEffect(() => {
    supabase.from("platform_settings").select("value").eq("key", "content_protection").maybeSingle().then(({ data }) => {
      const v = (data?.value as any) || {};
      const loaded = {
        watermark: v.watermark ?? true,
        no_right_click: v.no_right_click ?? true,
        pause_on_blur: v.pause_on_blur ?? true,
        devtools_detect: v.devtools_detect ?? true,
        hardened_controls: v.hardened_controls ?? true,
      };
      setVal(loaded);
      setSavedVal(loaded);
    });
  }, []);

  const dirty = JSON.stringify(val) !== JSON.stringify(savedVal);
  const save = async (): Promise<boolean> => {
    const r = await mutate(() => supabase.from("platform_settings").upsert({
      key: "content_protection", value: val, updated_by: userId,
    } as any, { onConflict: "key" }), "key");
    if (!r.ok) { if (r.reason !== "impersonation_readonly") toast.error(r.message ?? "Saqlanmadi"); return r.ok; }
    setSavedVal(val);
    return true;
  };
  useRegisterSaver("content_protection", t("admin.settings.protection.title"), dirty, save);

  return (
    <Card className="p-6 shadow-soft space-y-4">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          {t("admin.settings.protection.title")}
          {dirty && <span className="text-[10px] font-normal text-amber-600 dark:text-amber-400">● o'zgartirildi</span>}
        </h2>
        <p className="text-sm text-muted-foreground mt-1">{t("admin.settings.protection.desc")}</p>
      </div>
      <ul className="space-y-3">
        {PROTECTION_KEYS.map((p) => (
          <li key={p.key} className="flex items-start justify-between gap-4 py-2 border-b last:border-b-0">
            <div className="min-w-0">
              <div className="font-medium text-sm">{p.label}</div>
              <div className="text-xs text-muted-foreground">{p.desc}</div>
            </div>
            <input
              type="checkbox"
              checked={val[p.key]}
              onChange={(e) => setVal((s) => ({ ...s, [p.key]: e.target.checked }))}
              className="mt-1 h-4 w-4"
            />
          </li>
        ))}
      </ul>
      <div className="rounded-lg border border-amber-300/40 bg-amber-50/50 dark:bg-amber-950/20 p-4 text-sm">
        <strong>{t("admin.settings.protection.note")}</strong> {t("admin.settings.protection.noteBody")}
      </div>
    </Card>
  );
}

type EnrollmentValue = {
  form_url: string;
  message: { uz: string; ru: string; en: string };
  button_label: { uz: string; ru: string; en: string };
};

const DEFAULT_ENROLLMENT: EnrollmentValue = {
  form_url: "https://forms.gle/o8Dcx1tA8ZBeGk6t9",
  message: {
    uz: "Sizning ma'lumotingiz platformaga kiritilmagan ko'rinadi. Pastdagi tugmani bosib, ma'lumotingiz qoldiring va sizga 24 soat ichida platformaga dostup beriladi",
    ru: "Похоже, вашей информации нет на платформе. Нажмите кнопку ниже, оставьте свои данные — доступ будет открыт в течение 24 часов",
    en: "Your information doesn't appear to be on the platform. Tap the button below, leave your details, and you'll get access within 24 hours",
  },
  button_label: {
    uz: "📝 Formani to'ldirish",
    ru: "📝 Заполнить форму",
    en: "📝 Fill out the form",
  },
};

function EnrollmentMessageCard({ userId }: { userId?: string }) {
  const { t, i18n } = useTranslation();
  const [value, setValue] = useState<EnrollmentValue>(DEFAULT_ENROLLMENT);
  const [savedValue, setSavedValue] = useState<EnrollmentValue>(DEFAULT_ENROLLMENT);
  const [previewLocale, setPreviewLocale] = useState<"uz" | "ru" | "en">(
    (i18n.language?.slice(0, 2) as "uz" | "ru" | "en") || "uz",
  );

  useEffect(() => {
    supabase
      .from("platform_settings")
      .select("value")
      .eq("key", "telegram_enrollment")
      .maybeSingle()
      .then(({ data }) => {
        const v = (data?.value as Partial<EnrollmentValue>) || {};
        const loaded = {
          form_url: v.form_url || DEFAULT_ENROLLMENT.form_url,
          message: { ...DEFAULT_ENROLLMENT.message, ...(v.message || {}) },
          button_label: { ...DEFAULT_ENROLLMENT.button_label, ...(v.button_label || {}) },
        };
        setValue(loaded);
        setSavedValue(loaded);
      });
  }, []);

  const dirty = JSON.stringify(value) !== JSON.stringify(savedValue);
  const save = async (): Promise<boolean> => {
    const url = value.form_url.trim();
    if (!/^https?:\/\//i.test(url)) {
      toast.error(t("admin.settings.enrollment.invalidUrl"));
      return false;
    }
    const next = { ...value, form_url: url };
    const r = await mutate(() => supabase.from("platform_settings").upsert(
      { key: "telegram_enrollment", value: next, updated_by: userId } as any,
      { onConflict: "key" },
    ), "key");
    if (!r.ok) { if (r.reason !== "impersonation_readonly") toast.error(r.message ?? "Saqlanmadi"); return r.ok; }
    setValue(next);
    setSavedValue(next);
    return true;
  };
  useRegisterSaver("telegram_enrollment", t("admin.settings.enrollment.title"), dirty, save);

  const setMsg = (loc: "uz" | "ru" | "en", v: string) =>
    setValue((prev) => ({ ...prev, message: { ...prev.message, [loc]: v } }));
  const setBtn = (loc: "uz" | "ru" | "en", v: string) =>
    setValue((prev) => ({ ...prev, button_label: { ...prev.button_label, [loc]: v } }));

  return (
    <Card className="p-6 shadow-soft space-y-5">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          {t("admin.settings.enrollment.title")}
          {dirty && <span className="text-[10px] font-normal text-amber-600 dark:text-amber-400">● o'zgartirildi</span>}
        </h2>
        <p className="text-sm text-muted-foreground mt-1">{t("admin.settings.enrollment.desc")}</p>
      </div>

      <div className="space-y-1.5">
        <Label>{t("admin.settings.enrollment.formUrl")}</Label>
        <Input
          type="url"
          value={value.form_url}
          onChange={(e) => setValue((p) => ({ ...p, form_url: e.target.value }))}
          placeholder={t("admin.settings.enrollment.formUrlPh")}
        />
      </div>

      {(["uz", "ru", "en"] as const).map((loc) => (
        <div key={loc} className="space-y-3 rounded-lg border bg-muted/20 p-4">
          <div className="space-y-1.5">
            <Label>{t(`admin.settings.enrollment.message${loc.charAt(0).toUpperCase() + loc.slice(1)}` as any)}</Label>
            <Textarea
              rows={3}
              value={value.message[loc]}
              onChange={(e) => setMsg(loc, e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t(`admin.settings.enrollment.button${loc.charAt(0).toUpperCase() + loc.slice(1)}` as any)}</Label>
            <Input value={value.button_label[loc]} onChange={(e) => setBtn(loc, e.target.value)} />
          </div>
        </div>
      ))}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs uppercase tracking-wide text-muted-foreground">
            {t("admin.settings.enrollment.preview")}
          </Label>
          <div className="flex gap-1">
            {(["uz", "ru", "en"] as const).map((loc) => (
              <Button
                key={loc}
                size="sm"
                variant={previewLocale === loc ? "default" : "outline"}
                onClick={() => setPreviewLocale(loc)}
                className="h-7 px-2 text-xs uppercase"
              >
                {loc}
              </Button>
            ))}
          </div>
        </div>
        <div className="rounded-2xl bg-[#229ED9]/10 border border-[#229ED9]/20 p-4 space-y-3 max-w-md">
          <p className="text-sm whitespace-pre-wrap leading-relaxed">{value.message[previewLocale]}</p>
          <a
            href={value.form_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center justify-center w-full rounded-md bg-[#229ED9] hover:bg-[#1c8cc2] text-white text-sm font-medium py-2 px-4"
          >
            {value.button_label[previewLocale]}
          </a>
        </div>
      </div>
    </Card>
  );
}
