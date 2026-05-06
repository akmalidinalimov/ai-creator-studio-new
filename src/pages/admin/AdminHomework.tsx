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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { getSetting } from "@/lib/settings";

interface ModuleRow { id: string; title: string; course_id: string; courses?: { title: string } }
interface Assignment {
  id: string; module_id: string; title: string; description: string | null;
  prompt_uz: string | null; prompt_ru: string | null; prompt_en: string | null;
  max_score: number; due_days_after_module_unlock: number;
  task_number: number; is_active: boolean;
  parent_id: string | null; sap_number: number | null;
}
interface ModStat { submitted_students: number; total_students: number; module_total: number | null; module_max: number | null }

export default function AdminHomework() {
  const { user } = useAuth();
  const [modules, setModules] = useState<ModuleRow[]>([]);
  const [assignsByModule, setAssignsByModule] = useState<Record<string, Assignment[]>>({});
  const [modStats, setModStats] = useState<Record<string, ModStat>>({});
  const [defaults, setDefaults] = useState({ max: 10, count: 3 });
  const [editing, setEditing] = useState<{
    moduleId: string;
    assignment?: Assignment;
    nextTaskNumber: number;
    parentId?: string | null;
    parentTaskNumber?: number;
    nextSapNumber?: number;
  } | null>(null);
  const [newModule, setNewModule] = useState<{ title: string; course_id: string } | null>(null);
  const [courses, setCourses] = useState<{ id: string; title: string }[]>([]);

  const load = async () => {
    const { data: cs } = await supabase.from("courses").select("id, title").order("created_at");
    setCourses((cs as any) || []);
    const { data: ms } = await supabase
      .from("modules")
      .select("id, title, course_id, courses(title)")
      .order("position");
    setModules((ms as any) || []);

    const { data: as } = await supabase.from("homework_assignments")
      .select("*").order("task_number").order("sap_number", { nullsFirst: true });
    const map: Record<string, Assignment[]> = {};
    (as as any[] || []).forEach((a) => {
      (map[a.module_id] ||= []).push(a as Assignment);
    });
    setAssignsByModule(map);

    const { data: scoreRows } = await supabase
      .from("vw_module_homework_score" as any)
      .select("module_id, profile_id, module_total, module_max");
    const totals: Record<string, { totSum: number; maxSum: number; n: number; students: Set<string> }> = {};
    (scoreRows as any[] || []).forEach((r) => {
      const t = totals[r.module_id] ||= { totSum: 0, maxSum: 0, n: 0, students: new Set() };
      t.students.add(r.profile_id);
      if (r.module_max && Number(r.module_max) > 0) {
        t.totSum += Number(r.module_total);
        t.maxSum += Number(r.module_max);
        t.n++;
      }
    });
    const stats: Record<string, ModStat> = {};
    Object.entries(totals).forEach(([mid, t]) => {
      stats[mid] = {
        submitted_students: t.students.size,
        total_students: t.students.size,
        module_total: t.n ? +(t.totSum / t.n).toFixed(1) : null,
        module_max: t.n ? +(t.maxSum / t.n).toFixed(1) : null,
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

  const save = async (form: any) => {
    if (!form.title?.trim()) { toast.error("Sarlavha kerak"); return; }
    const max = form.max_score || defaults.max;
    if (max < 1 || max > 100) { toast.error("Max bal 1–100"); return; }
    const isSap = !!editing?.parentId || !!editing?.assignment?.parent_id;
    const payload: any = {
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
    if (isSap) {
      payload.parent_id = editing?.assignment?.parent_id || editing?.parentId;
      payload.sap_number = form.sap_number || editing?.nextSapNumber || 1;
    } else {
      payload.parent_id = null;
      payload.sap_number = null;
    }
    const existingId = editing?.assignment?.id;
    const { error } = existingId
      ? await supabase.from("homework_assignments").update(payload).eq("id", existingId)
      : await supabase.from("homework_assignments").insert(payload);
    if (error) { toast.error(error.message); return; }
    toast.success("Saqlandi");
    setEditing(null);
    load();
  };

  const remove = async (a: Assignment) => {
    const saps = (assignsByModule[a.module_id] || []).filter(x => x.parent_id === a.id);
    if (saps.length > 0) {
      if (!confirm(`Bu vazifaning ${saps.length} ta SAP'i bor. Hammasi o'chiriladi. Davom etamizmi?`)) return;
    } else if (!confirm("O'chirish?")) return;
    const { error } = await supabase.from("homework_assignments").delete().eq("id", a.id);
    if (error) toast.error(error.message); else { toast.success("O'chirildi"); load(); }
  };

  const toggleActive = async (a: Assignment) => {
    const { error } = await supabase.from("homework_assignments").update({ is_active: !a.is_active }).eq("id", a.id);
    if (error) toast.error(error.message); else load();
  };

  const createModule = async () => {
    if (!newModule?.title.trim() || !newModule.course_id) { toast.error("Sarlavha va kurs kerak"); return; }
    const courseModules = modules.filter(m => m.course_id === newModule.course_id);
    const nextPos = courseModules.length;
    const { error } = await supabase.from("modules").insert({
      course_id: newModule.course_id,
      title: newModule.title.trim().slice(0, 200),
      position: nextPos,
    });
    if (error) { toast.error(error.message); return; }
    toast.success("Modul yaratildi");
    setNewModule(null);
    load();
  };

  const openNewModule = () => {
    setNewModule({ title: "", course_id: courses[0]?.id || "" });
  };

  return (
    <PageShell>
      <div className="max-w-4xl space-y-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">📝 Uy vazifalari</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Har modulga bir nechta vazifa qo'shing. Standart: {defaults.count} ta vazifa, max bal {defaults.max}.
            Har vazifaga SAP (sub-vazifa) qo'shish mumkin. Modul bahosi — barcha SAP/vazifalar ballarining yig'indisi.
          </p>
        </div>

        <div className="space-y-4">
          {modules.map((m) => {
            const all = assignsByModule[m.id] || [];
            const parents = all.filter(a => !a.parent_id).sort((a, b) => a.task_number - b.task_number);
            const sapsByParent: Record<string, Assignment[]> = {};
            all.filter(a => !!a.parent_id).forEach(s => {
              (sapsByParent[s.parent_id!] ||= []).push(s);
            });
            Object.values(sapsByParent).forEach(arr => arr.sort((a, b) => (a.sap_number || 0) - (b.sap_number || 0)));
            const stat = modStats[m.id];
            const nextNum = (parents.reduce((mx, t) => Math.max(mx, t.task_number), 0) || 0) + 1;
            return (
              <Card key={m.id} className="p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs text-muted-foreground">{m.courses?.title}</div>
                    <div className="font-semibold">{m.title}</div>
                    {stat && (
                      <div className="text-xs text-muted-foreground mt-1">
                        Baholangan: {stat.submitted_students} talaba
                        {stat.module_total != null && ` · O'rtacha: ${stat.module_total}/${stat.module_max}`}
                      </div>
                    )}
                  </div>
                  <Button size="sm" onClick={() => setEditing({ moduleId: m.id, nextTaskNumber: nextNum })}>
                    <Plus className="h-4 w-4 mr-1" /> Yangi vazifa
                  </Button>
                </div>

                {parents.length === 0 ? (
                  <p className="text-xs italic text-muted-foreground">Vazifa yo'q</p>
                ) : (
                  <div className="space-y-2">
                    {parents.map((a) => {
                      const saps = sapsByParent[a.id] || [];
                      const sapMax = saps.reduce((acc, s) => acc + s.max_score, 0);
                      const nextSap = (saps.reduce((mx, s) => Math.max(mx, s.sap_number || 0), 0) || 0) + 1;
                      return (
                        <div key={a.id} className="space-y-2">
                          <div className="flex items-center gap-3 border rounded-md px-3 py-2">
                            <Badge variant={a.is_active ? "default" : "secondary"}>V{a.task_number}</Badge>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium truncate">{a.title}</div>
                              <div className="text-xs text-muted-foreground">
                                {saps.length > 0
                                  ? `${saps.length} ta SAP · Jami max: ${sapMax}`
                                  : `Max: ${a.max_score}`}
                                {` · Muddat: ${a.due_days_after_module_unlock} kun`}
                              </div>
                            </div>
                            <Button size="sm" variant="outline" onClick={() => setEditing({
                              moduleId: m.id, parentId: a.id, parentTaskNumber: a.task_number,
                              nextTaskNumber: a.task_number, nextSapNumber: nextSap,
                            })}>
                              <Plus className="h-4 w-4 mr-1" /> SAP
                            </Button>
                            <Switch checked={a.is_active} onCheckedChange={() => toggleActive(a)} />
                            <Button size="sm" variant="outline" onClick={() => setEditing({ moduleId: m.id, assignment: a, nextTaskNumber: a.task_number })}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => remove(a)}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                          {saps.length > 0 && (
                            <div className="pl-6 space-y-2 border-l-2 ml-3">
                              {saps.map((s) => (
                                <div key={s.id} className="flex items-center gap-3 border rounded-md px-3 py-2 bg-muted/20">
                                  <Badge variant={s.is_active ? "default" : "secondary"} className="bg-primary/80">
                                    V{a.task_number}.S{s.sap_number}
                                  </Badge>
                                  <div className="flex-1 min-w-0">
                                    <div className="text-sm font-medium truncate">{s.title}</div>
                                    <div className="text-xs text-muted-foreground">Max: {s.max_score}</div>
                                  </div>
                                  <Switch checked={s.is_active} onCheckedChange={() => toggleActive(s)} />
                                  <Button size="sm" variant="outline" onClick={() => setEditing({
                                    moduleId: m.id, assignment: s, nextTaskNumber: a.task_number,
                                    parentId: a.id, parentTaskNumber: a.task_number,
                                  })}>
                                    <Pencil className="h-4 w-4" />
                                  </Button>
                                  <Button size="sm" variant="outline" onClick={() => remove(s)}>
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
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
            <DialogTitle>
              {editing?.assignment
                ? (editing.assignment.parent_id
                    ? `SAP V${editing.parentTaskNumber}.S${editing.assignment.sap_number}`
                    : `Vazifa V${editing.assignment.task_number}`)
                : (editing?.parentId
                    ? `Yangi SAP (V${editing.parentTaskNumber}.S${editing.nextSapNumber})`
                    : `Yangi vazifa (V${editing?.nextTaskNumber})`)}
            </DialogTitle>
          </DialogHeader>
          {editing && (
            <AssignForm
              initial={editing.assignment}
              moduleId={editing.moduleId}
              taskNumber={editing.assignment?.task_number ?? editing.nextTaskNumber}
              isSap={!!editing.parentId || !!editing.assignment?.parent_id}
              sapNumber={editing.assignment?.sap_number ?? editing.nextSapNumber}
              defaultMax={defaults.max}
              onSave={save}
            />
          )}
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

function AssignForm({ initial, moduleId, taskNumber, isSap, sapNumber, defaultMax, onSave }: {
  initial?: Assignment; moduleId: string; taskNumber: number;
  isSap: boolean; sapNumber?: number | null;
  defaultMax: number; onSave: (a: any) => void;
}) {
  const [f, setF] = useState({
    module_id: moduleId,
    task_number: taskNumber,
    sap_number: sapNumber || 1,
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
        {isSap ? (
          <div><Label>SAP raqami</Label><Input type="number" min={1} value={f.sap_number} onChange={(e) => setF({ ...f, sap_number: parseInt(e.target.value) || 1 })} /></div>
        ) : (
          <div><Label>Vazifa raqami</Label><Input type="number" min={1} value={f.task_number} onChange={(e) => setF({ ...f, task_number: parseInt(e.target.value) || 1 })} /></div>
        )}
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
