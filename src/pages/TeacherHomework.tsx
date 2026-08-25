import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { VoiceRecorder } from "@/components/homework/VoiceRecorder";
import { uploadFeedbackVoice, removeFeedbackVoice } from "@/lib/homeworkAudio";
import { notifyGradeVoice, type QueueMedia } from "@/lib/teacherApi";
import { GradePhoto } from "@/components/teacher/GradePhoto";

interface Row {
  id: string; assignment_id: string; user_id: string;
  submitted_text: string; submitted_image_url: string | null;
  // Full multi-media array (photo/video/document/link) — populated by load()'s select("*"). Rendered
  // via the shared GradePhoto gallery so the web grading Drawer shows video/documents, not just images.
  media?: QueueMedia[] | null;
  submitted_at: string; score: number | null; score_feedback: string | null; is_late: boolean;
  scored_at: string | null;
  user_name: string; user_group: string | null; assignment_title: string; max_score: number;
  // Task 3 (voice-homework-feedback): populated by `load()`'s `select("*")` once the column exists
  // (no query change needed there); optional since older in-flight rows may predate the column.
  score_feedback_voice_path?: string | null;
}

interface Group { id: string; name: string; course_id: string | null; }
interface Student { id: string; name: string | null; last_name: string | null; group_id: string | null; telegram_username?: string | null; }
interface ModuleRow { id: string; title: string; position: number; course_id: string; }
interface Assignment { id: string; module_id: string; task_number: number; sap_number: number | null; parent_id: string | null; max_score: number; title: string; }

const ALL = "__ALL__";

export default function TeacherHomework() {
  const { user, role } = useAuth();
  const isAdmin = role === "admin";
  const [groups, setGroups] = useState<Group[]>([]);
  const [courses, setCourses] = useState<{ id: string; title: string }[]>([]);
  const [selectedCourse, setSelectedCourse] = useState<string>("");
  const [selectedGroup, setSelectedGroup] = useState<string>("");
  const [pending, setPending] = useState<Row[]>([]);
  const [scored, setScored] = useState<Row[]>([]);
  const [open, setOpen] = useState<Row | null>(null);
  const [drawerRows, setDrawerRows] = useState<Row[] | null>(null);
  const [drawerTitle, setDrawerTitle] = useState<string>("");

  // Matrix state
  const [students, setStudents] = useState<Student[]>([]);
  const [modules, setModules] = useState<ModuleRow[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [submissions, setSubmissions] = useState<any[]>([]);
  const [groupNameMap, setGroupNameMap] = useState<Map<string, string>>(new Map());

  // Load groups for the selector
  useEffect(() => {
    (async () => {
      if (!user) return;
      // Groups RLS is admin-only ("groups admin all"), so a direct groups read returns ZERO rows
      // for a teacher — even filtered by id — leaving the group picker empty. Admins read groups
      // directly; teachers go through the junction-aware teacher_groups RPC (primary ∪ co-teacher).
      // teacher_groups carries no course_id; it's resolved lazily per selected group below.
      let gs: Group[] = [];
      if (isAdmin) {
        const { data } = await supabase.from("groups").select("id, name, course_id").order("name");
        gs = (data || []) as Group[];
      } else {
        const { data: tgRows } = await supabase.rpc("teacher_groups" as any, { uid: user.id });
        gs = (((tgRows as any[]) || []).map((r: any) => ({
          id: r.group_id as string, name: r.group_name as string, course_id: null,
        }))) as Group[];
      }
      setGroups(gs);
      setGroupNameMap(new Map(gs.map((g) => [g.id, g.name])));
      if (gs.length && !selectedGroup) setSelectedGroup(isAdmin ? ALL : gs[0].id);
      if (!gs.length && isAdmin) setSelectedGroup(ALL);
      // course filter (admin): default to last-opened, else first course
      if (isAdmin) {
        const { data: cs } = await supabase.from("courses").select("id, title").order("created_at");
        const courseList = ((cs as any) || []) as { id: string; title: string }[];
        setCourses(courseList);
        if (courseList.length) {
          const saved = localStorage.getItem("hw_course");
          setSelectedCourse((prev) => prev || (saved && courseList.some((c) => c.id === saved) ? saved : courseList[0].id));
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, isAdmin]);

  // Compute scope (student user_ids) from selected group
  const [scopeIds, setScopeIds] = useState<string[] | null>(null);
  useEffect(() => {
    (async () => {
      if (!user || !selectedGroup) return;
      let pq = supabase.from("profiles").select("id, name, last_name, group_id, telegram_username");
      if (selectedGroup === ALL) {
        // scope to the selected course's groups (admin) so it's one clean course at a time
        const gIds = groups.filter((g) => !isAdmin || !selectedCourse || g.course_id === selectedCourse).map((g) => g.id);
        if (!gIds.length) { setStudents([]); setScopeIds([]); return; }
        pq = pq.in("group_id", gIds);
      } else {
        pq = pq.eq("group_id", selectedGroup);
      }
      const { data } = await pq;
      const sts = (data || []) as Student[];
      sts.sort((a, b) => (a.last_name || a.name || "").localeCompare(b.last_name || b.name || ""));
      setStudents(sts);
      setScopeIds(sts.map((s) => s.id));
    })();
  }, [selectedGroup, user, isAdmin, groups, selectedCourse]);

  // Load modules + assignments based on group's course (or all if admin/ALL)
  useEffect(() => {
    (async () => {
      let courseIds: string[] | null = null;
      if (selectedGroup && selectedGroup !== ALL) {
        const g = groups.find((x) => x.id === selectedGroup);
        let cid = g?.course_id ?? null;
        if (!cid && !isAdmin) {
          // Teacher groups (from teacher_groups RPC) carry no course_id — resolve the selected
          // group's course via the junction-gated staff_group_overview RPC (a direct groups read
          // is RLS-blocked for teachers). Without this, modules would load across ALL courses.
          const { data: ov } = await supabase.rpc("staff_group_overview" as any, { _group_id: selectedGroup });
          cid = ((ov as any[]) || [])[0]?.course_id ?? null;
        }
        if (cid) courseIds = [cid];
      } else if (selectedCourse) {
        courseIds = [selectedCourse];
      }
      let mq = supabase.from("modules").select("id, title, position, course_id").order("position");
      if (courseIds) mq = mq.in("course_id", courseIds);
      const { data: mods } = await mq;
      const modList = (mods || []) as ModuleRow[];
      setModules(modList);
      if (!modList.length) { setAssignments([]); return; }
      const { data: asgns } = await supabase
        .from("homework_assignments")
        .select("id, module_id, task_number, sap_number, parent_id, max_score, title")
        .in("module_id", modList.map((m) => m.id))
        .eq("is_active", true);
      setAssignments((asgns || []) as Assignment[]);
    })();
  }, [selectedGroup, groups, selectedCourse, isAdmin]);

  const load = async () => {
    if (scopeIds === null) return;
    if (scopeIds.length === 0) { setPending([]); setScored([]); setSubmissions([]); return; }
    // Paginate: PostgREST caps a single response at 1000 rows. At 560 students
    // (esp. admin "Barcha guruhlar") one query silently truncated, hiding
    // submitted work and dropping the oldest-ungraded items from the Pending tab.
    const pageSize = 1000;
    let all: any[] = [];
    for (let from = 0; ; from += pageSize) {
      const { data: page } = await supabase
        .from("homework_submissions")
        .select("*")
        .in("user_id", scopeIds)
        .order("submitted_at", { ascending: false })
        .range(from, from + pageSize - 1);
      const rows = (page || []) as any[];
      all = all.concat(rows);
      if (rows.length < pageSize) break;
    }
    setSubmissions(all);
    if (!all.length) { setPending([]); setScored([]); return; }
    const aIds = Array.from(new Set(all.map((s) => s.assignment_id)));
    const uIds = Array.from(new Set(all.map((s) => s.user_id)));
    const [{ data: assigns }, { data: profs }] = await Promise.all([
      supabase.from("homework_assignments").select("id, title, max_score, task_number, sap_number, parent_id").in("id", aIds),
      supabase.from("profiles").select("id, name, last_name, group_id").in("id", uIds),
    ]);
    const aMap = new Map((assigns || []).map((a: any) => [a.id, a]));
    const parentIds = Array.from(new Set((assigns || []).map((a: any) => a.parent_id).filter(Boolean)));
    let parentMap = new Map<string, any>();
    if (parentIds.length) {
      const { data: parents } = await supabase.from("homework_assignments").select("id, title, task_number").in("id", parentIds);
      parentMap = new Map((parents || []).map((p: any) => [p.id, p]));
    }
    const pMap = new Map((profs || []).map((p: any) => [p.id, p]));
    const enriched: Row[] = all.map((s: any) => {
      const a: any = aMap.get(s.assignment_id) || {};
      const p: any = pMap.get(s.user_id) || {};
      let label = a.title || "";
      if (a.parent_id) {
        const par: any = parentMap.get(a.parent_id) || {};
        label = `V${par.task_number ?? "?"}.S${a.sap_number ?? "?"} — ${a.title || ""}`;
      } else if (a.task_number) {
        label = `V${a.task_number} — ${a.title || ""}`;
      }
      return {
        ...s,
        assignment_title: label,
        max_score: a.max_score || 10,
        user_name: [p.name, p.last_name].filter(Boolean).join(" ") || "—",
        user_group: p.group_id ? (groupNameMap.get(p.group_id) as string) : null,
      };
    });
    // A resubmitted item keeps its old score but has score_is_stale=true; treat
    // it as pending so re-opened work resurfaces for grading instead of hiding
    // in "Baholangan" looking done.
    setPending(enriched.filter((r) => r.score == null || (r as any).score_is_stale === true));
    setScored(enriched.filter((r) => r.score != null && (r as any).score_is_stale !== true));
  };
  useEffect(() => { load(); }, [scopeIds]);

  // `voicePath` (Task 3, voice-homework-feedback) is additive: Drawer resolves it BEFORE calling
  // (uploads a new recording first, or carries forward the unchanged/cleared existing path) and it
  // lands in the SAME update as the untouched score/score_feedback/scored_by/scored_at/score_is_stale
  // columns. "undefined = preserve" (fix round 1, consistency with submitScore): Drawer always
  // resolves and passes a defined value (it loads the existing path), but the column is only
  // written when voicePath !== undefined. `score_feedback_voice_path` isn't in the generated types
  // yet → `as any` on the payload.
  // `voiceJustUploaded` (Task 6, voice-homework-feedback): true only when the Drawer uploaded a
  // BRAND NEW recording this round (not a preserved-existing or cleared-to-null path) — gates the
  // fire-and-forget Telegram push below so a plain regrade / voice-removal never re-sends a DM.
  const saveScore = async (
    id: string, score: number, feedback: string, voicePath?: string | null, voiceJustUploaded?: boolean,
  ) => {
    const max = open?.max_score || 10;
    if (!Number.isFinite(score) || score < 0 || score > max) { toast.error(`Bal 0–${max} bo'lishi kerak`); return; }
    const update: Record<string, unknown> = {
      score, score_feedback: feedback || null, scored_by: user?.id, scored_at: new Date().toISOString(),
      score_is_stale: false,
    };
    if (voicePath !== undefined) update.score_feedback_voice_path = voicePath;
    /* eslint-disable-next-line no-restricted-syntax -- already 0-row-guarded via .select("id").maybeSingle() (the #111 grade-write pattern mutate() generalizes); grade-write consolidation is a deferred step. */
    const { data: saved, error } = await supabase
      .from("homework_submissions").update(update as any).eq("id", id).select("id").maybeSingle();
    if (error) { toast.error(error.message); return; }
    // 0 rows + no error = RLS-filtered write (not a teacher of this student / reassigned out of scope):
    // the grade did NOT save. Surface it instead of a false "Baholandi" that leaves the card in the queue.
    if (!saved) { toast.error("Baho saqlanmadi — ro'yxatni yangilang."); return; }
    // Fire-and-forget: never awaited, never allowed to affect the save UX (notifyGradeVoice
    // swallows its own errors; the edge fn itself is fully graceful on no-telegram/blocked-bot).
    if (voiceJustUploaded) notifyGradeVoice(id);
    toast.success("Baholandi"); setOpen(null); setDrawerRows(null); load();
  };

  const reset = async (id: string) => {
    const { error } = await supabase.rpc("start_homework_resubmission", { p_submission_id: id });
    if (error) toast.error(error.message);
    else { toast.success("Talabaga qayta topshirish uchun qaytarildi"); setOpen(null); setDrawerRows(null); load(); }
  };

  // Build matrix lookup: user_id -> module_id -> ordered submissions
  const matrix = useMemo(() => {
    const asgnById = new Map(assignments.map((a) => [a.id, a]));
    const m = new Map<string, Map<string, any[]>>();
    for (const s of submissions) {
      const a = asgnById.get(s.assignment_id);
      if (!a) continue;
      if (!m.has(s.user_id)) m.set(s.user_id, new Map());
      const sub = m.get(s.user_id)!;
      if (!sub.has(a.module_id)) sub.set(a.module_id, []);
      sub.get(a.module_id)!.push(s);
    }
    // sort each cell by task_number, sap_number, submitted_at
    for (const sub of m.values()) {
      for (const arr of sub.values()) {
        arr.sort((x, y) => {
          const ax = asgnById.get(x.assignment_id)!;
          const ay = asgnById.get(y.assignment_id)!;
          if (ax.task_number !== ay.task_number) return ax.task_number - ay.task_number;
          const sx = ax.sap_number ?? -1;
          const sy = ay.sap_number ?? -1;
          if (sx !== sy) return sx - sy;
          return new Date(x.submitted_at).getTime() - new Date(y.submitted_at).getTime();
        });
      }
    }
    return m;
  }, [submissions, assignments]);

  const openCell = (studentId: string, moduleId: string) => {
    const cell = matrix.get(studentId)?.get(moduleId) || [];
    if (!cell.length) return;
    const asgnById = new Map(assignments.map((a) => [a.id, a]));
    const parentIds = Array.from(new Set(assignments.map((a) => a.parent_id).filter(Boolean) as string[]));
    const parentMap = new Map(assignments.filter((a) => parentIds.includes(a.id)).map((a) => [a.id, a]));
    const student = students.find((s) => s.id === studentId);
    const userName = [student?.name, student?.last_name].filter(Boolean).join(" ") || "—";
    const moduleTitle = modules.find((m) => m.id === moduleId)?.title || "Module";

    const rows: Row[] = cell.map((s: any) => {
      const a = asgnById.get(s.assignment_id)!;
      let label = a.title || "";
      if (a.parent_id) {
        const par: any = parentMap.get(a.parent_id) || {};
        label = `V${par.task_number ?? "?"}.S${a.sap_number ?? "?"} — ${a.title || ""}`;
      } else if (a.task_number) {
        label = `V${a.task_number} — ${a.title || ""}`;
      }
      return {
        ...s,
        assignment_title: label,
        max_score: a.max_score || 10,
        user_name: userName,
        user_group: student?.group_id ? (groupNameMap.get(student.group_id) as string) : null,
      };
    });
    setDrawerTitle(`${userName} — ${moduleTitle}`);
    setDrawerRows(rows);
  };

  return (
    <PageShell>
      <div className="max-w-6xl space-y-5">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <h1 className="text-3xl font-semibold tracking-tight">📝 Uy vazifalari</h1>
          <div className="flex items-center gap-2 flex-wrap">
            {isAdmin && courses.length > 1 && (
              <>
                <Label className="text-sm text-muted-foreground">Kurs</Label>
                <Select value={selectedCourse} onValueChange={(v) => { setSelectedCourse(v); localStorage.setItem("hw_course", v); setSelectedGroup(ALL); }}>
                  <SelectTrigger className="w-[200px]"><SelectValue placeholder="Kurs" /></SelectTrigger>
                  <SelectContent>
                    {courses.map((c) => <SelectItem key={c.id} value={c.id}>{c.title}</SelectItem>)}
                  </SelectContent>
                </Select>
              </>
            )}
            <Label className="text-sm text-muted-foreground">Guruh</Label>
            <Select value={selectedGroup} onValueChange={setSelectedGroup}>
              <SelectTrigger className="w-[220px]"><SelectValue placeholder="Guruhni tanlang" /></SelectTrigger>
              <SelectContent>
                {isAdmin && <SelectItem value={ALL}>Barcha guruhlar</SelectItem>}
                {groups.filter((g) => !isAdmin || !selectedCourse || g.course_id === selectedCourse).map((g) => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        <Tabs defaultValue="modules">
          <TabsList>
            <TabsTrigger value="modules">📦 Modul bo'yicha ({modules.length})</TabsTrigger>
            <TabsTrigger value="students">👥 Talabalar ({students.length})</TabsTrigger>
            <TabsTrigger value="pending">Kutilmoqda ({pending.length})</TabsTrigger>
            <TabsTrigger value="scored">Baholangan ({scored.length})</TabsTrigger>
          </TabsList>
          <TabsContent value="modules">
            <ModuleHomeworkView
              students={students}
              modules={modules}
              assignments={assignments}
              submissions={submissions}
            />
          </TabsContent>
          <TabsContent value="students">
            <StudentMatrix
              students={students}
              modules={modules}
              assignments={assignments}
              matrix={matrix}
              showGroup={selectedGroup === ALL}
              groupNameMap={groupNameMap}
              onCellClick={openCell}
            />
          </TabsContent>
          <TabsContent value="pending"><FlatTable rows={pending} onOpen={setOpen} /></TabsContent>
          <TabsContent value="scored"><FlatTable rows={scored} onOpen={setOpen} scored /></TabsContent>
        </Tabs>
      </div>

      <Sheet open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
          {open && <Drawer row={open} onSave={saveScore} onReset={reset} />}
        </SheetContent>
      </Sheet>

      <Sheet open={!!drawerRows} onOpenChange={(o) => !o && setDrawerRows(null)}>
        <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
          {drawerRows && (
            <>
              <SheetHeader><SheetTitle>{drawerTitle}</SheetTitle></SheetHeader>
              <div className="space-y-3 mt-4">
                {drawerRows.map((r) => (
                  <Card key={r.id} className="p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-medium text-sm">{r.assignment_title}</div>
                      <div className="text-xs tabular-nums">
                        {r.score != null ? <span className="font-semibold">{r.score}/{r.max_score}</span> : <span className="text-muted-foreground">⏳ baholanmagan</span>}
                      </div>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => setOpen(r)}>Ko'rish / baholash</Button>
                  </Card>
                ))}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </PageShell>
  );
}

function StudentMatrix({
  students, modules, assignments, matrix, showGroup, groupNameMap, onCellClick,
}: {
  students: Student[]; modules: ModuleRow[]; assignments: Assignment[];
  matrix: Map<string, Map<string, any[]>>;
  showGroup: boolean; groupNameMap: Map<string, string>;
  onCellClick: (studentId: string, moduleId: string) => void;
}) {
  // leaves per module: a leaf is a SAP if any exist for the task, otherwise the parent task itself
  const leavesByModule = useMemo(() => {
    const m = new Map<string, Assignment[]>();
    for (const mod of modules) {
      const inMod = assignments.filter((a) => a.module_id === mod.id);
      const saps = inMod.filter((a) => a.parent_id);
      const tasks = inMod.filter((a) => !a.parent_id);
      const leaves: Assignment[] = [];
      for (const t of tasks) {
        const childSaps = saps.filter((s) => s.parent_id === t.id);
        if (childSaps.length) leaves.push(...childSaps);
        else leaves.push(t);
      }
      leaves.sort((a, b) => (a.task_number - b.task_number) || ((a.sap_number ?? -1) - (b.sap_number ?? -1)));
      m.set(mod.id, leaves);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modules, assignments]);

  if (!students.length) {
    return <Card className="p-8 text-center text-muted-foreground">Bu guruhda talabalar yo'q.</Card>;
  }
  if (!modules.length) {
    return <Card className="p-8 text-center text-muted-foreground">Modullar topilmadi.</Card>;
  }

  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs text-muted-foreground">
          <tr>
            <th className="text-left px-3 py-2 sticky left-0 bg-muted/40 z-10">Talaba</th>
            {showGroup && <th className="text-left px-3 py-2">Guruh</th>}
            {modules.map((m) => (
              <th key={m.id} className="text-left px-3 py-2 whitespace-nowrap">{m.position + 1}-modul</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {students.map((s) => {
            const name = [s.name, s.last_name].filter(Boolean).join(" ") || "—";
            return (
              <tr key={s.id} className="border-t">
                <td className="px-3 py-2.5 sticky left-0 bg-background font-medium">{name}</td>
                {showGroup && <td className="px-3 py-2.5 text-muted-foreground">{s.group_id ? groupNameMap.get(s.group_id) : "—"}</td>}
                {modules.map((m) => {
                  const cell = matrix.get(s.id)?.get(m.id) || [];
                  const leaves = leavesByModule.get(m.id) || [];
                  return (
                    <td key={m.id} className="px-3 py-2.5">
                      <Cell cell={cell} leaves={leaves} onClick={() => onCellClick(s.id, m.id)} />
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

function Cell({ cell, leaves, onClick }: { cell: any[]; leaves: Assignment[]; onClick: () => void }) {
  if (!cell.length) return <span className="text-muted-foreground">— topshirilmagan</span>;
  const isMulti = leaves.length > 1;
  const allGraded = cell.every((s) => s.score != null);
  const anyGraded = cell.some((s) => s.score != null);
  const status = allGraded ? "✅" : anyGraded ? "🟡" : "⏳";
  const totalMax = leaves.reduce((sum, l) => sum + (l.max_score || 10), 0);

  let body: string;
  if (isMulti) {
    body = cell.map((s) => (s.score != null ? `${s.score}` : "⏳")).join(", ");
  } else {
    const max = cell[0].max_score || leaves[0]?.max_score || 10;
    body = cell[0].score != null ? `${cell[0].score}/${max}` : `⏳/${max}`;
  }
  return (
    <button
      onClick={onClick}
      className="text-left hover:bg-muted/50 px-2 py-1 rounded transition-colors tabular-nums"
      title={isMulti ? `Jami: ${totalMax}` : undefined}
    >
      <span className="mr-1">{status}</span>
      <span>{body}</span>
    </button>
  );
}

function FlatTable({ rows, onOpen, scored }: { rows: Row[]; onOpen: (r: Row) => void; scored?: boolean }) {
  if (!rows.length) return <Card className="p-8 text-center text-muted-foreground">Baholash uchun vazifa yo'q.</Card>;
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs text-muted-foreground">
          <tr>
            <th className="text-left px-3 py-2">Talaba</th>
            <th className="text-left px-3 py-2">Guruh</th>
            <th className="text-left px-3 py-2">Vazifa</th>
            <th className="text-left px-3 py-2">Topshirilgan</th>
            {scored && <th className="text-right px-3 py-2">Bal</th>}
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t">
              <td className="px-3 py-2.5">{r.user_name}</td>
              <td className="px-3 py-2.5 text-muted-foreground">{r.user_group || "—"}</td>
              <td className="px-3 py-2.5">{r.assignment_title}</td>
              <td className="px-3 py-2.5 text-xs">
                {new Date(r.submitted_at).toLocaleString()} {r.is_late && <Badge variant="destructive" className="ml-1">Kech</Badge>}
              </td>
              {scored && <td className="px-3 py-2.5 text-right tabular-nums font-semibold">{r.score}/{r.max_score}</td>}
              <td className="px-3 py-2.5 text-right">
                <Button size="sm" variant="outline" onClick={() => onOpen(r)}>Ko'rish</Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function Drawer({
  row, onSave, onReset,
}: {
  row: Row;
  onSave: (id: string, s: number, f: string, voicePath?: string | null, voiceJustUploaded?: boolean) => void;
  onReset: (id: string) => void;
}) {
  const [score, setScore] = useState<string>(row.score?.toString() || "");
  const [fb, setFb] = useState(row.score_feedback || "");
  // Task 3 (voice-homework-feedback): `voiceBlob` = a freshly-recorded note pending upload.
  // `existingPath` starts at the row's current column (this Drawer opens for BOTH pending and
  // already-graded rows) and becomes null the moment the teacher removes it; handleSave resolves
  // the final value to write from these two, mirroring how `fb` already pre-fills-then-overwrites.
  const [voiceBlob, setVoiceBlob] = useState<Blob | null>(null);
  const [existingPath, setExistingPath] = useState<string | null>(row.score_feedback_voice_path ?? null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setVoiceBlob(null);
    setExistingPath(row.score_feedback_voice_path ?? null);
  }, [row.id, row.score_feedback_voice_path]);

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      // Captured BEFORE the upload: true only when this round recorded a brand new note (not a
      // preserved-existing or cleared-to-null path) — tells saveScore whether to fire the Task 6
      // Telegram push after the write succeeds.
      const voiceJustUploaded = !!voiceBlob;
      let voicePath: string | null = existingPath;
      if (voiceBlob) {
        try {
          voicePath = await uploadFeedbackVoice(row.user_id, row.id, voiceBlob);
        } catch {
          toast.error("Ovozli izohni yuklab bo'lmadi. Qayta urinib ko'ring.");
          return;
        }
      } else if (existingPath == null && row.score_feedback_voice_path) {
        // Teacher removed a prior note without recording a replacement — best-effort clean up the
        // now-orphaned object (the write carries voicePath=null regardless of this call's outcome).
        void removeFeedbackVoice(row.user_id, row.id);
      }
      onSave(row.id, parseInt(score), fb, voicePath, voiceJustUploaded);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <SheetHeader><SheetTitle>{row.user_name} — {row.assignment_title}</SheetTitle></SheetHeader>
      <div className="space-y-4 mt-4">
        <div className="text-xs text-muted-foreground">
          {new Date(row.submitted_at).toLocaleString()} {row.is_late && <Badge variant="destructive" className="ml-1">Kech topshirilgan</Badge>}
        </div>
        <Card className="p-4 whitespace-pre-wrap text-sm">{row.submitted_text || <span className="text-muted-foreground">(matn yo'q)</span>}</Card>
        {/* Full media gallery (photo/video/document/link + Telegram fallback) — the shared component
            the Mini App grading screen uses (#111), so the web Drawer no longer shows only images. */}
        <GradePhoto submissionId={row.id} media={row.media ?? null} alt={row.assignment_title || "Topshiriq"} />
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-1">
            <Label>Bal (0–{row.max_score})</Label>
            <Input type="number" min={0} max={row.max_score} value={score} onChange={(e) => setScore(e.target.value)} />
          </div>
          <div className="col-span-2">
            <Label>Izoh</Label>
            <Textarea rows={2} value={fb} onChange={(e) => setFb(e.target.value)} />
          </div>
        </div>
        <div className="space-y-2">
          <Label>Ovozli izoh</Label>
          {/* A retained prior note (e.g. graded earlier, or a resubmission) shows as a compact
              removable chip; recording a new one overwrites the same deterministic storage key
              regardless, so no explicit "replace" affordance is needed. */}
          {existingPath && !voiceBlob && (
            <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-2.5 py-1.5 text-xs text-muted-foreground">
              <span className="flex-1 truncate">🎤 Saqlangan ovozli izoh mavjud</span>
              <button type="button" onClick={() => setExistingPath(null)} className="font-medium text-destructive hover:underline">
                O'chirish
              </button>
            </div>
          )}
          <VoiceRecorder value={voiceBlob} onChange={setVoiceBlob} disabled={saving} />
        </div>
        <div className="flex gap-2">
          <Button disabled={saving} onClick={() => void handleSave()}>💾 Saqlash</Button>
          {row.score != null && <Button variant="outline" disabled={saving} onClick={() => onReset(row.id)}>🔓 Talabaga qaytarish</Button>}
        </div>
      </div>
    </>
  );
}

function ModuleHomeworkView({
  students, modules, assignments, submissions,
}: {
  students: Student[];
  modules: ModuleRow[];
  assignments: Assignment[];
  submissions: any[];
}) {
  const [openModuleId, setOpenModuleId] = useState<string | null>(null);

  // assignment_id -> assignment
  const aMap = useMemo(() => new Map(assignments.map((a) => [a.id, a])), [assignments]);

  // Determine "leaf" assignments per module (parent without SAPs OR each SAP).
  const leafIdsByModule = useMemo(() => {
    const m = new Map<string, Set<string>>();
    const parentIdsWithSap = new Set(assignments.filter((a) => a.parent_id).map((a) => a.parent_id as string));
    for (const a of assignments) {
      const isLeaf = a.parent_id !== null || !parentIdsWithSap.has(a.id);
      if (!isLeaf) continue;
      if (!m.has(a.module_id)) m.set(a.module_id, new Set());
      m.get(a.module_id)!.add(a.id);
    }
    return m;
  }, [assignments]);

  // module_id -> user_id -> submissions[]
  const subsByModuleUser = useMemo(() => {
    const m = new Map<string, Map<string, any[]>>();
    for (const s of submissions) {
      const a = aMap.get(s.assignment_id);
      if (!a) continue;
      const leaves = leafIdsByModule.get(a.module_id);
      if (!leaves || !leaves.has(a.id)) continue;
      if (!m.has(a.module_id)) m.set(a.module_id, new Map());
      const um = m.get(a.module_id)!;
      if (!um.has(s.user_id)) um.set(s.user_id, []);
      um.get(s.user_id)!.push(s);
    }
    return m;
  }, [submissions, aMap, leafIdsByModule]);

  const fmtName = (s: Student) => [s.name, s.last_name].filter(Boolean).join(" ") || "—";

  const sortedModules = useMemo(
    () => modules.slice().sort((a, b) => a.position - b.position),
    [modules],
  );

  if (!sortedModules.length) {
    return <Card className="p-6 text-sm text-muted-foreground">Modullar topilmadi.</Card>;
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {sortedModules.map((m) => {
          const um = subsByModuleUser.get(m.id);
          const submittedCount = um ? um.size : 0;
          return (
            <button
              key={m.id}
              onClick={() => setOpenModuleId(m.id)}
              className="text-left rounded-lg border p-4 hover:bg-accent transition-colors"
            >
              <div className="flex items-center gap-2">
                <Badge variant="secondary">📦 {m.position + 1}-modul</Badge>
              </div>
              <div className="mt-1 font-medium truncate">{m.title}</div>
              <div className="mt-2 text-xs text-muted-foreground">
                ✅ Topshirgan: <b>{submittedCount}</b> / 👥 {students.length}
              </div>
            </button>
          );
        })}
      </div>

      <Sheet open={!!openModuleId} onOpenChange={(o) => !o && setOpenModuleId(null)}>
        <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
          {openModuleId && (() => {
            const mod = sortedModules.find((x) => x.id === openModuleId)!;
            const um = subsByModuleUser.get(openModuleId) || new Map<string, any[]>();
            const submittedStudents = students
              .filter((s) => um.has(s.id))
              .sort((a, b) => fmtName(a).localeCompare(fmtName(b)));
            const missingStudents = students
              .filter((s) => !um.has(s.id))
              .sort((a, b) => fmtName(a).localeCompare(fmtName(b)));

            const renderHandle = (s: Student) => {
              const handle = (s.telegram_username || "").trim();
              return handle
                ? <a className="text-primary hover:underline" href={`https://t.me/${handle}`} target="_blank" rel="noreferrer">@{handle}</a>
                : <span className="text-muted-foreground">—</span>;
            };

            return (
              <>
                <SheetHeader>
                  <SheetTitle>📦 {mod.position + 1}-modul — {mod.title}</SheetTitle>
                </SheetHeader>

                <div className="mt-4 space-y-6">
                  <section>
                    <h3 className="font-semibold mb-2">✅ Topshirganlar ({submittedStudents.length})</h3>
                    {submittedStudents.length === 0 ? (
                      <div className="text-sm text-muted-foreground">Hech kim topshirmagan.</div>
                    ) : (
                      <div className="space-y-3">
                        {submittedStudents.map((s) => {
                          const subs = (um.get(s.id) || []).slice().sort((x: any, y: any) => {
                            const ax: any = aMap.get(x.assignment_id);
                            const ay: any = aMap.get(y.assignment_id);
                            return (ax?.task_number || 0) - (ay?.task_number || 0);
                          });
                          return (
                            <div key={s.id} className="rounded-md border p-3">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-medium">{fmtName(s)}</span>
                                {renderHandle(s)}
                              </div>
                              <ul className="mt-2 space-y-1 text-sm">
                                {subs.map((sub: any) => {
                                  const a: any = aMap.get(sub.assignment_id) || {};
                                  const tn = a.task_number || 1;
                                  const lbl = a.parent_id ? `V${tn}.S${a.sap_number ?? "?"}` : `V${tn}`;
                                  return (
                                    <li key={sub.id} className="flex items-start gap-2">
                                      <Badge variant="outline">{lbl}</Badge>
                                      {sub.score == null ? (
                                        <span className="text-muted-foreground">⏳ baholanmagan</span>
                                      ) : (
                                        <span className="font-medium">{sub.score}/{a.max_score || 10}</span>
                                      )}
                                      {sub.score_feedback && (
                                        <span className="text-muted-foreground">— 💬 {sub.score_feedback}</span>
                                      )}
                                    </li>
                                  );
                                })}
                              </ul>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>

                  <section>
                    <h3 className="font-semibold mb-2">❌ Topshirmaganlar ({missingStudents.length})</h3>
                    {missingStudents.length === 0 ? (
                      <div className="text-sm text-muted-foreground">🎉 Hammasi topshirgan.</div>
                    ) : (
                      <ul className="space-y-1 text-sm">
                        {missingStudents.map((s) => (
                          <li key={s.id} className="flex items-center gap-2">
                            <span>{fmtName(s)}</span>
                            {renderHandle(s)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                </div>
              </>
            );
          })()}
        </SheetContent>
      </Sheet>
    </div>
  );
}

