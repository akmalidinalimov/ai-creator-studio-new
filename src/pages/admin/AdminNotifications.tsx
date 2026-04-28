import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Loader2, Eye, Save } from "lucide-react";

type Locale = "uz" | "ru" | "en";
const LOCALES: Locale[] = ["uz", "ru", "en"];

interface TemplateRow {
  template_key: string;
  locale: Locale;
  body: string;
  button_label: string | null;
  updated_at: string;
}
interface VariableRow {
  template_key: string;
  variable_name: string;
  description: string | null;
}

const TEMPLATE_ORDER = [
  "daily_reminder",
  "streak_warning",
  "lesson_complete",
  "module_complete",
  "course_complete",
  "inactive_3",
  "inactive_7",
  "inactive_14",
  "settings_confirm",
];

const TEMPLATE_LABEL: Record<string, string> = {
  daily_reminder: "Daily reminder",
  streak_warning: "Streak warning",
  lesson_complete: "Lesson complete",
  module_complete: "Module complete",
  course_complete: "Course complete",
  inactive_3: "Inactive — day 3",
  inactive_7: "Inactive — day 7",
  inactive_14: "Inactive — day 14",
  settings_confirm: "Settings confirmation",
};

function interpolate(s: string, vars: Record<string, string | number>): string {
  return s.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => String(vars[k] ?? ""));
}

const SAMPLE_VARS: Record<string, string | number> = {
  first_name: "Aziz",
  full_name: "Aziz Karimov",
  streak_days: 5,
  lesson_title: "Promptlarni yozish",
  next_lesson_title: "AI agentlar bilan ishlash",
  module_number: 2,
  lessons_done: 4,
  lessons_total: 5,
  minutes: 32,
  course_title: "AI Creators",
};

export default function AdminNotifications() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [rows, setRows] = useState<TemplateRow[]>([]);
  const [vars, setVars] = useState<VariableRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { body: string; button_label: string }>>({});
  const [preview, setPreview] = useState<{ key: string; locale: Locale; text: string; button: string } | null>(null);

  const reload = async () => {
    setLoading(true);
    const [tRes, vRes] = await Promise.all([
      supabase.from("notification_templates").select("*").order("template_key"),
      supabase.from("notification_template_variables").select("*"),
    ]);
    if (tRes.error) toast.error(tRes.error.message);
    setRows((tRes.data || []) as TemplateRow[]);
    setVars((vRes.data || []) as VariableRow[]);
    const d: Record<string, { body: string; button_label: string }> = {};
    for (const r of (tRes.data || []) as TemplateRow[]) {
      d[`${r.template_key}:${r.locale}`] = { body: r.body, button_label: r.button_label || "" };
    }
    setDrafts(d);
    setLoading(false);
  };
  useEffect(() => { reload(); }, []);

  const variablesByKey = useMemo(() => {
    const m = new Map<string, VariableRow[]>();
    for (const v of vars) {
      if (!m.has(v.template_key)) m.set(v.template_key, []);
      m.get(v.template_key)!.push(v);
    }
    return m;
  }, [vars]);

  const handleSave = async (key: string, locale: Locale) => {
    const id = `${key}:${locale}`;
    const draft = drafts[id];
    if (!draft) return;
    setSaving(id);
    const { error } = await supabase
      .from("notification_templates")
      .update({ body: draft.body, button_label: draft.button_label || null })
      .eq("template_key", key)
      .eq("locale", locale);
    setSaving(null);
    if (error) { toast.error(error.message); return; }
    toast.success("Saved");
    reload();
  };

  const handlePreview = async (key: string, locale: Locale) => {
    const id = `${key}:${locale}`;
    const draft = drafts[id];
    if (!draft) return;
    let firstName = "Admin";
    let fullName = "Admin User";
    if (user) {
      const { data: prof } = await supabase.from("profiles").select("name, last_name").eq("id", user.id).maybeSingle();
      firstName = prof?.name || firstName;
      fullName = [prof?.name, prof?.last_name].filter(Boolean).join(" ") || fullName;
    }
    const ctx = { ...SAMPLE_VARS, first_name: firstName, full_name: fullName };
    setPreview({
      key, locale,
      text: interpolate(draft.body, ctx),
      button: interpolate(draft.button_label, ctx),
    });
  };

  const orderedKeys = TEMPLATE_ORDER.filter((k) => rows.some((r) => r.template_key === k));

  return (
    <PageShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Bot notification templates</h1>
          <p className="text-muted-foreground mt-1">Edit message bodies and button labels per locale. Changes apply on the next bot send.</p>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : (
          <div className="space-y-6">
            {orderedKeys.map((key) => {
              const supportedVars = variablesByKey.get(key) || [];
              return (
                <Card key={key} className="p-5 space-y-4 shadow-soft">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div>
                      <h2 className="font-semibold text-lg">{TEMPLATE_LABEL[key] || key}</h2>
                      <p className="text-xs text-muted-foreground font-mono">{key}</p>
                    </div>
                    {supportedVars.length > 0 && (
                      <div className="text-xs text-muted-foreground max-w-xl text-right">
                        Variables:{" "}
                        {supportedVars.map((v) => (
                          <code key={v.variable_name} className="ml-1 px-1.5 py-0.5 bg-muted rounded">
                            {`{{${v.variable_name}}}`}
                          </code>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                    {LOCALES.map((locale) => {
                      const id = `${key}:${locale}`;
                      const draft = drafts[id];
                      if (!draft) return (
                        <div key={locale} className="border rounded-md p-3 text-xs text-muted-foreground">
                          {locale.toUpperCase()} — missing
                        </div>
                      );
                      return (
                        <div key={locale} className="space-y-2 border rounded-md p-3">
                          <div className="flex items-center justify-between">
                            <Label className="uppercase text-xs">{locale}</Label>
                            <div className="flex gap-1">
                              <Button size="sm" variant="ghost" onClick={() => handlePreview(key, locale)}>
                                <Eye className="h-3.5 w-3.5" /> Preview
                              </Button>
                              <Button size="sm" onClick={() => handleSave(key, locale)} disabled={saving === id}>
                                {saving === id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                                Save
                              </Button>
                            </div>
                          </div>
                          <Textarea
                            rows={6}
                            value={draft.body}
                            onChange={(e) => setDrafts((d) => ({ ...d, [id]: { ...d[id], body: e.target.value } }))}
                            className="font-mono text-xs"
                          />
                          <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">Button label</Label>
                            <Input
                              value={draft.button_label}
                              onChange={(e) => setDrafts((d) => ({ ...d, [id]: { ...d[id], button_label: e.target.value } }))}
                              placeholder="(optional)"
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </Card>
              );
            })}
          </div>
        )}

        {preview && (
          <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setPreview(null)}>
            <Card className="max-w-md w-full p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">Preview — {preview.key} <span className="text-xs uppercase text-muted-foreground">{preview.locale}</span></h3>
                <Button variant="ghost" size="sm" onClick={() => setPreview(null)}>Close</Button>
              </div>
              <div className="border rounded-md p-4 bg-muted/30 whitespace-pre-wrap text-sm" dangerouslySetInnerHTML={{ __html: preview.text }} />
              {preview.button && (
                <div className="flex justify-center">
                  <Button variant="secondary" size="sm" disabled>{preview.button}</Button>
                </div>
              )}
            </Card>
          </div>
        )}
      </div>
    </PageShell>
  );
}
