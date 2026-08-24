import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { mutate, mutateMany } from "@/lib/mutate";

interface Props { groupId: string }
interface Mod { id: string; title: string; position: number }

const URL_RE = /^https:\/\/t\.me\/(c\/\d+\/\d+|\+[\w-]+)/;

export function GroupTopicsSection({ groupId }: Props) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [groupUrl, setGroupUrl] = useState("");
  const [modules, setModules] = useState<Mod[]>([]);
  const [topicByMod, setTopicByMod] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const { data: g } = await supabase.from("groups").select("course_id, telegram_group_url").eq("id", groupId).maybeSingle();
    setGroupUrl((g as any)?.telegram_group_url || "");
    const courseId = (g as any)?.course_id;
    if (!courseId) { setModules([]); return; }
    const { data: ms } = await supabase.from("modules").select("id, title, position").eq("course_id", courseId).order("position");
    setModules((ms || []) as Mod[]);
    const { data: gmt } = await supabase
      .from("group_module_topics" as any)
      .select("module_id, telegram_topic_url")
      .eq("group_id", groupId);
    const m: Record<string, string> = {};
    ((gmt as any[]) || []).forEach((r) => { m[r.module_id] = r.telegram_topic_url; });
    setTopicByMod(m);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [groupId]);

  const saveAll = async () => {
    // Validate
    if (groupUrl && !URL_RE.test(groupUrl)) {
      toast.error("Group URL noto'g'ri (t.me/... bo'lishi kerak)"); return;
    }
    for (const m of modules) {
      const v = (topicByMod[m.id] || "").trim();
      if (v && !URL_RE.test(v)) { toast.error(`Modul "${m.title}" URL noto'g'ri`); return; }
    }
    setBusy(true);
    try {
      const rg = await mutate(() => supabase.from("groups").update({ telegram_group_url: groupUrl || null }).eq("id", groupId));
      if (!rg.ok && rg.reason !== "impersonation_readonly") { toast.error(rg.message || "Saqlashda xatolik"); return; }
      // Impersonation patches every write to a no-op, so if the leading write was skipped the whole
      // save is a no-op — suppress the success toast rather than claim "N topics saved".
      const readOnly = !rg.ok && rg.reason === "impersonation_readonly";
      const upserts: any[] = [];
      const deletes: string[] = [];
      modules.forEach((m) => {
        const v = (topicByMod[m.id] || "").trim();
        if (v) upserts.push({ group_id: groupId, module_id: m.id, telegram_topic_url: v, created_by: user?.id });
        else deletes.push(m.id);
      });
      let saved = 0;
      if (upserts.length) {
        const r = await mutateMany(() => supabase.from("group_module_topics" as any).upsert(upserts, { onConflict: "group_id,module_id" }), { expected: upserts.length });
        if (!r.ok && r.reason !== "impersonation_readonly") { toast.error(r.message || "Saqlashda xatolik"); return; }
        saved = upserts.length;
      }
      if (deletes.length) {
        // 0-row is legitimate here (clearing modules that never had a topic row) — route through
        // mutateMany only to skip the write during impersonation, not to treat a no-op as failure.
        await mutateMany(() => supabase.from("group_module_topics" as any).delete().eq("group_id", groupId).in("module_id", deletes));
      }
      if (!readOnly) toast.success(`${saved} ta topik saqlandi`);
      load();
    } catch (e: any) {
      toast.error(e?.message || "Saqlashda xatolik");
    } finally {
      setBusy(false);
    }
  };

  const configured = modules.filter((m) => (topicByMod[m.id] || "").trim()).length;

  return (
    <Card className="p-0">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="w-full flex items-center justify-between p-4 hover:bg-muted/30 text-left">
          <div className="flex items-center gap-2">
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            <span className="font-semibold">📲 Telegram guruh va topiklar</span>
          </div>
          <span className="text-xs text-muted-foreground">{configured}/{modules.length} sozlangan</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="px-4 pb-4 space-y-3 border-t">
          <div className="pt-3">
            <Label className="text-xs">Guruhning Telegram URL</Label>
            <Input
              value={groupUrl}
              onChange={(e) => setGroupUrl(e.target.value)}
              placeholder="https://t.me/+invitehash yoki https://t.me/c/2123456789/1"
            />
          </div>
          {modules.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">Bu guruhga kurs biriktirilmagan.</p>
          ) : (
            <div className="space-y-2">
              {modules.map((m, i) => (
                <div key={m.id}>
                  <Label className="text-xs">📝 Modul {i + 1} — {m.title}</Label>
                  <Input
                    value={topicByMod[m.id] || ""}
                    onChange={(e) => setTopicByMod({ ...topicByMod, [m.id]: e.target.value })}
                    placeholder="https://t.me/c/2123456789/15"
                  />
                </div>
              ))}
            </div>
          )}
          <Button onClick={saveAll} disabled={busy}>💾 Hammasini saqlash</Button>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
