import { useEffect, useMemo, useRef, useState } from "react";
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
import { Plus, Pencil, Trash2, Users as UsersIcon, Upload, RefreshCw, UserPlus } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Checkbox } from "@/components/ui/checkbox";
import { useAuth } from "@/contexts/AuthContext";
import { getSiteUrl } from "@/lib/siteUrl";
import { toast } from "sonner";

const FN_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;
const randPassword = () => Math.random().toString(36).slice(2, 10) + "!A1";

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
  const [logins, setLogins] = useState<Record<string, { logged: number; total: number }>>({});
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
    // Per-group login stats
    const { data: ls } = await supabase.rpc("admin_group_login_stats" as any);
    const lmap: Record<string, { logged: number; total: number }> = {};
    ((ls as any[]) || []).forEach((r) => { lmap[r.group_id] = { logged: r.logged_in_count || 0, total: r.total_active || 0 }; });
    setLogins(lmap);
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
                <TableHead>Loggedin</TableHead>
                <TableHead>Health</TableHead>
                <TableHead>Topiklar</TableHead>
                <TableHead>Default</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-8">Loading…</TableCell></TableRow>
              ) : groups.length === 0 ? (
                <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-8">No groups yet.</TableCell></TableRow>
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
                    <TooltipProvider delayDuration={150}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button variant="outline" size="sm" onClick={() => setStudentsGroup(g)} aria-label="Talabalar"><UsersIcon className="h-4 w-4" /></Button>
                        </TooltipTrigger>
                        <TooltipContent>Talabalar</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button variant="outline" size="sm" onClick={() => setEditGroup(g)} aria-label="Tahrirlash"><Pencil className="h-4 w-4" /></Button>
                        </TooltipTrigger>
                        <TooltipContent>Tahrirlash</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button variant="outline" size="sm" onClick={() => setDeleteGroup(g)} aria-label="O'chirish"><Trash2 className="h-4 w-4" /></Button>
                        </TooltipTrigger>
                        <TooltipContent>O'chirish</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
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

const TG_URL_RE = /^https:\/\/t\.me\/(c\/\d+\/\d+|\+[\w-]+)/;

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

  const [tgGroupUrl, setTgGroupUrl] = useState<string>("");
  const [modules, setModules] = useState<{ id: string; title: string; position: number }[]>([]);
  const [topicByMod, setTopicByMod] = useState<Record<string, string>>({});
  const [errByMod, setErrByMod] = useState<Record<string, string>>({});
  const [tgGroupErr, setTgGroupErr] = useState<string>("");

  // Load existing group telegram_group_url + topics on edit; load modules whenever course changes
  useEffect(() => {
    (async () => {
      if (group) {
        const { data: g } = await supabase.from("groups").select("telegram_group_url").eq("id", group.id).maybeSingle();
        setTgGroupUrl(((g as any)?.telegram_group_url) || "");
        const { data: gmt } = await supabase
          .from("group_module_topics" as any)
          .select("module_id, telegram_topic_url")
          .eq("group_id", group.id);
        const m: Record<string, string> = {};
        ((gmt as any[]) || []).forEach((r) => { m[r.module_id] = r.telegram_topic_url; });
        setTopicByMod(m);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group?.id]);

  useEffect(() => {
    (async () => {
      if (!courseId) { setModules([]); return; }
      const { data } = await supabase.from("modules").select("id, title, position").eq("course_id", courseId).order("position");
      setModules(((data as any[]) || []) as any);
    })();
  }, [courseId]);

  const submit = async () => {
    if (!name.trim()) { toast.error("Name required"); return; }

    // Validate Telegram URLs
    const newErrs: Record<string, string> = {};
    let groupErr = "";
    if (tgGroupUrl.trim() && !TG_URL_RE.test(tgGroupUrl.trim())) {
      groupErr = "URL noto'g'ri (https://t.me/...)";
    }
    for (const m of modules) {
      const v = (topicByMod[m.id] || "").trim();
      if (v && !TG_URL_RE.test(v)) newErrs[m.id] = "URL noto'g'ri";
    }
    setTgGroupErr(groupErr);
    setErrByMod(newErrs);
    if (groupErr || Object.keys(newErrs).length) { toast.error("URL formatlarini tekshiring"); return; }

    setBusy(true);
    try {
      let teacher_id: string | null = teacherPick || null;
      const tIn = teacherInput.trim().replace(/^@/, "");
      if (tIn) {
        let q = supabase.from("profiles").select("id").limit(1);
        if (/^\d+$/.test(tIn)) q = q.eq("telegram_id", Number(tIn));
        else q = q.eq("telegram_username", tIn as any);
        const { data, error } = await q.maybeSingle();
        if (error || !data) { toast.error("Teacher not found by Telegram id/username"); setBusy(false); return; }
        teacher_id = (data as any).id;
        await supabase.from("user_roles").insert({ user_id: teacher_id!, role: "teacher" as any }).then(() => {}, () => {});
      }
      const payload: any = {
        name: name.trim(),
        course_id: courseId || null,
        teacher_id,
        telegram_group_url: tgGroupUrl.trim() || null,
      };
      let groupId = group?.id;
      if (group) {
        const { error } = await supabase.from("groups").update(payload).eq("id", group.id);
        if (error) throw error;
      } else {
        const { data, error } = await supabase.from("groups").insert(payload).select("id").maybeSingle();
        if (error) throw error;
        groupId = (data as any)?.id;
      }

      let topicsSaved = 0;
      if (groupId) {
        const upserts: any[] = [];
        const deletes: string[] = [];
        modules.forEach((m) => {
          const v = (topicByMod[m.id] || "").trim();
          if (v) upserts.push({ group_id: groupId, module_id: m.id, telegram_topic_url: v });
          else deletes.push(m.id);
        });
        if (upserts.length) {
          const { error } = await supabase.from("group_module_topics" as any).upsert(upserts, { onConflict: "group_id,module_id" });
          if (error) throw error;
          topicsSaved = upserts.length;
        }
        if (deletes.length) {
          await supabase.from("group_module_topics" as any).delete().eq("group_id", groupId).in("module_id", deletes);
        }
      }

      toast.success(`Guruh saqlandi · ${topicsSaved} ta topik`);
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Saqlashda xatolik");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
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

          <div className="border-t pt-3 mt-3 space-y-3">
            <div className="font-semibold text-sm">📲 Telegram (ixtiyoriy)</div>
            <div>
              <Label className="text-xs">Telegram guruh URL</Label>
              <Input
                value={tgGroupUrl}
                onChange={(e) => { setTgGroupUrl(e.target.value); setTgGroupErr(""); }}
                placeholder="https://t.me/+abc123"
              />
              {tgGroupErr && <p className="text-xs text-rose-600 mt-1">{tgGroupErr}</p>}
            </div>
            {!courseId ? (
              <p className="text-xs text-muted-foreground italic">Modul topiklari uchun avval kurs tanlang.</p>
            ) : modules.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">Bu kursda modul yo'q.</p>
            ) : (
              <div className="space-y-2">
                {modules.map((m, i) => (
                  <div key={m.id}>
                    <Label className="text-xs">Modul {i + 1} — {m.title} topiki</Label>
                    <Input
                      value={topicByMod[m.id] || ""}
                      onChange={(e) => {
                        setTopicByMod({ ...topicByMod, [m.id]: e.target.value });
                        setErrByMod((prev) => { const n = { ...prev }; delete n[m.id]; return n; });
                      }}
                      placeholder="https://t.me/c/2123456789/15"
                    />
                    {errByMod[m.id] && <p className="text-xs text-rose-600 mt-1">{errByMod[m.id]}</p>}
                  </div>
                ))}
              </div>
            )}
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
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importReport, setImportReport] = useState<{ created: number; moved: number; alreadyInGroup: number; errors: string[] } | null>(null);
  const [openAdd, setOpenAdd] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

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

  const findProfileId = async (rawValue: string): Promise<string | null> => {
    const v = rawValue.trim().replace(/^@/, "");
    if (!v) return null;
    let q = supabase.from("profiles").select("id").limit(1);
    if (/^\d+$/.test(v)) q = q.eq("telegram_id", Number(v));
    else if (v.includes("@")) q = q.eq("email", v.toLowerCase());
    else q = q.eq("telegram_username", v as any);
    const { data } = await q.maybeSingle();
    return (data as any)?.id ?? null;
  };

  const handleCsv = async (file: File) => {
    setImporting(true);
    setImportReport(null);
    try {
      const text = await file.text();
      const rows = text.split(/\r?\n/).map(r => r.trim()).filter(Boolean);
      const first = rows[0]?.toLowerCase() || "";
      const hasHeader = /email|telegram|username|identifier/.test(first);
      const dataRows = hasHeader ? rows.slice(1) : rows;
      const identifiers = dataRows
        .map(r => r.split(",")[0]?.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);

      let created = 0, moved = 0, alreadyInGroup = 0;
      const errors: string[] = [];
      const toCreate: { email?: string; telegram_username?: string; telegram_user_id?: number }[] = [];

      for (const ident of identifiers) {
        const v = ident.replace(/^@/, "");
        // Try existing match first
        const existingId = await findProfileId(ident);
        if (existingId) {
          // Check if already in this group
          const { data: prof } = await supabase.from("profiles").select("group_id").eq("id", existingId).maybeSingle();
          if ((prof as any)?.group_id === group.id) { alreadyInGroup++; continue; }
          const { error } = await supabase.from("profiles").update({ group_id: group.id }).eq("id", existingId);
          if (error) errors.push(`${ident}: ${error.message}`); else moved++;
        } else {
          // Queue for creation
          if (/^\d+$/.test(v)) toCreate.push({ telegram_user_id: Number(v) });
          else if (v.includes("@")) toCreate.push({ email: v.toLowerCase() });
          else toCreate.push({ telegram_username: v });
        }
      }

      if (toCreate.length > 0) {
        const { data, error } = await supabase.functions.invoke("admin-create-students", {
          body: { students: toCreate, target_group_id: group.id, csv_import: true },
        });
        if (error) {
          errors.push(`create: ${error.message}`);
        } else {
          const results: any[] = (data as any)?.results || [];
          for (const r of results) {
            if (r.status === "created") created++;
            else if (r.status === "updated") moved++;
            else if (r.status === "error" || r.status === "invalid_email") errors.push(`${r.email}: ${r.error || r.status}`);
          }
        }
      }

      setImportReport({ created, moved, alreadyInGroup, errors });
      const total = created + moved + alreadyInGroup;
      toast.success(`${total} ta talaba qo'shildi · ${created} yangi · ${moved} mavjud · ${alreadyInGroup} allaqachon guruhda`);
      if (errors.length) toast.error(`${errors.length} ta xato`);
      reload();
    } catch (e: any) {
      toast.error(e.message || "CSV o'qishda xato");
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
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
          <Button onClick={() => setOpenAdd(true)}><UserPlus className="mr-1 h-4 w-4" />+ Yangi talaba qo'shish</Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 rounded border bg-muted/30 p-2">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleCsv(f); }}
          />
          <Button variant="outline" size="sm" disabled={importing} onClick={() => fileRef.current?.click()}>
            <Upload className="mr-1 h-4 w-4" />{importing ? "Yuklanmoqda…" : "CSV yuklash"}
          </Button>
          <span className="text-xs text-muted-foreground">
            Bitta ustun: email, @username yoki telegram_id (sarlavha ixtiyoriy)
          </span>
        </div>
        {importReport && (
          <div className="text-xs rounded border p-2 space-y-1">
            <div>✨ Yangi: <b>{importReport.created}</b> · 🔄 Mavjud (ko'chirildi): <b>{importReport.moved}</b> · ✅ Allaqachon: <b>{importReport.alreadyInGroup}</b> · ❌ Xato: <b>{importReport.errors.length}</b></div>
            {importReport.errors.length > 0 && (
              <div className="text-rose-600 break-all">{importReport.errors.slice(0, 10).join(" · ")}{importReport.errors.length > 10 ? "…" : ""}</div>
            )}
          </div>
        )}
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
      {openAdd && (
        <AddStudentToGroupDialog
          group={group}
          onClose={() => setOpenAdd(false)}
          onCreated={() => { setOpenAdd(false); reload(); }}
        />
      )}
    </Dialog>
  );
}

function AddStudentToGroupDialog({ group, onClose, onCreated }: { group: Group; onClose: () => void; onCreated: () => void }) {
  const { session } = useAuth();
  const [name, setName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState(randPassword());
  const [tgId, setTgId] = useState("");
  const [tgUser, setTgUser] = useState("");
  const [role, setRole] = useState<"student" | "teacher" | "admin">("student");
  const [sendInvite, setSendInvite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    const tgIdRaw = tgId.trim();
    const tgUserRaw = tgUser.replace(/^@/, "").trim();
    const emailRaw = email.trim();
    if (!emailRaw && !tgIdRaw && !tgUserRaw) {
      setErr("Email, Telegram ID yoki Telegram username dan kamida bittasi kerak");
      return;
    }
    let tgIdNum: number | undefined;
    if (tgIdRaw) {
      const n = Number(tgIdRaw);
      if (!Number.isInteger(n) || n <= 0) { setErr("Telegram ID musbat butun son bo'lishi kerak"); return; }
      tgIdNum = n;
    }
    setBusy(true);
    try {
      // For admin role, do NOT pass target_group_id (admins not tied to group).
      // For teacher/student, pass it — backend assigns teacher_id or group_id accordingly.
      const extra: Record<string, unknown> = role === "admin" ? {} : { target_group_id: group.id };
      const r = await fetch(`${FN_BASE}/admin-create-students`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({
          students: [{
            name,
            last_name: lastName || undefined,
            email: emailRaw,
            password: password || undefined,
            telegram_username: tgUserRaw || undefined,
            telegram_user_id: tgIdNum,
            role,
          }],
          send_invite: sendInvite,
          redirectTo: `${getSiteUrl()}/reset-password`,
          ...extra,
        }),
      });
      const res = await r.json();
      const result = res?.results?.[0];
      const okStatuses = ["created", "updated", "matched", "skipped_already_in_group"];
      if (result && okStatuses.includes(result.status)) {
        toast.success(role === "teacher" ? "Ustoz qo'shildi" : role === "admin" ? "Admin qo'shildi" : "Talaba qo'shildi");
        onCreated();
      } else {
        setErr(result?.error || res?.error || "Qo'shishda xatolik");
      }
    } catch (e: any) {
      setErr(e?.message || "Tarmoq xatosi");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Yangi foydalanuvchi qo'shish · {group.name}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5"><Label>Ism</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Familiya</Label><Input value={lastName} onChange={(e) => setLastName(e.target.value)} /></div>
          </div>
          <div className="space-y-1.5">
            <Label>Email (ixtiyoriy)</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="optional" />
          </div>
          <div className="space-y-1.5">
            <Label>Parol</Label>
            <div className="flex gap-2">
              <Input value={password} onChange={(e) => setPassword(e.target.value)} />
              <Button type="button" variant="outline" size="icon" onClick={() => setPassword(randPassword())}><RefreshCw className="h-4 w-4" /></Button>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Telegram ID</Label>
            <Input value={tgId} onChange={(e) => setTgId(e.target.value.replace(/[^\d]/g, ""))} inputMode="numeric" placeholder="123456789" />
          </div>
          <div className="space-y-1.5">
            <Label>Telegram username (ixtiyoriy)</Label>
            <Input value={tgUser} onChange={(e) => setTgUser(e.target.value)} placeholder="@username" />
          </div>
          <div className="space-y-1.5">
            <Label>Rol</Label>
            <Select value={role} onValueChange={(v) => setRole(v as any)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="student">Talaba</SelectItem>
                <SelectItem value="teacher">Ustoz</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {role !== "admin" && (
            <div className="space-y-1.5">
              <Label>{role === "teacher" ? "Mas'ul guruh" : "Guruh"}</Label>
              <Input value={group.name} disabled readOnly />
              {role === "teacher" && (
                <p className="text-xs text-muted-foreground">Yangi guruhga biriktirish eski guruhni o'zgartirmaydi</p>
              )}
            </div>
          )}
          <label className="flex items-center gap-2 text-sm cursor-pointer pt-1">
            <Checkbox checked={sendInvite} onCheckedChange={(v) => setSendInvite(!!v)} />
            Magic link yuborish
          </label>
          {err && <div className="text-sm text-destructive border border-destructive/40 rounded p-2 bg-destructive/10">{err}</div>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Bekor qilish</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Saqlanmoqda…" : "Saqlash"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
