import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { getSetting } from "@/lib/settings";

interface ModuleRow { id: string; title: string; course_id: string; courses?: { title: string } }
interface Assignment {
  id: string; module_id: string; title: string; description: string | null;
  prompt_uz: string | null; prompt_ru: string | null; prompt_en: string | null;
  max_score: number; due_days_after_module_unlock: number;
  task_number: number; is_active: boolean;
}
interface ModStat { submitted_students: number; total_students: number; avg_norm: number | null }

export default function AdminHomework() {
  const { user } = useAuth();
  const [modules, setModules] = useState<ModuleRow[]>([]);
  const [assignsByModule, setAssignsByModule] = useState<Record<string, Assignment[]>>({});
  const [modStats, setModStats] = useState<Record<string, ModStat>>({});
  const [defaults, setDefaults] = useState({ max: 10, count: 3 });
  const [editing, setEditing] = useState<{ moduleId: string; assignment?: Assignment; nextTaskNumber: number } | null>(null);

  const load = async () => {
    const { data: ms } = await supabase
      .from("modules")
      .select("id, title, course_id, courses(title)")
      .order("position");
    setModules((ms as any) || []);

    const { data: as } = await supabase.from("homework_assignments").select("*").order("task_number");
    const map: Record<string, Assignment[]> = {};
    (as as any[] || []).forEach((a) => {
      (map[a.module_id] ||= []).push(a as Assignment);
    });
    setAssignsByModule(map);

    const { data: scoreRows } = await supabase
      .from("vw_module_homework_score" as any)
      .select("module_id, profile_id, avg_score_normalized");
    const stats: Record<string, ModStat> = {};
    const totals: Record<string, { sum: number; n: number; students: Set<string> }> = {};
    (scoreRows as any[] || []).forEach((r) => {
      const t = totals[r.module_id] ||= { sum: 0, n: 0, students: new Set() };
      t.students.add(r.profile_id);
      if (r.avg_score_normalized != null) { t.sum += Number(r.avg_score_normalized); t.n++; }
    });
    Object.entries(totals).forEach(([mid, t]) => {
      stats[mid] = {
        submitted_students: t.students.size,
        total_students: t.students.size,
        avg_norm: t.n ? +(t.sum / t.n).toFixed(1) : null,
      };
    });
    setModStats(stats);
  };

  useEffect(() => {
    (async () => {
      const max = await getSetting<number>("homework.default_max_score").catch(() => 10);
      const count = await getSetting<number>("homework.default_tasks_per_module").catch(() => 3);
      setDefaults({ max: max || 10, count: count || 3 });
      await load();
    })();
  }, []);

  const save = async (form: Partial<Assignment> & { module_id: string; task_number: number }) => {
    if (!form.title?.trim()) { toast.error("Sarlavha kerak"); return; }
    const max = form.max_score || defaults.max;
    if (max < 1 || max > 100) { toast.error("Max bal 1–100"); return; }
    const payload = {
      module_id: form.module_id,
      task_number: form.task_number,
      is_active: form.is_active ?? true,
      title: form.title.trim().slice(0, 200),
      description: form.description?.slice(0, 5000) || null,
      prompt_uz: form.prompt_uz?.slice(0, 5000) || null,
      prompt_ru: form.prompt_ru?.slice(0, 5000) || null,
      prompt_en: form.prompt_en?.slice(0, 5000) || null,
      max_score: max,
      due_days_after_module_unlock: form.due_days_after_module_unlock || 7,
      created_by: user?.id,
    };
    const existingId = editing?.assignment?.id;
    const { error } = existingId
      ? await supabase.from("homework_assignments").update(payload).eq("id", existingId)
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

  const toggleActive = async (a: Assignment) => {
    const { error } = await supabase.from("homework_assignments").update({ is_active: !a.is_active }).eq("id", a.id);
    if (error) toast.error(error.message); else load();
  };

  return (
    <PageShell>
      <div className="max-w-4xl space-y-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">📝 Uy vazifalari</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Har modulga bir nechta vazifa qo'shing. Standart: {defaults.count} ta vazifa, max bal {defaults.max}.
            Modul bahosi — barcha vazifalar o'rtachasi /10 ga normalashtirilgan.
          </p>
        </div>

        <div className="space-y-4">
          {modules.map((m) => {
            const tasks = assignsByModule[m.id] || [];
            const stat = modStats[m.id];
            const nextNum = (tasks.reduce((mx, t) => Math.max(mx, t.task_number), 0) || 0) + 1;
            return (
              <Card key={m.id} className="p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs text-muted-foreground">{m.courses?.title}</div>
                    <div className="font-semibold">{m.title}</div>
                    {stat && (
                      <div className="text-xs text-muted-foreground mt-1">
                        Topshirgan: {stat.submitted_students} talaba
                        {stat.avg_norm != null && ` · O'rtacha: ${stat.avg_norm}/10`}
                      </div>
                    )}
                  </div>
                  <Button size="sm" onClick={() => setEditing({ moduleId: m.id, nextTaskNumber: nextNum })}>
                    <Plus className="h-4 w-4 mr-1" /> Yangi vazifa
                  </Button>
                </div>

                {tasks.length === 0 ? (
                  <p className="text-xs italic text-muted-foreground">Vazifa yo'q</p>
                ) : (
                  <div className="space-y-2">
                    {tasks.map((a) => (
                      <div key={a.id} className="flex items-center gap-3 border rounded-md px-3 py-2">
                        <Badge variant={a.is_active ? "default" : "secondary"}>V{a.task_number}</Badge>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">{a.title}</div>
                          <div className="text-xs text-muted-foreground">Max: {a.max_score} · Muddat: {a.due_days_after_module_unlock} kun</div>
                        </div>
                        <Switch checked={a.is_active} onCheckedChange={() => toggleActive(a)} />
                        <Button size="sm" variant="outline" onClick={() => setEditing({ moduleId: m.id, assignment: a, nextTaskNumber: a.task_number })}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => remove(a.id)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      </div>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing?.assignment ? `Vazifa ${editing.assignment.task_number}` : `Yangi vazifa (V${editing?.nextTaskNumber})`}</DialogTitle>
          </DialogHeader>
          {editing && (
            <AssignForm
              initial={editing.assignment}
              moduleId={editing.moduleId}
              taskNumber={editing.assignment?.task_number ?? editing.nextTaskNumber}
              defaultMax={defaults.max}
              onSave={save}
            />
          )}
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

function AssignForm({ initial, moduleId, taskNumber, defaultMax, onSave }: {
  initial?: Assignment; moduleId: string; taskNumber: number; defaultMax: number;
  onSave: (a: any) => void;
}) {
  const [f, setF] = useState({
    module_id: moduleId,
    task_number: taskNumber,
    is_active: initial?.is_active ?? true,
    title: initial?.title || "",
    description: initial?.description || "",
    prompt_uz: initial?.prompt_uz || "",
    prompt_ru: initial?.prompt_ru || "",
    prompt_en: initial?.prompt_en || "",
    max_score: initial?.max_score || defaultMax,
    due_days_after_module_unlock: initial?.due_days_after_module_unlock || 7,
  });
  return (
    <div className="space-y-3 max-h-[70vh] overflow-y-auto pr-1">
      <div className="grid grid-cols-2 gap-3">
        <div><Label>Vazifa raqami</Label><Input type="number" min={1} value={f.task_number} onChange={(e) => setF({ ...f, task_number: parseInt(e.target.value) || 1 })} /></div>
        <div className="flex items-end gap-2"><Switch checked={f.is_active} onCheckedChange={(v) => setF({ ...f, is_active: v })} /><span className="text-sm">{f.is_active ? "Faol" : "Yashirin"}</span></div>
      </div>
      <div><Label>Sarlavha</Label><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
      <div><Label>Tavsif (markdown)</Label><Textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
      <div><Label>Topshiriq matni (UZ)</Label><Textarea rows={3} value={f.prompt_uz} onChange={(e) => setF({ ...f, prompt_uz: e.target.value })} /></div>
      <div><Label>Topshiriq matni (RU)</Label><Textarea rows={3} value={f.prompt_ru} onChange={(e) => setF({ ...f, prompt_ru: e.target.value })} /></div>
      <div><Label>Topshiriq matni (EN)</Label><Textarea rows={3} value={f.prompt_en} onChange={(e) => setF({ ...f, prompt_en: e.target.value })} /></div>
      <div className="grid grid-cols-2 gap-3">
        <div><Label>Maks bal (1–100)</Label><Input type="number" min={1} max={100} value={f.max_score} onChange={(e) => setF({ ...f, max_score: parseInt(e.target.value) || defaultMax })} /></div>
        <div><Label>Muddat (kun)</Label><Input type="number" min={1} value={f.due_days_after_module_unlock} onChange={(e) => setF({ ...f, due_days_after_module_unlock: parseInt(e.target.value) || 7 })} /></div>
      </div>
      <Button onClick={() => onSave(f)}>💾 Saqlash</Button>
    </div>
  );
}
