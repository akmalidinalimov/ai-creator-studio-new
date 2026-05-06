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
import { Plus, Pencil, Trash2, Users as UsersIcon, Upload, RefreshCw, UserPlus, Info } from "lucide-react";
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
  last_name?: string | null;
  email: string;
  telegram_username: string | null;
  telegram_id: number | null;
  group_id: string | null;
  status?: string | null;
  role_name?: "student" | "teacher" | "admin" | "superadmin";
};

const roleBadgeFor = (r?: string) => {
  const role = r || "student";
  const map: Record<string, { label: string; cls: string }> = {
    student: { label: "Talaba", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30" },
    teacher: { label: "Ustoz", cls: "bg-sky-500/15 text-sky-700 dark:text-sky-400 border-sky-500/30" },
    admin: { label: "Admin", cls: "bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-500/30" },
    superadmin: { label: "Superadmin", cls: "bg-rose-700/20 text-rose-800 dark:text-rose-300 border-rose-700/40" },
  };
  const m = map[role] || map.student;
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${m.cls}`}>{m.label}</span>;
};

export default function AdminGroups() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [teachers, setTeachers] = useState<ProfileLite[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [logins, setLogins] = useState<Record<string, { logged: number; total: number }>>({});
  const [activeWin, setActiveWin] = useState<Record<string, { active: number; total: number }>>({});
  const [topics, setTopics] = useState<Record<string, { configured: number; total: number }>>({});
  const [hwMods, setHwMods] = useState<Record<string, Array<{ module_id: string; position: number; title: string; submitted: number; total: number }>>>({});
  const [loading, setLoading] = useState(true);
  const [windowDays, setWindowDays] = useState<3 | 7 | 30>(3);

  const [openCreate, setOpenCreate] = useState(false);
  const [editGroup, setEditGroup] = useState<Group | null>(null);
  const [deleteGroup, setDeleteGroup] = useState<Group | null>(null);
  const [studentsGroup, setStudentsGroup] = useState<Group | null>(null);
  const [assignTeacherGroup, setAssignTeacherGroup] = useState<Group | null>(null);

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
    // Per-group engagement stats (loggedin + active in window)
    const { data: ls } = await supabase.rpc("admin_group_engagement_stats" as any, { p_window_days: windowDays });
    const lmap: Record<string, { logged: number; total: number }> = {};
    const amap: Record<string, { active: number; total: number }> = {};
    ((ls as any[]) || []).forEach((r) => {
      lmap[r.group_id] = { logged: r.logged_in_count || 0, total: r.total_active || 0 };
      amap[r.group_id] = { active: (r.active_count ?? r.active_3d_count) || 0, total: r.total_active || 0 };
    });
    setLogins(lmap);
    setActiveWin(amap);

    // Shared homework topic configured per group?
    const groupRows = ((g.data as any[]) || []) as any[];
    const tmap: Record<string, { configured: number; total: number }> = {};
    groupRows.forEach((gg) => {
      tmap[gg.id] = { configured: gg.homework_topic_url ? 1 : 0, total: 1 };
    });
    setTopics(tmap);

    // Per-module homework submission counts per group
    const { data: hw } = await supabase.rpc("admin_group_module_submissions" as any, {});
    const hmap: Record<string, Array<{ module_id: string; position: number; title: string; submitted: number; total: number }>> = {};
    ((hw as any[]) || []).forEach((r) => {
      const arr = hmap[r.group_id] || [];
      arr.push({ module_id: r.module_id, position: r.module_position, title: r.module_title, submitted: r.submitted_count || 0, total: r.total_students || 0 });
      hmap[r.group_id] = arr;
    });
    Object.keys(hmap).forEach((k) => hmap[k].sort((a, b) => a.position - b.position));
    setHwMods(hmap);
    setLoading(false);
  };

  useEffect(() => { reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [windowDays]);

  const courseTitle = (id: string | null) => courses.find((c) => c.id === id)?.title || "—";
  const teacherLabel = (id: string | null) => {
    const t = teachers.find((u) => u.id === id);
    if (!t) return id ? id.slice(0, 8) : "—";
    return t.name || t.email || (t.telegram_username ? `@${t.telegram_username}` : t.id.slice(0, 8));
  };

  return (
    <PageShell>
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold">Groups</h1>
            <p className="text-sm text-muted-foreground">Manage student groups and assign teachers.</p>
          </div>
          <div className="flex items-center gap-2">
            <Label className="text-xs text-muted-foreground">Faollik oynasi</Label>
            <Select value={String(windowDays)} onValueChange={(v) => setWindowDays(Number(v) as 3 | 7 | 30)}>
              <SelectTrigger className="h-9 w-[110px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="3">3 kun</SelectItem>
                <SelectItem value="7">7 kun</SelectItem>
                <SelectItem value="30">30 kun</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={() => setOpenCreate(true)}><Plus className="mr-2 h-4 w-4" />Create group</Button>
          </div>
        </div>

        <Card className="p-0 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Teacher</TableHead>
                <TableHead>Course</TableHead>
                <TableHead>Students</TableHead>
                <TableHead>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex items-center gap-1 cursor-help">Loggedin <Info className="h-3 w-3 text-muted-foreground" /></span>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-xs text-xs">
                      Faol va arxivlangan barcha talabalar hisoblanadi
                    </TooltipContent>
                  </Tooltip>
                </TableHead>
                <TableHead>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex items-center gap-1 cursor-help">Faol ({windowDays} kun) <Info className="h-3 w-3 text-muted-foreground" /></span>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-xs text-xs">
                      So'nggi {windowDays} kunda darsda faol bo'lgan talabalar
                    </TooltipContent>
                  </Tooltip>
                </TableHead>
                <TableHead>Topiklar</TableHead>
                <TableHead>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex items-center gap-1 cursor-help">Vazifalar bo'yicha <Info className="h-3 w-3 text-muted-foreground" /></span>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-xs text-xs">
                      Har bir modul uchun vazifa topshirgan talabalar / jami talabalar
                    </TooltipContent>
                  </Tooltip>
                </TableHead>
                <TableHead>Default</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow><TableCell colSpan={10} className="text-center text-muted-foreground py-8">Loading…</TableCell></TableRow>
              ) : groups.length === 0 ? (
                <TableRow><TableCell colSpan={10} className="text-center text-muted-foreground py-8">No groups yet.</TableCell></TableRow>
              ) : groups.map((g) => {
                const a3 = activeWin[g.id] || { active: 0, total: 0 };
                const aPct = a3.total > 0 ? (a3.active / a3.total) * 100 : 0;
                const aColor = a3.total === 0 ? "bg-muted text-muted-foreground" : a3.active === 0 ? "bg-rose-500 text-white" : aPct < 30 ? "bg-amber-500 text-white" : "bg-emerald-500 text-white";
                return (
                <TableRow key={g.id}>
                  <TableCell className="font-medium">
                    <button className="hover:underline text-left" onClick={() => setEditGroup(g)}>{g.name}</button>
                  </TableCell>
                  <TableCell>
                    {g.teacher_id ? (
                      teacherLabel(g.teacher_id)
                    ) : (
                      <button
                        className="text-xs text-emerald-600 hover:text-emerald-700 hover:underline font-medium inline-flex items-center gap-1"
                        onClick={() => setAssignTeacherGroup(g)}
                      >
                        <Plus className="h-3 w-3" /> Ustoz tayinlash
                      </button>
                    )}
                  </TableCell>
                  <TableCell>{courseTitle(g.course_id)}</TableCell>
                  <TableCell><Badge variant="secondary">{counts[g.id] || 0}</Badge></TableCell>
                  <TableCell>{(() => {
                    const ll = logins[g.id] || { logged: 0, total: 0 };
                    const pct = ll.total > 0 ? (ll.logged / ll.total) * 100 : 0;
                    const cls = ll.total === 0 ? "bg-muted text-muted-foreground" : ll.logged === 0 ? "bg-rose-500 text-white" : pct < 50 ? "bg-amber-500 text-white" : "bg-emerald-500 text-white";
                    return <span className={`inline-block px-2 py-0.5 rounded text-xs ${cls}`} title={`${ll.logged}/${ll.total} kirgan`}>{ll.logged}/{ll.total}</span>;
                  })()}</TableCell>
                  <TableCell><span className={`inline-block px-2 py-0.5 rounded text-xs ${aColor}`} title={`${a3.active}/${a3.total} faol (${windowDays} kun)`}>{a3.active}/{a3.total}{a3.total > 0 ? ` · ${Math.round(aPct)}%` : ""}</span></TableCell>
                  <TableCell>{(() => {
                    const tt = topics[g.id] || { configured: 0, total: 0 };
                    return tt.configured > 0
                      ? <span className="inline-block px-2 py-0.5 rounded text-xs bg-emerald-500 text-white">✓ Topik sozlangan</span>
                      : <span className="inline-block px-2 py-0.5 rounded text-xs bg-rose-500 text-white">✗ Topik yo'q</span>;
                  })()}</TableCell>
                  <TableCell>{(() => {
                    const mods = hwMods[g.id] || [];
                    if (!mods.length) return <span className="text-xs text-muted-foreground">—</span>;
                    const visible = mods.slice(0, 6);
                    const overflow = mods.length - visible.length;
                    return (
                      <div className="flex items-center gap-2 flex-wrap">
                        {visible.map((m) => {
                          const pct = m.total > 0 ? Math.round((m.submitted / m.total) * 100) : 0;
                          const fillCls = m.total === 0 ? "bg-muted-foreground/30" : pct === 0 ? "bg-rose-400" : pct < 50 ? "bg-amber-500" : "bg-emerald-500";
                          return (
                            <Tooltip key={m.module_id}>
                              <TooltipTrigger asChild>
                                <div className="inline-flex items-center gap-1 cursor-help">
                                  <span className="text-[11px] font-medium text-muted-foreground">M{m.position + 1}</span>
                                  <div className="h-1.5 w-10 rounded-full bg-muted overflow-hidden">
                                    <div className={`h-full ${fillCls}`} style={{ width: `${m.total > 0 ? pct : 0}%` }} />
                                  </div>
                                  <span className="text-[11px] tabular-nums">{m.submitted}/{m.total}</span>
                                </div>
                              </TooltipTrigger>
                              <TooltipContent side="top" className="text-xs max-w-[260px]">
                                <div className="font-medium">M{m.position + 1}. {m.title}</div>
                                <div className="text-muted-foreground">{m.submitted}/{m.total} talaba topshirgan ({pct}%)</div>
                              </TooltipContent>
                            </Tooltip>
                          );
                        })}
                        {overflow > 0 && <span className="text-[11px] text-muted-foreground">+{overflow}</span>}
                      </div>
                    );
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
      {assignTeacherGroup && (
        <AddStudentToGroupDialog
          group={assignTeacherGroup}
          initialRole="teacher"
          onClose={() => setAssignTeacherGroup(null)}
          onCreated={() => { setAssignTeacherGroup(null); reload(); }}
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
  const [tgGroupErr, setTgGroupErr] = useState<string>("");
  const [hwTopicUrl, setHwTopicUrl] = useState<string>("");
  const [hwTopicErr, setHwTopicErr] = useState<string>("");

  // Load existing group telegram_group_url + shared homework topic on edit
  useEffect(() => {
    (async () => {
      if (group) {
        const { data: g } = await supabase
          .from("groups")
          .select("telegram_group_url, homework_topic_url")
          .eq("id", group.id)
          .maybeSingle();
        setTgGroupUrl(((g as any)?.telegram_group_url) || "");
        setHwTopicUrl(((g as any)?.homework_topic_url) || "");
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group?.id]);

  const HW_TOPIC_RE = /^https?:\/\/t\.me\/c\/\d+\/(\d+)/;
  const parsedTopicId = (() => {
    const m = hwTopicUrl.trim().match(HW_TOPIC_RE);
    return m ? Number(m[1]) : null;
  })();

  const submit = async () => {
    if (!name.trim()) { toast.error("Name required"); return; }

    let groupErr = "";
    let hwErr = "";
    if (tgGroupUrl.trim() && !TG_URL_RE.test(tgGroupUrl.trim())) {
      groupErr = "URL noto'g'ri (https://t.me/...)";
    }
    if (hwTopicUrl.trim() && !HW_TOPIC_RE.test(hwTopicUrl.trim())) {
      hwErr = "URL noto'g'ri (https://t.me/c/<chat>/<topic>)";
    }
    setTgGroupErr(groupErr);
    setHwTopicErr(hwErr);
    if (groupErr || hwErr) { toast.error("URL formatlarini tekshiring"); return; }

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
        homework_topic_url: hwTopicUrl.trim() || null,
      };
      if (group) {
        const { error } = await supabase.from("groups").update(payload).eq("id", group.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("groups").insert(payload);
        if (error) throw error;
      }

      toast.success("Guruh saqlandi");
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
            <div>
              <Label className="text-xs">Vazifalar topiki URL</Label>
              <Input
                value={hwTopicUrl}
                onChange={(e) => { setHwTopicUrl(e.target.value); setHwTopicErr(""); }}
                placeholder="https://t.me/c/2123456789/65"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Bitta topik barcha vazifalar uchun (yoki bo'sh qoldiring).
              </p>
              {hwTopicErr && <p className="text-xs text-rose-600 mt-1">{hwTopicErr}</p>}
              {parsedTopicId !== null && (
                <p className="text-xs text-emerald-600 mt-1">Topik ID: {parsedTopicId}</p>
              )}
            </div>
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
  const [loginStats, setLoginStats] = useState<{ logged: number; total: number }>({ logged: 0, total: 0 });
  const [includeArchived, setIncludeArchived] = useState(false);
  const [exporting, setExporting] = useState(false);
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
      .select("id,name,last_name,email,telegram_username,telegram_id,group_id,status")
      .eq("group_id", group.id);
    const list = ((data as any[]) || []) as ProfileLite[];
    if (list.length) {
      const ids = list.map((p) => p.id);
      const { data: rs } = await supabase.from("user_roles").select("user_id, role").in("user_id", ids);
      const rank: Record<string, number> = { superadmin: 1, admin: 2, teacher: 3, student: 4 };
      const rolesMap: Record<string, string[]> = {};
      ((rs as any[]) || []).forEach((r) => { (rolesMap[r.user_id] ||= []).push(r.role); });
      list.forEach((p) => {
        const top = (rolesMap[p.id] || []).sort((a, b) => (rank[a] || 99) - (rank[b] || 99))[0];
        p.role_name = (top || "student") as any;
      });
    }
    setStudents(list);
    const { data: ls } = await supabase.rpc("admin_group_login_stats" as any);
    const row = ((ls as any[]) || []).find((r: any) => r.group_id === group.id);
    setLoginStats({ logged: row?.logged_in_count || 0, total: row?.total_active || 0 });
    setLoading(false);
  };
  useEffect(() => { reload(); }, [group.id]);

  const exportCsvWithLogins = async () => {
    setExporting(true);
    try {
      const { data, error } = await supabase.rpc("admin_export_group_csv" as any, { _group_id: group.id, _include_archived: includeArchived });
      if (error) throw error;
      const rows = (data as any[]) || [];
      const headers = ["name","last_name","email","telegram_user_id","telegram_username","role","group_name","first_login_at","last_login_at","has_logged_in","lessons_completed","homework_avg","status","created_at"];
      const escape = (v: unknown) => {
        const s = v === null || v === undefined ? "" : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const csv = [headers.join(","), ...rows.map((r: any) => headers.map((h) => escape(r[h])).join(","))].join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `group_${group.name.replace(/\s+/g, "_")}_logins.csv`; a.click();
      URL.revokeObjectURL(url);
      try {
        const { data: u } = await supabase.auth.getUser();
        await supabase.from("admin_actions" as any).insert({
          actor_user_id: u.user?.id,
          action: "exported_group_csv",
          target_resource_type: "group",
          target_resource_id: group.id,
          details: { row_count: rows.length, has_login_data: true },
        });
      } catch {}
      toast.success(`${rows.length} qator eksport qilindi`);
    } catch (e: any) {
      toast.error(e?.message || "Eksport xatosi");
    } finally {
      setExporting(false);
    }
  };

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
    const sorted = [...students].sort((a, b) =>
      ((a.name || "") + " " + (a.last_name || "")).localeCompare((b.name || "") + " " + (b.last_name || ""))
    );
    if (!s) return sorted;
    return sorted.filter((u) =>
      (u.name || "").toLowerCase().includes(s) ||
      (u.last_name || "").toLowerCase().includes(s) ||
      (u.email || "").toLowerCase().includes(s) ||
      (u.telegram_username || "").toLowerCase().includes(s) ||
      (u.telegram_id ? String(u.telegram_id) : "").includes(s) ||
      (u.role_name || "").toLowerCase().includes(s)
    );
  }, [students, search]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Students in {group.name}</DialogTitle></DialogHeader>
        {(() => {
          const total = loginStats.total;
          const logged = loginStats.logged;
          const never = Math.max(0, total - logged);
          const pct = total > 0 ? Math.round((logged / total) * 100) : 0;
          const color = total === 0 ? "bg-muted" : logged === 0 ? "bg-rose-50 border-rose-200" : pct < 50 ? "bg-amber-50 border-amber-200" : "bg-emerald-50 border-emerald-200";
          return (
            <div className={`rounded border p-3 text-sm ${color}`}>
              <div>✅ Kirgan: <b>{logged}/{total}</b> ({pct}%)</div>
              <div className="text-xs text-muted-foreground mt-0.5">🚫 Hech qachon kirmagan: <b>{never}</b></div>
            </div>
          );
        })()}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setOpenAdd(true)}><UserPlus className="mr-1 h-4 w-4" />+ Yangi talaba qo'shish</Button>
          <Button variant="outline" disabled={exporting} onClick={exportCsvWithLogins}>
            <Upload className="mr-1 h-4 w-4 rotate-180" />{exporting ? "Eksport…" : "CSV (loginlar bilan)"}
          </Button>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
            <Checkbox checked={includeArchived} onCheckedChange={(v) => setIncludeArchived(!!v)} />
            Arxivni ham qo'shish
          </label>
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
        <div className="max-h-[60vh] overflow-auto border rounded">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Last name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Telegram ID</TableHead>
                <TableHead>Telegram</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Group</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? <TableRow><TableCell colSpan={9} className="text-center py-4 text-muted-foreground">Loading…</TableCell></TableRow>
              : filtered.length === 0 ? <TableRow><TableCell colSpan={9} className="text-center py-4 text-muted-foreground">No students.</TableCell></TableRow>
              : filtered.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="font-medium">{u.name || "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{u.last_name || "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{u.email}</TableCell>
                  <TableCell className="text-xs font-mono">{u.telegram_id ?? "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{u.telegram_username ? `@${u.telegram_username}` : "—"}</TableCell>
                  <TableCell>{roleBadgeFor(u.role_name)}</TableCell>
                  <TableCell className="text-xs"><Badge variant="secondary" className="opacity-60">{group.name}</Badge></TableCell>
                  <TableCell>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${u.status === "active" ? "bg-muted" : u.status === "archived" ? "bg-amber-500/10 text-amber-700 dark:text-amber-400" : "bg-destructive/10 text-destructive"}`}>
                      {u.status === "active" ? "Active" : u.status === "archived" ? "Arxiv" : "Inactive"}
                    </span>
                  </TableCell>
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

function AddStudentToGroupDialog({ group, onClose, onCreated, initialRole }: { group: Group; onClose: () => void; onCreated: () => void; initialRole?: "student" | "teacher" | "admin" }) {
  const { session } = useAuth();
  const [name, setName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState(randPassword());
  const [tgId, setTgId] = useState("");
  const [tgUser, setTgUser] = useState("");
  const [role, setRole] = useState<"student" | "teacher" | "admin">(initialRole || "student");
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
