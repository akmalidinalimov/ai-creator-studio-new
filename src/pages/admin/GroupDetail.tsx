import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import Papa from "papaparse";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { getSiteUrl } from "@/lib/siteUrl";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChevronLeft, Pencil, Plus, Upload as UploadIcon, X, UserMinus } from "lucide-react";
import { toast } from "sonner";
import { GroupTopicsSection } from "@/components/admin/GroupTopicsSection";

type Overview = {
  group_id: string;
  group_name: string;
  teacher_id: string | null;
  teacher_name: string | null;
  course_id: string | null;
  course_name: string | null;
  created_at: string;
  total_students: number;
  active_7d: number;
  avg_completion_pct: number;
  avg_score_pct: number;
  health: number;
};

type Member = {
  id: string;
  name: string | null;
  last_name: string | null;
  email: string;
  telegram_username: string | null;
  telegram_id: number | null;
  last_sign_in_at: string | null;
  last_activity_at: string | null;
  completed_lessons: number;
  avg_score: number | null;
};

type ModuleSubmission = {
  module_id: string;
  position: number;
  title: string;
  submitted: number;
  total: number;
};

type Engagement = {
  total_active: number;
  logged_in_count: number;
  active_count: number;
};

const ENGAGEMENT_WINDOW_DAYS = 3;

const FN_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

export default function GroupDetail() {
  const { id } = useParams<{ id: string }>();
  const { session } = useAuth();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);

  // engagement + per-module submission progress for THIS group
  const [moduleSubs, setModuleSubs] = useState<ModuleSubmission[]>([]);
  const [engagement, setEngagement] = useState<Engagement | null>(null);

  // edit teacher / course
  const [teachers, setTeachers] = useState<{ id: string; label: string }[]>([]);
  const [courses, setCourses] = useState<{ id: string; title: string }[]>([]);
  const [editTeacher, setEditTeacher] = useState(false);
  const [editCourse, setEditCourse] = useState(false);
  const [pendingTeacher, setPendingTeacher] = useState<string>("");
  const [pendingCourse, setPendingCourse] = useState<string>("");

  // add by username/id
  const [openAdd, setOpenAdd] = useState(false);
  const [addQuery, setAddQuery] = useState("");
  const [addBusy, setAddBusy] = useState(false);

  // CSV upload
  const [openCsv, setOpenCsv] = useState(false);
  const [csvText, setCsvText] = useState("");
  const [csvRows, setCsvRows] = useState<any[]>([]);
  const [existing, setExisting] = useState<{
    emails: Set<string>; tgIds: Set<number>; tgUsers: Set<string>;
    inGroup: Set<string>; // profile ids already in this group
  }>({ emails: new Set(), tgIds: new Set(), tgUsers: new Set(), inGroup: new Set() });
  const [importing, setImporting] = useState(false);

  // remove
  const [removeMember, setRemoveMember] = useState<Member | null>(null);

  const reload = async () => {
    if (!id) return;
    setLoading(true);
    const [ov, mem, eng, subs] = await Promise.all([
      supabase.rpc("staff_group_overview" as any, { _group_id: id }),
      supabase.rpc("staff_group_members" as any, { _group_id: id }),
      supabase.rpc("admin_group_engagement_stats" as any, { p_window_days: ENGAGEMENT_WINDOW_DAYS, p_group_id: id }),
      supabase.rpc("admin_group_module_submissions" as any, { p_group_id: id }),
    ]);
    const ovRow = Array.isArray(ov.data) ? ov.data[0] : ov.data;
    setOverview((ovRow as Overview) || null);
    setMembers(((mem.data as any[]) || []) as Member[]);

    // engagement: filter all-groups result down to this group
    const engRow = ((eng.data as any[]) || []).find((r: any) => r.group_id === id);
    setEngagement(engRow
      ? {
          total_active: engRow.total_active || 0,
          logged_in_count: engRow.logged_in_count || 0,
          active_count: (engRow.active_count ?? engRow.active_3d_count) || 0,
        }
      : null);

    // per-module submission progress: filter to this group, sort by position
    const mods = ((subs.data as any[]) || [])
      .filter((r: any) => r.group_id === id)
      .map((r: any) => ({
        module_id: r.module_id,
        position: r.module_position,
        title: r.module_title,
        submitted: r.submitted_count || 0,
        total: r.total_students || 0,
      }))
      .sort((a, b) => a.position - b.position);
    setModuleSubs(mods);
    setLoading(false);
  };

  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [id]);

  // load editable lists once
  useEffect(() => {
    (async () => {
      let teacherList: { id: string; label: string }[] = [];
      const { data: roles } = await supabase.from("user_roles").select("user_id").eq("role", "teacher" as any);
      const ids = (roles || []).map((r: any) => r.user_id);
      if (ids.length) {
        const { data: profs } = await supabase.from("profiles").select("id, name, last_name, email").in("id", ids);
        teacherList = (profs || []).map((p: any) => ({
          id: p.id,
          label: [p.name, p.last_name].filter(Boolean).join(" ") || p.email,
        }));
      }
      setTeachers(teacherList);
      const { data: cs } = await supabase.from("courses").select("id, title").order("title");
      setCourses((cs || []) as any);
    })();
  }, []);

  const saveTeacher = async () => {
    if (!id) return;
    const newId = pendingTeacher === "__none__" ? null : pendingTeacher || null;
    const { error } = await supabase.from("groups").update({ teacher_id: newId }).eq("id", id);
    if (error) { toast.error(error.message); return; }
    toast.success("Teacher updated");
    setEditTeacher(false);
    reload();
  };

  const saveCourse = async () => {
    if (!id) return;
    const newId = pendingCourse === "__none__" ? null : pendingCourse || null;
    if (!newId) { toast.error("Course required — a group must belong to a course"); return; }
    const { error } = await supabase.from("groups").update({ course_id: newId }).eq("id", id);
    if (error) { toast.error(error.message); return; }
    toast.success("Course updated");
    setEditCourse(false);
    reload();
  };

  // ---- Add by username/ID ---- v3.14.35: route through admin-create-students so role-exclusivity
  // and duplicate-in-group checks are enforced server-side.
  const handleAddByLookup = async () => {
    if (!id) return;
    const q = addQuery.trim();
    if (!q) return;
    setAddBusy(true);
    try {
      const tgId = /^\d+$/.test(q) ? Number(q) : undefined;
      const tgUser = !tgId ? q.replace(/^@/, "") : undefined;

      // Try to find existing profile so we can pass a name (the function requires name OR contacts).
      let displayName = "";
      let displayLast = "";
      if (tgId) {
        const { data } = await supabase.from("profiles").select("name,last_name").eq("telegram_id", tgId).maybeSingle();
        if (data) { displayName = (data as any).name || ""; displayLast = (data as any).last_name || ""; }
      } else if (tgUser) {
        const { data } = await supabase.from("profiles").select("name,last_name").eq("telegram_username", tgUser as any).maybeSingle();
        if (data) { displayName = (data as any).name || ""; displayLast = (data as any).last_name || ""; }
      }

      const r = await fetch(`${FN_BASE}/admin-create-students`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({
          students: [{
            name: displayName || tgUser || String(tgId || ""),
            last_name: displayLast || undefined,
            email: "",
            telegram_user_id: tgId,
            telegram_username: tgUser,
            role: "student" as const,
          }],
          target_group_id: id,
          target_course_id: overview?.course_id ?? undefined,
        }),
      });
      const res = await r.json();
      const row = (res?.results || [])[0];
      if (!r.ok || !row) { toast.error(res?.error || "Qo'shib bo'lmadi"); return; }
      if (row.status === "role_conflict") { toast.error(row.error || "Rol mos kelmaydi"); return; }
      if (row.status === "already_in_group") { toast.warning(row.error || "Allaqachon shu guruhda"); return; }
      if (row.status === "error" || row.status === "invalid_email") { toast.error(row.error || "Xato"); return; }
      toast.success("Talaba guruhga qo'shildi");
      setAddQuery("");
      setOpenAdd(false);
      reload();
    } finally {
      setAddBusy(false);
    }
  };

  // ---- CSV ----
  const loadExistingForDedup = async () => {
    const emails = new Set<string>();
    const tgIds = new Set<number>();
    const tgUsers = new Set<string>();
    const inGroup = new Set<string>();
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, email, telegram_id, telegram_username, group_id")
        .range(from, from + PAGE - 1);
      if (error || !data || data.length === 0) break;
      for (const p of data as any[]) {
        if (p.email) emails.add(String(p.email).toLowerCase());
        if (p.telegram_id) tgIds.add(Number(p.telegram_id));
        if (p.telegram_username) tgUsers.add(String(p.telegram_username).toLowerCase().replace(/^@/, ""));
        if (p.group_id === id) inGroup.add(p.id);
      }
      if (data.length < PAGE) break;
    }
    setExisting({ emails, tgIds, tgUsers, inGroup });
  };

  const parseCsv = (txt: string) => {
    if (!txt.trim()) { setCsvRows([]); return; }
    const cleaned = txt.replace(/^\uFEFF/, "");
    const parsed = Papa.parse<string[]>(cleaned, { skipEmptyLines: "greedy", delimiter: "," });
    const all = (parsed.data || []) as string[][];
    if (!all.length) { setCsvRows([]); return; }
    const first = all[0].map((c) => (c || "").trim().toLowerCase());
    const hasHeader = first.includes("email") || first.includes("name") || first.includes("telegram_user_id") || first.includes("telegram_username");
    let headerMap: Record<string, number> | null = null;
    let dataRows: { row: string[]; n: number }[];
    if (hasHeader) {
      headerMap = {};
      first.forEach((h, i) => { if (h) headerMap![h] = i; });
      dataRows = all.slice(1).map((r, i) => ({ row: r, n: i + 2 }));
    } else {
      dataRows = all.map((r, i) => ({ row: r, n: i + 1 }));
    }
    const get = (row: string[], key: string, fb: number) =>
      headerMap && headerMap[key] !== undefined ? (row[headerMap[key]] || "").trim() : (row[fb] || "").trim();

    const seenEmail = new Set<string>(), seenTgId = new Set<number>(), seenTgUser = new Set<string>();
    const out = dataRows.map(({ row, n }) => {
      const name = get(row, "name", 0);
      const last_name = get(row, "last_name", 1);
      const email = get(row, "email", 2).toLowerCase();
      const tgIdRaw = get(row, "telegram_user_id", 4);
      let tgUser = get(row, "telegram_username", 5).replace(/^@/, "").toLowerCase();
      const tgId = tgIdRaw && /^\d+$/.test(tgIdRaw.replace(/[^\d]/g, "")) ? Number(tgIdRaw.replace(/[^\d]/g, "")) : undefined;
      const hasEmail = !!email && /^\S+@\S+\.\S+$/.test(email);

      let status: "new" | "moved" | "in_group" | "dup_in_file" | "invalid" = "new";
      let reason = "";

      if (!name) { status = "invalid"; reason = "name required"; }
      else if (!hasEmail && tgId === undefined && !tgUser) { status = "invalid"; reason = "need email/tg id/username"; }
      else if (email && seenEmail.has(email)) { status = "dup_in_file"; }
      else if (tgId !== undefined && seenTgId.has(tgId)) { status = "dup_in_file"; }
      else if (tgUser && seenTgUser.has(tgUser)) { status = "dup_in_file"; }
      else {
        if (email) seenEmail.add(email);
        if (tgId !== undefined) seenTgId.add(tgId);
        if (tgUser) seenTgUser.add(tgUser);
        const exists =
          (email && existing.emails.has(email)) ||
          (tgId !== undefined && existing.tgIds.has(tgId)) ||
          (tgUser && existing.tgUsers.has(tgUser));
        status = exists ? "moved" : "new";
      }

      return { rowNum: n, name, last_name, email, telegram_user_id: tgId, telegram_username: tgUser || undefined, status, reason };
    });
    setCsvRows(out);
  };

  const counts = useMemo(() => {
    const c = { new: 0, moved: 0, dup: 0, invalid: 0 };
    for (const r of csvRows) {
      if (r.status === "new") c.new++;
      else if (r.status === "moved") c.moved++;
      else if (r.status === "dup_in_file") c.dup++;
      else if (r.status === "invalid") c.invalid++;
    }
    return c;
  }, [csvRows]);

  const importCsv = async () => {
    if (!id) return;
    const toSend = csvRows.filter((r) => r.status === "new" || r.status === "moved").map((r) => ({
      name: r.name,
      last_name: r.last_name || undefined,
      email: r.email || "",
      telegram_user_id: r.telegram_user_id,
      telegram_username: r.telegram_username,
      role: "student" as const,
    }));
    if (!toSend.length) return;
    setImporting(true);
    try {
      const r = await fetch(`${FN_BASE}/admin-create-students`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({
          students: toSend,
          target_group_id: id,
          target_course_id: overview?.course_id ?? undefined,
          send_invite: true,
          csv_import: true,
          redirectTo: `${getSiteUrl()}/reset-password`,
        }),
      });
      const res = await r.json();
      if (!r.ok) throw new Error(res?.error || "Import failed");
      const resultsArr: any[] = res?.results || [];
      const created = resultsArr.filter((x) => x.status === "created").length;
      const updated = resultsArr.filter((x) => x.status === "updated").length;
      const skipped = resultsArr.filter((x) => x.status === "skipped_already_in_group" || x.status === "already_in_group").length;
      const failed = resultsArr.filter((x) => x.status === "error" || x.status === "invalid_email" || x.status === "role_conflict");
      const okCount = created + updated + skipped;
      const csvRowsCount = res?.csv_rows ?? toSend.length;
      const groupCountAfter = res?.group_count_after;
      const delta = res?.delta ?? 0;

      if (failed.length === 0 && delta === 0) {
        toast.success(`${created} yangi qo'shildi · ${updated} mavjud foydalanuvchi guruhga ko'chirildi${skipped ? ` · ${skipped} avval guruhda` : ""}`);
      } else {
        // Build expandable details
        const failLines = failed.map((f) => {
          const id = f.identifier_used || f.email || "(unknown)";
          const rn = f.row_index ?? "?";
          return `Qator ${rn}: ${id} — ${f.error || f.status}`;
        });
        const reconcileMsg = delta !== 0 && groupCountAfter != null
          ? `\n⚠️ CSV: ${csvRowsCount} satr, guruhda hozir ${groupCountAfter} talaba (delta: ${delta}). Iltimos, qayta yuklang yoki Tafsilotlarni ko'ring.`
          : "";
        const headline = `⚠️ ${okCount} talaba qo'shildi, ${failed.length} xato`;

        toast.error(headline, {
          duration: 12000,
          description: reconcileMsg ? reconcileMsg.trim() : undefined,
          action: failLines.length > 0 ? {
            label: "Tafsilotlar",
            onClick: () => {
              // Render details in a long-lived toast
              toast.message("Import xatoliklari", {
                duration: 60000,
                description: (
                  <div className="text-xs whitespace-pre-wrap max-h-64 overflow-y-auto font-mono leading-relaxed">
                    {failLines.join("\n")}
                    {reconcileMsg}
                  </div>
                ) as any,
              });
              // Also log to console for copy/paste
              console.log("[CSV import failures]", { request_id: res?.request_id, failed, csv_rows: csvRowsCount, group_count_after: groupCountAfter, delta });
            },
          } : undefined,
        });
      }
      setOpenCsv(false); setCsvText(""); setCsvRows([]);
      reload();
    } catch (e: any) {
      toast.error(e?.message || "Import failed");
    } finally {
      setImporting(false);
    }
  };

  const handleRemove = async () => {
    if (!removeMember) return;
    const { error } = await supabase.from("profiles").update({ group_id: null }).eq("id", removeMember.id);
    if (error) { toast.error(error.message); return; }
    toast.success("Talaba guruhdan chiqarildi");
    setRemoveMember(null);
    reload();
  };

  const localeDate = (s?: string | null) => (s ? new Date(s).toLocaleDateString() : "—");

  return (
    <PageShell>
      <div className="space-y-6">
        <Link to="/admin/groups" className="inline-flex items-center text-sm text-muted-foreground hover:underline">
          <ChevronLeft className="h-4 w-4 mr-1" /> Back to groups
        </Link>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !overview ? (
          <p className="text-sm text-muted-foreground">Group not found or no analytics yet.</p>
        ) : (
          <>
            {/* Rich header */}
            <div className="space-y-2">
              <h1 className="text-2xl sm:text-3xl font-semibold">{overview.group_name}</h1>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  Teacher: <span className="text-foreground font-medium">{overview.teacher_name || "—"}</span>
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => { setPendingTeacher(overview.teacher_id || "__none__"); setEditTeacher(true); }}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </span>
                <span>·</span>
                <span className="inline-flex items-center gap-1">
                  Course: <span className="text-foreground font-medium">{overview.course_name || "—"}</span>
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => { setPendingCourse(overview.course_id || "__none__"); setEditCourse(true); }}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </span>
                <span>·</span>
                <span>Created: {localeDate(overview.created_at)}</span>
              </div>
            </div>

            {/* Stats tiles */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <Card className="p-4"><div className="text-xs text-muted-foreground">Students</div><div className="text-2xl font-semibold">{overview.total_students}</div></Card>
              <Card className="p-4"><div className="text-xs text-muted-foreground">Active 7d</div><div className="text-2xl font-semibold">{overview.active_7d}</div></Card>
              <Card className="p-4"><div className="text-xs text-muted-foreground">Avg completion</div><div className="text-2xl font-semibold">{overview.avg_completion_pct}%</div></Card>
              <Card className="p-4"><div className="text-xs text-muted-foreground">Avg score</div><div className="text-2xl font-semibold">{overview.avg_score_pct}%</div></Card>
              <Card className="p-4"><div className="text-xs text-muted-foreground">Active 7d %</div><div className="text-2xl font-semibold">{overview.total_students > 0 ? Math.round((overview.active_7d / overview.total_students) * 100) : 0}%</div></Card>
            </div>

            {/* Telegram topics */}
            <GroupTopicsSection groupId={id!} />

            {/* Engagement + per-module submission progress */}
            {(() => {
              const eng = engagement;
              const loggedPct = eng && eng.total_active > 0 ? Math.round((eng.logged_in_count / eng.total_active) * 100) : 0;
              const activePct = eng && eng.total_active > 0 ? Math.round((eng.active_count / eng.total_active) * 100) : 0;
              return (
                <Card className="p-4 space-y-4">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <h2 className="text-base font-semibold">📊 Modul topshiriqlari</h2>
                    {eng && (
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 ${
                            eng.total_active === 0 ? "bg-muted text-muted-foreground"
                              : loggedPct < 50 ? "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30"
                              : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30"
                          }`}
                          title="Tizimga kirgan talabalar"
                        >
                          Loggedin: <b>{eng.logged_in_count}/{eng.total_active}</b> ({loggedPct}%)
                        </span>
                        <span
                          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 ${
                            eng.total_active === 0 ? "bg-muted text-muted-foreground"
                              : activePct < 30 ? "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30"
                              : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30"
                          }`}
                          title={`So'nggi ${ENGAGEMENT_WINDOW_DAYS} kunda darsda faol talabalar`}
                        >
                          Faol ({ENGAGEMENT_WINDOW_DAYS} kun): <b>{eng.active_count}/{eng.total_active}</b> ({activePct}%)
                        </span>
                      </div>
                    )}
                  </div>

                  {!overview.course_id ? (
                    <p className="text-sm text-muted-foreground">Bu guruhga kurs biriktirilmagan. Modullar bo'yicha statistika ko'rsatish uchun kurs tanlang.</p>
                  ) : moduleSubs.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Modullar topilmadi.</p>
                  ) : (
                    <div className="space-y-2.5">
                      {moduleSubs.map((m) => {
                        const pct = m.total > 0 ? Math.round((m.submitted / m.total) * 100) : 0;
                        const fillCls = m.total === 0 ? "bg-muted-foreground/30"
                          : pct === 0 ? "bg-rose-400"
                          : pct < 50 ? "bg-amber-500"
                          : "bg-emerald-500";
                        return (
                          <div key={m.module_id} className="flex items-center gap-3">
                            <div className="w-8 shrink-0 text-xs font-medium text-muted-foreground">M{m.position + 1}</div>
                            <div className="min-w-0 flex-1">
                              <div className="text-sm truncate">{m.title}</div>
                              <div className="mt-1 h-1.5 w-full rounded-full bg-muted overflow-hidden">
                                <div className={`h-full ${fillCls}`} style={{ width: `${pct}%` }} />
                              </div>
                            </div>
                            <div className="w-20 shrink-0 text-right text-xs tabular-nums">
                              <span className="font-medium">{m.submitted}/{m.total}</span>
                              <span className="text-muted-foreground"> · {pct}%</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </Card>
              );
            })()}

            {/* Add students actions */}
            <div className="flex flex-col sm:flex-row gap-2">
              <Button onClick={() => setOpenAdd(true)} className="w-full sm:w-auto">
                <Plus className="h-4 w-4 mr-1" /> Talaba qo'shish (username/ID)
              </Button>
              <Button variant="outline" onClick={async () => { await loadExistingForDedup(); setOpenCsv(true); }} className="w-full sm:w-auto">
                <UploadIcon className="h-4 w-4 mr-1" /> CSV yuklash
              </Button>
            </div>

            <div className="text-sm text-muted-foreground">{members.length} talaba</div>

            {/* Mobile: card list */}
            <div className="md:hidden space-y-2">
              {members.length === 0 ? (
                <p className="text-center text-muted-foreground py-6 text-sm">No members.</p>
              ) : members.map((m) => (
                <Card key={m.id} className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{[m.name, m.last_name].filter(Boolean).join(" ") || "—"}</div>
                      <div className="text-xs text-muted-foreground truncate">{m.email}</div>
                      {m.telegram_username && <div className="text-xs text-muted-foreground">@{m.telegram_username}</div>}
                    </div>
                    <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => setRemoveMember(m)}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="flex items-center gap-3 text-xs mt-2">
                    <span><span className="text-muted-foreground">Done:</span> <span className="font-medium">{m.completed_lessons}</span></span>
                    <span><span className="text-muted-foreground">Avg:</span> <span className="font-medium">{m.avg_score ?? "—"}{m.avg_score != null ? "%" : ""}</span></span>
                    {m.last_activity_at
                      ? <span className="text-muted-foreground ml-auto">{new Date(m.last_activity_at).toLocaleDateString()}</span>
                      : <Badge variant="secondary" className="ml-auto text-[10px]">never</Badge>}
                  </div>
                </Card>
              ))}
            </div>

            {/* Desktop: table */}
            <Card className="hidden md:block p-0 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="text-left p-3">Name</th>
                    <th className="text-left p-3">Email</th>
                    <th className="text-left p-3">Telegram</th>
                    <th className="text-left p-3">Last active</th>
                    <th className="text-left p-3">Done</th>
                    <th className="text-left p-3">Avg score</th>
                    <th className="p-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {members.length === 0 ? (
                    <tr><td colSpan={7} className="text-center text-muted-foreground py-6">No members.</td></tr>
                  ) : members.map((m) => (
                    <tr key={m.id} className="border-t">
                      <td className="p-3">{[m.name, m.last_name].filter(Boolean).join(" ") || "—"}</td>
                      <td className="p-3 text-xs">{m.email}</td>
                      <td className="p-3 text-xs">{m.telegram_username ? `@${m.telegram_username}` : "—"}</td>
                      <td className="p-3 text-xs">{m.last_activity_at ? new Date(m.last_activity_at).toLocaleDateString() : <Badge variant="secondary">never</Badge>}</td>
                      <td className="p-3">{m.completed_lessons}</td>
                      <td className="p-3">{m.avg_score ?? "—"}{m.avg_score != null ? "%" : ""}</td>
                      <td className="p-3 text-right">
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setRemoveMember(m)} title="Remove from group">
                          <UserMinus className="h-4 w-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>

            <Button asChild variant="link" size="sm" className="px-0">
              <Link to="/admin/users">Manage members in Users page →</Link>
            </Button>
          </>
        )}

        {/* Edit teacher dialog */}
        <Dialog open={editTeacher} onOpenChange={setEditTeacher}>
          <DialogContent>
            <DialogHeader><DialogTitle>Change teacher</DialogTitle></DialogHeader>
            <Select value={pendingTeacher} onValueChange={setPendingTeacher}>
              <SelectTrigger><SelectValue placeholder="Select teacher" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">— None —</SelectItem>
                {teachers.map((t) => <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setEditTeacher(false)}>Cancel</Button>
              <Button onClick={saveTeacher}>Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Edit course dialog */}
        <Dialog open={editCourse} onOpenChange={setEditCourse}>
          <DialogContent>
            <DialogHeader><DialogTitle>Change course</DialogTitle></DialogHeader>
            <Select value={pendingCourse} onValueChange={setPendingCourse}>
              <SelectTrigger><SelectValue placeholder="Select course" /></SelectTrigger>
              <SelectContent>
                {courses.map((c) => <SelectItem key={c.id} value={c.id}>{c.title}</SelectItem>)}
              </SelectContent>
            </Select>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setEditCourse(false)}>Cancel</Button>
              <Button onClick={saveCourse}>Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Add by username/ID dialog */}
        <Dialog open={openAdd} onOpenChange={setOpenAdd}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Talaba qo'shish</DialogTitle>
              <DialogDescription>telegram username (@user), telegram user id, yoki profil UUID kiriting</DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              placeholder="@username yoki 123456789 yoki uuid"
              value={addQuery}
              onChange={(e) => setAddQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleAddByLookup(); }}
            />
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpenAdd(false)}>Cancel</Button>
              <Button onClick={handleAddByLookup} disabled={addBusy || !addQuery.trim()}>Qo'shish</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* CSV upload dialog */}
        <Dialog open={openCsv} onOpenChange={(o) => { setOpenCsv(o); if (!o) { setCsvText(""); setCsvRows([]); } }}>
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>CSV yuklash — {overview?.group_name}</DialogTitle>
              <DialogDescription>
                Format: <code className="text-[11px]">name,last_name,email,password,telegram_user_id,telegram_username</code>.
                Mavjud foydalanuvchilar guruhga ko'chiriladi, yangi foydalanuvchilar yaratiladi.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <input
                  id="grp-csv-input"
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    const reader = new FileReader();
                    reader.onload = () => {
                      const t = String(reader.result || "");
                      setCsvText(t); parseCsv(t);
                    };
                    reader.readAsText(f);
                    e.target.value = "";
                  }}
                />
                <Button variant="outline" size="sm" onClick={() => document.getElementById("grp-csv-input")?.click()}>
                  <UploadIcon className="h-4 w-4 mr-1" /> Choose CSV file
                </Button>
              </div>
              <Textarea
                rows={6}
                value={csvText}
                onChange={(e) => { setCsvText(e.target.value); parseCsv(e.target.value); }}
                placeholder="Aida,Khan,aida@example.com,,123456789,@aidakhan"
              />
              {csvRows.length > 0 && (
                <>
                  <div className="border rounded-md max-h-60 overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/40 text-xs sticky top-0">
                        <tr>
                          <th className="text-left p-2">#</th>
                          <th className="text-left p-2">Name</th>
                          <th className="text-left p-2">Email</th>
                          <th className="text-left p-2">Telegram</th>
                          <th className="text-left p-2">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {csvRows.slice(0, 50).map((r, i) => (
                          <tr key={i} className={`border-t ${r.status === "invalid" ? "bg-destructive/5" : r.status === "dup_in_file" ? "bg-muted/40" : ""}`}>
                            <td className="p-2 text-xs">{r.rowNum}</td>
                            <td className="p-2">{[r.name, r.last_name].filter(Boolean).join(" ")}</td>
                            <td className="p-2 text-xs">{r.email || "—"}</td>
                            <td className="p-2 text-xs">{r.telegram_username ? `@${r.telegram_username}` : (r.telegram_user_id || "—")}</td>
                            <td className="p-2 text-xs">
                              {r.status === "new" && <Badge>new</Badge>}
                              {r.status === "moved" && <Badge variant="secondary">moved</Badge>}
                              {r.status === "dup_in_file" && <Badge variant="outline">dup in file</Badge>}
                              {r.status === "invalid" && <Badge variant="destructive">{r.reason || "invalid"}</Badge>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {counts.new} yangi · {counts.moved} mavjud guruhga ko'chiriladi · {counts.dup} dub fayl ichida · {counts.invalid} noto'g'ri
                  </div>
                </>
              )}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpenCsv(false)}>Cancel</Button>
              <Button onClick={importCsv} disabled={importing || (counts.new + counts.moved) === 0}>
                {importing ? "Yuklanmoqda…" : `Add ${counts.new + counts.moved} students`}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Remove confirm */}
        <AlertDialog open={!!removeMember} onOpenChange={(o) => !o && setRemoveMember(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove from group?</AlertDialogTitle>
              <AlertDialogDescription>
                {removeMember ? `${[removeMember.name, removeMember.last_name].filter(Boolean).join(" ") || removeMember.email} guruhdan chiqariladi. Hisob o'chirilmaydi.` : ""}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleRemove}>Remove</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </PageShell>
  );
}
