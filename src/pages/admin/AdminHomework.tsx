import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Plus, Pencil, Trash2 } from "lucide-react";

interface ModuleRow { id: string; title: string; course_id: string; courses?: { title: string } }
interface Assignment {
  id: string; module_id: string; title: string; description: string | null;
  prompt_uz: string | null; prompt_ru: string | null; prompt_en: string | null;
  max_score: number; due_days_after_module_unlock: number;
}

export default function AdminHomework() {
  const { user } = useAuth();
  const [modules, setModules] = useState<ModuleRow[]>([]);
  const [assigns, setAssigns] = useState<Record<string, Assignment>>({});
  const [counts, setCounts] = useState<Record<string, { n: number; avg: number | null }>>({});
  const [editing, setEditing] = useState<{ moduleId: string; assignment?: Assignment } | null>(null);

  const load = async () => {
    const { data: ms } = await supabase
      .from("modules")
      .select("id, title, course_id, courses(title)")
      .order("position");
    setModules((ms as any) || []);
    const { data: as } = await supabase.from("homework_assignments").select("*");
    const m: Record<string, Assignment> = {};
    (as || []).forEach((a: any) => { m[a.module_id] = a; });
    setAssigns(m);
    if (as && as.length) {
      const ids = as.map((a: any) => a.id);
      const { data: subs } = await supabase
        .from("homework_submissions")
        .select("assignment_id, score")
        .in("assignment_id", ids);
      const c: Record<string, { n: number; avg: number | null }> = {};
      (subs || []).forEach((s: any) => {
        c[s.assignment_id] ||= { n: 0, avg: null };
        c[s.assignment_id].n++;
      });
      ids.forEach((id: string) => {
        const scored = (subs || []).filter((s: any) => s.assignment_id === id && s.score != null);
        if (scored.length) {
          c[id] = c[id] || { n: 0, avg: null };
          c[id].avg = scored.reduce((a: number, b: any) => a + b.score, 0) / scored.length;
        }
      });
      setCounts(c);
    }
  };
  useEffect(() => { load(); }, []);

  const save = async (form: Partial<Assignment> & { module_id: string }) => {
    if (!form.title?.trim()) { toast.error("Sarlavha kerak"); return; }
    if ((form.max_score || 10) < 1 || (form.max_score || 10) > 10) { toast.error("Max bal 1–10"); return; }
    const payload = {
      module_id: form.module_id,
      title: form.title!.trim().slice(0, 200),
      description: form.description?.slice(0, 5000) || null,
      prompt_uz: form.prompt_uz?.slice(0, 5000) || null,
      prompt_ru: form.prompt_ru?.slice(0, 5000) || null,
      prompt_en: form.prompt_en?.slice(0, 5000) || null,
      max_score: form.max_score || 10,
      due_days_after_module_unlock: form.due_days_after_module_unlock || 7,
      created_by: user?.id,
    };
    const existing = assigns[form.module_id];
    const { error } = existing
      ? await supabase.from("homework_assignments").update(payload).eq("id", existing.id)
      : await supabase.from("homework_assignments").insert(payload);
    if (error) { toast.error(error.message); return; }
    toast.success("Saqlandi");
    setEditing(null);
    load();
  };

  const remove = async (id: string) => {
    if (!confirm("O'chirish?")) return;
    const { error } = await supabase.from("homework_assignments").delete().eq("id", id);
    if (error) toast.error(error.message); else { toast.success("O'chirildi"); load(); }
  };

  return (
    <PageShell>
      <div className="max-w-4xl space-y-6">
        <h1 className="text-3xl font-semibold tracking-tight">📝 Uy vazifalari</h1>
        <p className="text-sm text-muted-foreground">Har bir modulga bitta vazifa biriktiring (0–10 bal).</p>

        <div className="space-y-3">
          {modules.map((m) => {
            const a = assigns[m.id];
            const c = a ? counts[a.id] || { n: 0, avg: null } : null;
            return (
              <Card key={m.id} className="p-4 flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-muted-foreground">{m.courses?.title}</div>
                  <div className="font-semibold">{m.title}</div>
                  {a ? (
                    <div className="text-sm text-muted-foreground mt-1">
                      📝 {a.title} · {c?.n || 0} ta topshiriq{c?.avg != null && ` · o'rtacha ${c.avg.toFixed(1)}/${a.max_score}`}
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground mt-1 italic">Vazifa yo'q</div>
                  )}
                </div>
                <div className="flex gap-2 shrink-0">
                  {a ? (
                    <>
                      <Button size="sm" variant="outline" onClick={() => setEditing({ moduleId: m.id, assignment: a })}><Pencil className="h-4 w-4" /></Button>
                      <Button size="sm" variant="outline" onClick={() => remove(a.id)}><Trash2 className="h-4 w-4" /></Button>
                    </>
                  ) : (
                    <Button size="sm" onClick={() => setEditing({ moduleId: m.id })}><Plus className="h-4 w-4" /> Qo'shish</Button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      </div>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing?.assignment ? "Vazifani tahrirlash" : "Yangi vazifa"}</DialogTitle>
          </DialogHeader>
          {editing && <AssignForm initial={editing.assignment} moduleId={editing.moduleId} onSave={save} />}
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

function AssignForm({ initial, moduleId, onSave }: { initial?: Assignment; moduleId: string; onSave: (a: any) => void }) {
  const [f, setF] = useState({
    module_id: moduleId,
    title: initial?.title || "",
    description: initial?.description || "",
    prompt_uz: initial?.prompt_uz || "",
    prompt_ru: initial?.prompt_ru || "",
    prompt_en: initial?.prompt_en || "",
    max_score: initial?.max_score || 10,
    due_days_after_module_unlock: initial?.due_days_after_module_unlock || 7,
  });
  return (
    <div className="space-y-3">
      <div><Label>Sarlavha</Label><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
      <div><Label>Tavsif (markdown)</Label><Textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
      <div><Label>Topshiriq matni (UZ)</Label><Textarea rows={3} value={f.prompt_uz} onChange={(e) => setF({ ...f, prompt_uz: e.target.value })} /></div>
      <div><Label>Topshiriq matni (RU)</Label><Textarea rows={3} value={f.prompt_ru} onChange={(e) => setF({ ...f, prompt_ru: e.target.value })} /></div>
      <div><Label>Topshiriq matni (EN)</Label><Textarea rows={3} value={f.prompt_en} onChange={(e) => setF({ ...f, prompt_en: e.target.value })} /></div>
      <div className="grid grid-cols-2 gap-3">
        <div><Label>Maks bal (1–10)</Label><Input type="number" min={1} max={10} value={f.max_score} onChange={(e) => setF({ ...f, max_score: parseInt(e.target.value) || 10 })} /></div>
        <div><Label>Muddat (kun)</Label><Input type="number" min={1} value={f.due_days_after_module_unlock} onChange={(e) => setF({ ...f, due_days_after_module_unlock: parseInt(e.target.value) || 7 })} /></div>
      </div>
      <Button onClick={() => onSave(f)}>💾 Saqlash</Button>
    </div>
  );
}
