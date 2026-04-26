import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Eye, EyeOff, CheckCircle2, Circle, ExternalLink, Copy } from "lucide-react";
import { TelegramLoginButton } from "@/components/TelegramLoginButton";

export default function AdminSettings() {
  const { user } = useAuth();
  const [botUsername, setBotUsername] = useState("");
  const [botToken, setBotToken] = useState("");
  const [savedUsername, setSavedUsername] = useState("");
  const [savedToken, setSavedToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);
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

  const save = async () => {
    setSaving(true);
    const cleanUsername = botUsername.replace(/^@/, "").trim();
    const value = { bot_username: cleanUsername, bot_token: botToken.trim() };
    const { error } = await supabase.from("platform_settings").upsert({
      key: "telegram", value, updated_by: user?.id,
    } as any, { onConflict: "key" });
    setSaving(false);
    if (error) return toast.error(error.message);
    setSavedUsername(cleanUsername);
    setSavedToken(botToken.trim());
    toast.success("Saved");
  };

  const verifyToken = async () => {
    if (!botToken.trim()) return toast.error("Enter a bot token first");
    setVerifying(true);
    setBotInfo(null);
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken.trim()}/getMe`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.description || "Invalid token");
      setBotInfo(json.result);
      toast.success(`Connected to @${json.result.username}`);
      // Auto-fill username if empty or mismatched
      if (!botUsername || botUsername.replace(/^@/, "") !== json.result.username) {
        setBotUsername(json.result.username);
      }
    } catch (e: any) {
      toast.error(e.message || "Could not verify token");
    } finally {
      setVerifying(false);
    }
  };

  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success("Copied");
  };

  const steps = useMemo(() => {
    const tokenEntered = !!botToken.trim();
    const usernameEntered = !!botUsername.trim();
    const saved = !!savedToken && !!savedUsername;
    const verified = !!botInfo;
    const domainSet = !!domain;
    return [
      { done: tokenEntered, label: "Paste your bot token" },
      { done: verified, label: "Verify token with Telegram (click Verify)" },
      { done: usernameEntered, label: "Bot username filled in" },
      { done: domainSet, label: `Set domain in @BotFather → /setdomain → ${domain}` },
      { done: saved && saved === !!savedToken, label: "Save settings" },
      { done: false, label: "Click the Telegram login button below to test end-to-end", interactive: true },
    ];
  }, [botToken, botUsername, savedToken, savedUsername, botInfo, domain]);

  return (
    <PageShell>
      <div className="max-w-3xl space-y-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
          <p className="text-muted-foreground mt-1">Platform integrations and configuration.</p>
        </div>

        <Card className="p-6 shadow-soft space-y-5">
          <div>
            <h2 className="text-lg font-semibold">Telegram Login</h2>
            <p className="text-sm text-muted-foreground mt-1">Let students sign in with their Telegram account.</p>
          </div>

          {/* Setup checklist */}
          <div className="rounded-lg border bg-muted/30 p-4">
            <p className="font-medium mb-3">Setup checklist</p>
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
            <Label>Telegram bot token</Label>
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
                {verifying ? "Verifying…" : "Verify"}
              </Button>
            </div>
            {botInfo && (
              <p className="text-xs text-primary mt-1">
                ✓ Connected to @{botInfo.username} ({botInfo.first_name})
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Telegram bot username</Label>
            <Input value={botUsername} onChange={(e) => setBotUsername(e.target.value)} placeholder="AICreatorsBot" />
          </div>

          <div className="rounded-lg border bg-muted/30 p-4 text-sm space-y-3">
            <p className="font-medium">Configure your bot in @BotFather</p>
            <ol className="list-decimal list-inside space-y-2 text-muted-foreground">
              <li>
                Open <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="underline inline-flex items-center gap-1">
                  @BotFather <ExternalLink className="h-3 w-3" />
                </a> and send <code className="px-1 bg-background rounded">/mybots</code> → pick your bot.
              </li>
              <li>
                Choose <strong>Bot Settings → Domain</strong> (or send <code className="px-1 bg-background rounded">/setdomain</code>) and paste:
                <div className="mt-1 flex items-center gap-2">
                  <code className="px-2 py-1 bg-background rounded border text-foreground">{domain}</code>
                  <Button size="sm" variant="ghost" onClick={() => copy(domain)}><Copy className="h-3 w-3" /></Button>
                </div>
              </li>
              <li>Come back here, click <strong>Verify</strong>, then <strong>Save</strong>.</li>
              <li>To link a student, set their <code className="px-1 bg-background rounded">telegram_username</code> on the Users page.</li>
            </ol>
          </div>

          <div className="flex justify-end">
            <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
          </div>
        </Card>

        {/* End-to-end test */}
        <Card className="p-6 shadow-soft space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Test the login button</h2>
            <p className="text-sm text-muted-foreground mt-1">
              The official Telegram widget should appear below once the username is saved and the domain is set in @BotFather.
              Click it to run a real auth round-trip.
            </p>
          </div>
          {savedUsername ? (
            <div className="rounded-lg border bg-muted/30 p-6 flex justify-center">
              <TelegramLoginButton onAuth={async (tg) => {
                try {
                  const { data, error } = await supabase.functions.invoke("telegram-auth", {
                    body: { tg, redirectTo: `${window.location.origin}/dashboard` },
                  });
                  if (error) throw error;
                  if ((data as any)?.url) {
                    toast.success("Auth verified — redirecting…");
                    window.location.href = (data as any).url;
                  } else {
                    toast.error((data as any)?.error || "Unexpected response");
                  }
                } catch (e: any) {
                  toast.error(e.message || "Telegram auth failed");
                }
              }} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground italic">Save a bot username above to render the login widget.</p>
          )}
          <div className="text-xs text-muted-foreground space-y-1">
            <p><strong>Common issues:</strong></p>
            <ul className="list-disc list-inside space-y-0.5">
              <li>Widget doesn't render → domain not set in @BotFather, or you're on a different domain than configured.</li>
              <li>"Bot domain invalid" → re-run <code>/setdomain</code> with the exact host above.</li>
              <li>"No account linked" → add the user's <code>telegram_username</code> on the Users page first.</li>
            </ul>
          </div>
        </Card>
        </Card>

        <AIAssistantCard userId={user?.id} />
        <ContentProtectionCard userId={user?.id} />
      </div>
    </PageShell>
  );
}

function AIAssistantCard({ userId }: { userId?: string }) {
  const [prompt, setPrompt] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    supabase.from("platform_settings").select("value").eq("key", "ai_assistant").maybeSingle().then(({ data }) => {
      const v = (data?.value as any) || {};
      setPrompt(v.system_prompt || "");
      setPaths(Array.isArray(v.knowledge_paths) ? v.knowledge_paths : []);
    });
  }, []);

  const save = async () => {
    setSaving(true);
    const { error } = await supabase.from("platform_settings").upsert({
      key: "ai_assistant",
      value: { system_prompt: prompt, knowledge_paths: paths },
      updated_by: userId,
    } as any, { onConflict: "key" });
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("AI assistant settings saved");
  };

  const upload = async (file: File) => {
    const path = `platform/${Date.now()}-${file.name.replace(/[^a-z0-9._-]/gi, "_")}`;
    const { error } = await supabase.storage.from("ai-knowledge").upload(path, file, { upsert: false });
    if (error) return toast.error(error.message);
    setPaths((p) => [...p, path]);
    toast.success("File uploaded");
  };

  return (
    <Card className="p-6 shadow-soft space-y-4">
      <div>
        <h2 className="text-lg font-semibold">AI Study Assistant</h2>
        <p className="text-sm text-muted-foreground mt-1">Customize the assistant's tone, scope, and knowledge for all courses.</p>
      </div>
      <div className="space-y-1.5">
        <Label>System prompt</Label>
        <textarea
          className="w-full min-h-[160px] rounded-md border bg-background p-3 text-sm font-mono"
          value={prompt} onChange={(e) => setPrompt(e.target.value)}
          placeholder="You are a friendly study assistant for {course_title}. Answer in the student's chosen language. Use the lesson context when helpful: {transcript}. Be concise, encouraging, and ask follow-up questions when appropriate."
        />
        <p className="text-xs text-muted-foreground">
          Tip: include lines like "Refuse to discuss topics unrelated to this course" to keep the tutor on-topic. Use <code>{"{course_title}"}</code>, <code>{"{transcript}"}</code>, <code>{"{language}"}</code> as variables we'll substitute at runtime.
        </p>
      </div>

      <div className="space-y-2">
        <Label>Knowledge files ({paths.length})</Label>
        <ul className="text-sm space-y-1">
          {paths.length === 0 && <li className="text-xs text-muted-foreground italic">No files yet. Upload PDFs or text files to add reference context to every chat.</li>}
          {paths.map((p, i) => (
            <li key={p} className="flex items-center justify-between gap-2 px-3 py-2 rounded border bg-muted/30">
              <span className="truncate text-xs">{p.split("/").pop()}</span>
              <button className="text-destructive text-xs" onClick={() => setPaths(paths.filter((_, j) => j !== i))}>Remove</button>
            </li>
          ))}
        </ul>
        <input type="file" accept=".pdf,.txt,.md" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.currentTarget.value = ""; }} className="text-sm" />
        <p className="text-xs text-muted-foreground">First 8 KB of each file's text is included in every chat. Per-course overrides available in each course's editor.</p>
      </div>

      <div className="flex justify-end">
        <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
      </div>
    </Card>
  );
}

const PROTECTION_KEYS = [
  { key: "watermark", label: "Forensic watermark", desc: "Translucent overlay with student email + timestamp on every video." },
  { key: "no_right_click", label: "Disable right-click", desc: "Block context menu on the video and lesson container." },
  { key: "pause_on_blur", label: "Pause on blur", desc: "Pause video when the tab loses focus or is hidden." },
  { key: "devtools_detect", label: "DevTools detection", desc: "Pause and overlay when developer tools are detected." },
  { key: "hardened_controls", label: "Hardened video controls", desc: "Disable download, picture-in-picture, remote playback." },
];

function ContentProtectionCard({ userId }: { userId?: string }) {
  const [val, setVal] = useState<Record<string, boolean>>({
    watermark: true, no_right_click: true, pause_on_blur: true, devtools_detect: true, hardened_controls: true,
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    supabase.from("platform_settings").select("value").eq("key", "content_protection").maybeSingle().then(({ data }) => {
      const v = (data?.value as any) || {};
      setVal({
        watermark: v.watermark ?? true,
        no_right_click: v.no_right_click ?? true,
        pause_on_blur: v.pause_on_blur ?? true,
        devtools_detect: v.devtools_detect ?? true,
        hardened_controls: v.hardened_controls ?? true,
      });
    });
  }, []);

  const save = async () => {
    setSaving(true);
    const { error } = await supabase.from("platform_settings").upsert({
      key: "content_protection", value: val, updated_by: userId,
    } as any, { onConflict: "key" });
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("Content protection saved");
  };

  return (
    <Card className="p-6 shadow-soft space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Content Protection</h2>
        <p className="text-sm text-muted-foreground mt-1">Layered defenses against screen recording on lesson playback. Admin pages are unaffected.</p>
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
        <strong>Note:</strong> Browsers cannot fully prevent screen recording. These layers make it harder and let you trace any leak via the watermark.
        For maximum protection, use <strong>Mux</strong> or <strong>Bunny Stream</strong> with their built-in DRM (Widevine / FairPlay) — paid feature, but the only true block.
      </div>
      <div className="flex justify-end">
        <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
      </div>
    </Card>
  );
}

