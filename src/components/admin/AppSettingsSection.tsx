import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight, RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";
import { SETTING_DEFAULTS, clearSettingCache } from "@/lib/settings";

interface Row { key: string; value: any; description: string | null }

const SECTIONS: { id: string; title: string; prefix: string }[] = [
  { id: "homework",       title: "📝 Uy vazifalari",  prefix: "homework." },
  { id: "engagement",     title: "🔥 Faollik",         prefix: "engagement." },
  { id: "notifications",  title: "🔔 Bildirishnomalar",prefix: "notifications." },
  { id: "re_engagement",  title: "🎯 Reaktivatsiya",   prefix: "re_engagement." },
  { id: "leaderboard",    title: "🏆 Reyting",         prefix: "leaderboard." },
  { id: "bot",            title: "🤖 Bot",             prefix: "bot." },
];

function inferKind(value: any): "bool" | "number" | "string" | "json" {
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  return "json";
}

export function AppSettingsSection() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [drafts, setDrafts] = useState<Record<string, any>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({ homework: true });
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    const { data, error } = await supabase.from("app_settings" as any).select("key, value, description");
    if (error) { toast.error(error.message); return; }
    const r = (data as any as Row[]) || [];
    setRows(r);
    const d: Record<string, any> = {};
    r.forEach((x) => { d[x.key] = x.value; });
    setDrafts(d);
  };
  useEffect(() => { load(); }, []);

  const grouped = useMemo(() => {
    const m: Record<string, Row[]> = {};
    SECTIONS.forEach((s) => (m[s.id] = []));
    rows.forEach((r) => {
      const sec = SECTIONS.find((s) => r.key.startsWith(s.prefix));
      if (sec) m[sec.id].push(r);
    });
    Object.values(m).forEach((arr) => arr.sort((a, b) => a.key.localeCompare(b.key)));
    return m;
  }, [rows]);

  const dirtyKeys = useMemo(() => {
    return rows.filter((r) => JSON.stringify(drafts[r.key]) !== JSON.stringify(r.value)).map((r) => r.key);
  }, [rows, drafts]);

  const saveAll = async () => {
    if (dirtyKeys.length === 0) { toast.info("O'zgarishlar yo'q"); return; }
    setBusy("__all__");
    const now = new Date().toISOString();
    const errors: string[] = [];
    for (const key of dirtyKeys) {
      const { error } = await supabase.from("app_settings" as any).update({
        value: drafts[key], updated_by: user?.id, updated_at: now,
      }).eq("key", key);
      if (error) errors.push(`${key}: ${error.message}`);
      else clearSettingCache(key);
    }
    setBusy(null);
    if (errors.length) toast.error(`Xato: ${errors.length} ta`);
    else toast.success(`✅ ${dirtyKeys.length} ta sozlama saqlandi`);
    load();
  };

  const reset = (key: string) => {
    const def = SETTING_DEFAULTS[key];
    if (def === undefined) return;
    setDrafts((d) => ({ ...d, [key]: def }));
  };

  return (
    <Card className="p-5 space-y-3">
      <div className="sticky top-14 z-20 -mx-5 -mt-5 mb-2 bg-background/95 backdrop-blur border-b px-5 py-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">⚙️ Platforma sozlamalari</h2>
          <p className="text-xs text-muted-foreground">{rows.length} kalit{dirtyKeys.length > 0 ? ` · ${dirtyKeys.length} ta o'zgartirildi` : ""}</p>
        </div>
        <Button onClick={saveAll} disabled={busy === "__all__" || dirtyKeys.length === 0} size="lg">
          <Save className="h-4 w-4 mr-2" />
          Hammasini saqlash{dirtyKeys.length > 0 ? ` (${dirtyKeys.length})` : ""}
        </Button>
      </div>

      <div className="space-y-2">
        {SECTIONS.map((s) => {
          const items = grouped[s.id] || [];
          if (!items.length) return null;
          const isOpen = !!open[s.id];
          return (
            <div key={s.id} className="border rounded-lg">
              <button
                type="button"
                onClick={() => setOpen((o) => ({ ...o, [s.id]: !o[s.id] }))}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/40"
              >
                <span className="font-medium">{s.title}</span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  {items.length} kalit
                  {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </span>
              </button>
              {isOpen && (
                <div className="px-4 pb-4 space-y-3">
                  {items.map((r) => {
                    const kind = inferKind(SETTING_DEFAULTS[r.key] ?? r.value);
                    const v = drafts[r.key];
                    const set = (next: any) => setDrafts((d) => ({ ...d, [r.key]: next }));
                    const dirty = dirtyKeys.includes(r.key);
                    return (
                      <div key={r.key} className="border-t pt-3 first:border-t-0 first:pt-0">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <Label className="font-mono text-xs flex items-center gap-2">
                              {r.key}
                              {dirty && <span className="text-[10px] font-sans font-normal text-amber-600 dark:text-amber-400">● o'zgartirildi</span>}
                            </Label>
                            {r.description && (
                              <p className="text-xs text-muted-foreground mt-0.5">{r.description}</p>
                            )}
                          </div>
                          <div className="flex gap-1 shrink-0">
                            <Button size="sm" variant="ghost" onClick={() => reset(r.key)} title="Standartga qaytar">
                              <RotateCcw className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                        <div className="mt-2">
                          {kind === "bool" && (
                            <div className="flex items-center gap-2">
                              <Switch checked={!!v} onCheckedChange={set} />
                              <span className="text-sm">{v ? "yoqilgan" : "o'chirilgan"}</span>
                            </div>
                          )}
                          {kind === "number" && (
                            <Input type="number" value={v ?? ""} onChange={(e) => set(parseFloat(e.target.value) || 0)} />
                          )}
                          {kind === "string" && (
                            <Input value={v ?? ""} onChange={(e) => set(e.target.value)} />
                          )}
                          {kind === "json" && (
                            <Textarea
                              rows={4}
                              className="font-mono text-xs"
                              value={typeof v === "string" ? v : JSON.stringify(v, null, 2)}
                              onChange={(e) => {
                                try { set(JSON.parse(e.target.value)); }
                                catch { set(e.target.value); }
                              }}
                            />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
