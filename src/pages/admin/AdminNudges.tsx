import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageShell } from "@/components/Layout";
import { toast } from "sonner";
import { saveWithToast } from "@/lib/mutate";

type NudgeType = "inactive_3d" | "inactive_7d" | "stuck_lesson" | "module_complete";
const TYPES: NudgeType[] = ["inactive_3d", "inactive_7d", "stuck_lesson", "module_complete"];
const LOCALES = ["uz", "ru", "en"] as const;

export function NudgesPanel() {
  const [cronActive, setCronActive] = useState(false);
  const [stats, setStats] = useState<Record<string, { sent: number; clicked: number }>>({});
  const [optOuts, setOptOuts] = useState(0);
  const [recent, setRecent] = useState<any[]>([]);
  const [templates, setTemplates] = useState<any>({});
  const [testType, setTestType] = useState<NudgeType>("inactive_3d");
  const [busy, setBusy] = useState(false);

  async function load() {
    const since = new Date(Date.now() - 7 * 86400_000).toISOString();
    const { data: cron } = await supabase.rpc("nudge_cron_status");
    setCronActive(!!cron?.[0]?.active);
    const { data: logs } = await supabase
      .from("nudge_log")
      .select("nudge_type, sent_at, clicked_at, profile_id")
      .gte("sent_at", since);
    const s: Record<string, { sent: number; clicked: number }> = {};
    for (const t of TYPES) s[t] = { sent: 0, clicked: 0 };
    (logs || []).forEach((l: any) => {
      s[l.nudge_type] = s[l.nudge_type] || { sent: 0, clicked: 0 };
      s[l.nudge_type].sent++;
      if (l.clicked_at) s[l.nudge_type].clicked++;
    });
    setStats(s);
    const { count: oo } = await supabase
      .from("nudge_preferences")
      .select("profile_id", { count: "exact", head: true })
      .eq("opt_in", false);
    setOptOuts(oo || 0);
    const { data: rec } = await supabase
      .from("nudge_log")
      .select("id, nudge_type, sent_at, clicked_at, profile_id, error")
      .order("sent_at", { ascending: false })
      .limit(50);
    // Resolve names
    const ids = Array.from(new Set((rec || []).map((r: any) => r.profile_id)));
    const names: Record<string, string> = {};
    if (ids.length) {
      const { data: profs } = await supabase.from("profiles").select("id, name, email").in("id", ids);
      (profs || []).forEach((p: any) => (names[p.id] = p.name || p.email));
    }
    setRecent((rec || []).map((r: any) => ({ ...r, student_name: names[r.profile_id] || r.profile_id })));

    const { data: tpl } = await supabase.from("platform_settings").select("value").eq("key", "nudge_templates").maybeSingle();
    setTemplates(tpl?.value || {});
  }

  useEffect(() => {
    load();
  }, []);

  async function toggleCron(v: boolean) {
    const { error } = await supabase.rpc("nudge_cron_set_enabled", { _enabled: v });
    if (error) return toast.error(error.message);
    setCronActive(v);
    toast.success(v ? "Cron yoqildi" : "Cron o'chirildi");
  }

  async function runTest() {
    setBusy(true);
    const { data, error } = await supabase.functions.invoke("detect-and-nudge", {
      body: { mode: "test", nudge_type: testType },
    });
    setBusy(false);
    if (error) return toast.error(error.message);
    if (!(data as any)?.ok) return toast.error("Test failed: " + JSON.stringify(data));
    toast.success("Test nudge yuborildi @alikhanova_admin ga");
    load();
  }

  async function saveTemplates() {
    const r = await saveWithToast(
      () => supabase.from("platform_settings").update({ value: templates }).eq("key", "nudge_templates"),
      { success: "Saqlandi", returning: "key" },
    );
    if (!r.ok) return;
  }

  function updateTpl(type: NudgeType, locale: string, field: "body" | "button", v: string) {
    setTemplates((prev: any) => ({
      ...prev,
      [type]: { ...(prev[type] || {}), [locale]: { ...((prev[type] || {})[locale] || {}), [field]: v } },
    }));
  }

  const totalSent = Object.values(stats).reduce((a, b) => a + b.sent, 0);
  const totalClicked = Object.values(stats).reduce((a, b) => a + b.clicked, 0);
  const overallCtr = totalSent ? Math.round((totalClicked / totalSent) * 100) : 0;

  return (
    <div className="space-y-6">
      <Card className="p-4 grid sm:grid-cols-3 gap-4">
        <div>
          <div className="text-xs text-muted-foreground">Yuborilgan (7 kun)</div>
          <div className="text-2xl font-bold">{totalSent}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">CTR (7 kun)</div>
          <div className="text-2xl font-bold">{overallCtr}%</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Opt-out</div>
          <div className="text-2xl font-bold">{optOuts}</div>
        </div>
      </Card>

      <Card className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-semibold">Avtomatik cron (har soatda)</div>
            <div className="text-xs text-muted-foreground">Yoqishdan oldin test qiling.</div>
          </div>
          <Switch checked={cronActive} onCheckedChange={toggleCron} />
        </div>
      </Card>

      <Card className="p-4 border-yellow-500/40">
        <div className="font-semibold mb-2">🧪 Test on me first (@alikhanova_admin)</div>
        <div className="flex items-center gap-2">
          <Select value={testType} onValueChange={(v) => setTestType(v as NudgeType)}>
            <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              {TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button onClick={runTest} disabled={busy}>{busy ? "Yuborilmoqda..." : "Test yuborish"}</Button>
        </div>
      </Card>

      <Card className="p-4">
        <div className="font-semibold mb-3">Type bo'yicha statistika (7 kun)</div>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-muted-foreground"><th>Type</th><th>Sent</th><th>Clicked</th><th>CTR</th></tr></thead>
          <tbody>
            {TYPES.map((t) => {
              const s = stats[t] || { sent: 0, clicked: 0 };
              const ctr = s.sent ? Math.round((s.clicked / s.sent) * 100) : 0;
              return <tr key={t} className="border-t"><td className="py-2">{t}</td><td>{s.sent}</td><td>{s.clicked}</td><td>{ctr}%</td></tr>;
            })}
          </tbody>
        </table>
      </Card>

      <Card className="p-4">
        <div className="font-semibold mb-3">So'nggi 50 ta eslatma</div>
        <div className="overflow-auto max-h-96">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-background"><tr className="text-left text-muted-foreground"><th>O'quvchi</th><th>Type</th><th>Yuborilgan</th><th>Bosilgan</th></tr></thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="py-2">{r.student_name}</td>
                  <td>{r.nudge_type}</td>
                  <td>{new Date(r.sent_at).toLocaleString()}</td>
                  <td>{r.clicked_at ? "✅" : r.error ? "❌" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="p-4 space-y-4">
        <div className="font-semibold">Xabar shablonlari</div>
        {TYPES.map((t) => (
          <div key={t} className="space-y-2 border-t pt-3">
            <div className="font-medium">{t}</div>
            {LOCALES.map((loc) => {
              const block = (templates[t] || {})[loc] || { body: "", button: "" };
              return (
                <div key={loc} className="grid sm:grid-cols-[80px_1fr_180px] gap-2 items-start">
                  <Label className="pt-2">{loc.toUpperCase()}</Label>
                  <Textarea rows={2} value={block.body || ""} onChange={(e) => updateTpl(t, loc, "body", e.target.value)} />
                  <Input value={block.button || ""} onChange={(e) => updateTpl(t, loc, "button", e.target.value)} placeholder="Button" />
                </div>
              );
            })}
          </div>
        ))}
        <Button onClick={saveTemplates}>Saqlash</Button>
      </Card>
    </div>
  );
}

export default function AdminNudges() {
  return (
    <PageShell>
      <div>
        <h1 className="text-2xl font-bold">🔔 Smart eslatmalar (nudges)</h1>
        <p className="text-sm text-muted-foreground">Rate-limited, opt-out, quiet hours.</p>
      </div>
      <div className="mt-6">
        <NudgesPanel />
      </div>
    </PageShell>
  );
}
