import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, Pencil, Trash2, Users as UsersIcon } from "lucide-react";
import { toast } from "sonner";

type Group = {
  id: string;
  name: string;
  course_id: string | null;
  teacher_id: string | null;
  is_default: boolean;
  created_at: string;
};

type Course = { id: string; title: string };

type ProfileLite = {
  id: string;
  name: string | null;
  email: string;
  telegram_username: string | null;
  telegram_id: number | null;
  group_id: string | null;
};

export default function AdminGroups() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [teachers, setTeachers] = useState<ProfileLite[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [health, setHealth] = useState<Record<string, number>>({});
  const [topics, setTopics] = useState<Record<string, { configured: number; total: number }>>({});
  const [loading, setLoading] = useState(true);

  const [openCreate, setOpenCreate] = useState(false);
  const [editGroup, setEditGroup] = useState<Group | null>(null);
  const [deleteGroup, setDeleteGroup] = useState<Group | null>(null);
  const [studentsGroup, setStudentsGroup] = useState<Group | null>(null);

  const reload = async () => {
    setLoading(true);
    const [g, c, p] = await Promise.all([
      supabase.from("groups").select("*").order("created_at", { ascending: false }),
      supabase.from("courses").select("id,title").order("title"),
      supabase.rpc("admin_list_users"),
    ]);
    setGroups((g.data as Group[]) || []);
    setCourses((c.data as Course[]) || []);
    const profiles = ((p.data as any[]) || []) as ProfileLite[];
    // teachers = users that already have role teacher (via has_role); fall back to anyone marked is_admin? we'll fetch from user_roles
    const { data: tr } = await supabase.from("user_roles").select("user_id").eq("role", "teacher" as any);
    const teacherIds = new Set((tr || []).map((r: any) => r.user_id));
    setTeachers(profiles.filter((u) => teacherIds.has(u.id)));
    // counts
    const { data: cnt } = await supabase.from("profiles").select("group_id");
    const map: Record<string, number> = {};
    ((cnt as any[]) || []).forEach((r) => {
      if (r.group_id) map[r.group_id] = (map[r.group_id] || 0) + 1;
    });
    setCounts(map);
    // Health scores
    const ids = ((g.data as any[]) || []).map((r) => r.id);
    const health: Record<string, number> = {};
    await Promise.all(ids.map(async (gid) => {
      const { data } = await supabase.rpc("group_health_score" as any, { _group_id: gid });
      health[gid] = Number(data) || 0;
    }));
    setHealth(health);

    // Topics configured per group
    const groupRows = ((g.data as any[]) || []) as Group[];
    const courseIds = Array.from(new Set(groupRows.map((gg) => gg.course_id).filter(Boolean) as string[]));
    const { data: allMods } = courseIds.length
      ? await supabase.from("modules").select("id, course_id").in("course_id", courseIds)
      : { data: [] };
    const modsByCourse: Record<string, number> = {};
    ((allMods as any[]) || []).forEach((m) => { modsByCourse[m.course_id] = (modsByCourse[m.course_id] || 0) + 1; });
    const { data: gmt } = await supabase.from("group_module_topics" as any).select("group_id");
    const cfgByGroup: Record<string, number> = {};
    ((gmt as any[]) || []).forEach((r) => { cfgByGroup[r.group_id] = (cfgByGroup[r.group_id] || 0) + 1; });
    const tmap: Record<string, { configured: number; total: number }> = {};
    groupRows.forEach((gg) => {
      tmap[gg.id] = { configured: cfgByGroup[gg.id] || 0, total: gg.course_id ? (modsByCourse[gg.course_id] || 0) : 0 };
    });
    setTopics(tmap);
    setLoading(false);
  };

  useEffect(() => { reload(); }, []);

  const courseTitle = (id: string | null) => courses.find((c) => c.id === id)?.title || "—";
  const teacherLabel = (id: string | null) => {
    const t = teachers.find((u) => u.id === id);
    if (!t) return id ? id.slice(0, 8) : "—";
    return t.name || t.email || (t.telegram_username ? `@${t.telegram_username}` : t.id.slice(0, 8));
  };

  return (
    <PageShell>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Groups</h1>
            <p className="text-sm text-muted-foreground">Manage student groups and assign teachers.</p>
          </div>
          <Button onClick={() => setOpenCreate(true)}><Plus className="mr-2 h-4 w-4" />Create group</Button>
        </div>

        <Card className="p-0 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Teacher</TableHead>
                <TableHead>Course</TableHead>
                <TableHead>Students</TableHead>
                <TableHead>Health</TableHead>
                <TableHead>Topiklar</TableHead>
                <TableHead>Default</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">Loading…</TableCell></TableRow>
              ) : groups.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">No groups yet.</TableCell></TableRow>
              ) : groups.map((g) => {
                const h = health[g.id] ?? 0;
                const hColor = h >= 70 ? "bg-emerald-500" : h >= 40 ? "bg-amber-500" : "bg-rose-500";
                return (
                <TableRow key={g.id}>
                  <TableCell className="font-medium">
                    <button className="hover:underline text-left" onClick={() => setEditGroup(g)}>{g.name}</button>
                  </TableCell>
                  <TableCell>{teacherLabel(g.teacher_id)}</TableCell>
                  <TableCell>{courseTitle(g.course_id)}</TableCell>
                  <TableCell><Badge variant="secondary">{counts[g.id] || 0}</Badge></TableCell>
                  <TableCell><span className={`inline-block px-2 py-0.5 rounded text-white text-xs ${hColor}`}>{h}</span></TableCell>
                  <TableCell>{(() => {
                    const tt = topics[g.id] || { configured: 0, total: 0 };
                    const cls = tt.total === 0 ? "bg-muted text-muted-foreground" : tt.configured === 0 ? "bg-rose-500 text-white" : tt.configured < tt.total ? "bg-amber-500 text-white" : "bg-emerald-500 text-white";
                    return <span className={`inline-block px-2 py-0.5 rounded text-xs ${cls}`}>{tt.configured}/{tt.total}</span>;
                  })()}</TableCell>
                  <TableCell>
                    <Button
                      variant={g.is_default ? "default" : "outline"}
                      size="sm"
                      onClick={async () => {
                        if (!g.is_default) await supabase.from("groups").update({ is_default: false }).neq("id", g.id);
                        const { error } = await supabase.from("groups").update({ is_default: !g.is_default }).eq("id", g.id);
                        if (error) toast.error(error.message); else { toast.success(g.is_default ? "Cleared default" : "Set as default"); reload(); }
                      }}
                    >{g.is_default ? "Default" : "Set"}</Button>
                  </TableCell>
                  <TableCell className="text-right space-x-2">
                    <Button variant="outline" size="sm" onClick={() => setStudentsGroup(g)}><UsersIcon className="h-4 w-4" /></Button>
                    <Button variant="outline" size="sm" onClick={() => setEditGroup(g)}><Pencil className="h-4 w-4" /></Button>
                    <Button variant="outline" size="sm" onClick={() => setDeleteGroup(g)}><Trash2 className="h-4 w-4" /></Button>
                  </TableCell>
                </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      </div>

      {(openCreate || editGroup) && (
        <GroupFormDialog
          group={editGroup}
          courses={courses}
          teachers={teachers}
          onClose={() => { setOpenCreate(false); setEditGroup(null); }}
          onSaved={() => { setOpenCreate(false); setEditGroup(null); reload(); }}
        />
      )}

      <AlertDialog open={!!deleteGroup} onOpenChange={(o) => !o && setDeleteGroup(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete group?</AlertDialogTitle>
            <AlertDialogDescription>
              Group "{deleteGroup?.name}" will be removed. Students currently in this group will become ungrouped.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={async () => {
              if (!deleteGroup) return;
              const { error } = await supabase.from("groups").delete().eq("id", deleteGroup.id);
              if (error) toast.error(error.message); else toast.success("Group deleted");
              setDeleteGroup(null); reload();
            }}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {studentsGroup && (
        <GroupStudentsDialog
          group={studentsGroup}
          onClose={() => { setStudentsGroup(null); reload(); }}
        />
      )}
    </PageShell>
  );
}

function GroupFormDialog({
  group, courses, teachers, onClose, onSaved,
}: {
  group: Group | null;
  courses: Course[];
  teachers: ProfileLite[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(group?.name || "");
  const [courseId, setCourseId] = useState<string>(group?.course_id || "");
  const [teacherInput, setTeacherInput] = useState<string>("");
  const [teacherPick, setTeacherPick] = useState<string>(group?.teacher_id || "");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim()) { toast.error("Name required"); return; }
    setBusy(true);
    let teacher_id: string | null = teacherPick || null;
    const tIn = teacherInput.trim().replace(/^@/, "");
    if (tIn) {
      // resolve by telegram id or username
      let q = supabase.from("profiles").select("id").limit(1);
      if (/^\d+$/.test(tIn)) q = q.eq("telegram_id", Number(tIn));
      else q = q.eq("telegram_username", tIn as any);
      const { data, error } = await q.maybeSingle();
      if (error || !data) { toast.error("Teacher not found by Telegram id/username"); setBusy(false); return; }
      teacher_id = (data as any).id;
      // ensure teacher role
      await supabase.from("user_roles").insert({ user_id: teacher_id!, role: "teacher" as any }).then(() => {}, () => {});
    }
    const payload = { name: name.trim(), course_id: courseId || null, teacher_id };
    const { error } = group
      ? await supabase.from("groups").update(payload).eq("id", group.id)
      : await supabase.from("groups").insert(payload);
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    toast.success(group ? "Group updated" : "Group created");
    onSaved();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{group ? "Edit group" : "Create group"}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Group A" />
          </div>
          <div>
            <Label>Course</Label>
            <Select value={courseId} onValueChange={setCourseId}>
              <SelectTrigger><SelectValue placeholder="— none —" /></SelectTrigger>
              <SelectContent>
                {courses.map((c) => <SelectItem key={c.id} value={c.id}>{c.title}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Teacher (existing)</Label>
            <Select value={teacherPick} onValueChange={setTeacherPick}>
              <SelectTrigger><SelectValue placeholder="— none —" /></SelectTrigger>
              <SelectContent>
                {teachers.map((t) => <SelectItem key={t.id} value={t.id}>{t.name || t.email}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Or assign teacher by Telegram id / @username</Label>
            <Input value={teacherInput} onChange={(e) => setTeacherInput(e.target.value)} placeholder="123456789 or @username" />
            <p className="text-xs text-muted-foreground mt-1">Will grant teacher role if not already assigned.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{group ? "Save" : "Create"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GroupStudentsDialog({ group, onClose }: { group: Group; onClose: () => void }) {
  const [students, setStudents] = useState<ProfileLite[]>([]);
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState("");
  const [loading, setLoading] = useState(true);

  const reload = async () => {
    setLoading(true);
    const { data } = await supabase
      .from("profiles")
      .select("id,name,email,telegram_username,telegram_id,group_id")
      .eq("group_id", group.id);
    setStudents((data as any[]) || []);
    setLoading(false);
  };
  useEffect(() => { reload(); }, [group.id]);

  const remove = async (id: string) => {
    const { error } = await supabase.from("profiles").update({ group_id: null }).eq("id", id);
    if (error) toast.error(error.message); else { toast.success("Removed"); reload(); }
  };

  const add = async () => {
    const v = adding.trim().replace(/^@/, "");
    if (!v) return;
    let q = supabase.from("profiles").select("id").limit(1);
    if (/^\d+$/.test(v)) q = q.eq("telegram_id", Number(v));
    else if (v.includes("@")) q = q.eq("email", v.toLowerCase());
    else q = q.eq("telegram_username", v as any);
    const { data, error } = await q.maybeSingle();
    if (error || !data) { toast.error("Student not found"); return; }
    const { error: e2 } = await supabase.from("profiles").update({ group_id: group.id }).eq("id", (data as any).id);
    if (e2) { toast.error(e2.message); return; }
    setAdding(""); toast.success("Added"); reload();
  };

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return students;
    return students.filter((u) =>
      (u.name || "").toLowerCase().includes(s) ||
      (u.email || "").toLowerCase().includes(s) ||
      (u.telegram_username || "").toLowerCase().includes(s)
    );
  }, [students, search]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Students in {group.name}</DialogTitle></DialogHeader>
        <div className="flex gap-2">
          <Input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="Telegram id, @username, or email" />
          <Button onClick={add}><Plus className="mr-1 h-4 w-4" />Add</Button>
        </div>
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…" />
        <div className="max-h-80 overflow-auto border rounded">
          <Table>
            <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Email</TableHead><TableHead>Telegram</TableHead><TableHead></TableHead></TableRow></TableHeader>
            <TableBody>
              {loading ? <TableRow><TableCell colSpan={4} className="text-center py-4 text-muted-foreground">Loading…</TableCell></TableRow>
              : filtered.length === 0 ? <TableRow><TableCell colSpan={4} className="text-center py-4 text-muted-foreground">No students.</TableCell></TableRow>
              : filtered.map((u) => (
                <TableRow key={u.id}>
                  <TableCell>{u.name || "—"}</TableCell>
                  <TableCell className="text-xs">{u.email}</TableCell>
                  <TableCell className="text-xs">{u.telegram_username ? `@${u.telegram_username}` : (u.telegram_id || "—")}</TableCell>
                  <TableCell><Button variant="ghost" size="sm" onClick={() => remove(u.id)}><Trash2 className="h-4 w-4" /></Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
