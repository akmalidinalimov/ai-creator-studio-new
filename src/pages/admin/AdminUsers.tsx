import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus, Upload as UploadIcon, Search, Copy, RefreshCw, Trash2, Download, Mail, Unlock, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import Papa from "papaparse";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  last_name?: string | null;
  avatar_url: string | null;
  status: "active" | "inactive";
  telegram_username: string | null;
  telegram_id: number | null;
  created_at: string;
  last_sign_in_at: string | null;
  is_admin: boolean;
}

interface CsvRow {
  rowNum: number;
  name: string;
  last_name?: string;
  email: string;
  password?: string;
  telegram_user_id?: number;
  telegram_username?: string;
  role: "student" | "admin";
  valid: boolean;
  reason?: string;
  duplicate?: boolean;
  duplicateField?: "email" | "telegram_user_id" | "telegram_username";
}

const randPassword = () =>
  Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6).toUpperCase();

const CSV_TEMPLATE = `name,last_name,email,password,telegram_user_id,telegram_username,role
Aida,Khan,aida@example.com,,123456789,@aidakhan,student
Bilol,Karimov,bilol@example.com,SecurePass123!,,,student
Chen,Wei,chen@example.com,,987654321,,student
Dilnoza,Yusupova,dilnoza@example.com,,,,student
Elnur,Aliyev,elnur@example.com,AdminPass456!,555555555,@elnura,admin
`;

const FN_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

export default function AdminUsers() {
  const { t } = useTranslation();
  const { session } = useAuth();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [courses, setCourses] = useState<{ id: string; title: string }[]>([]);
  const [enrollMap, setEnrollMap] = useState<Record<string, Set<string>>>({});
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  // Selection (for bulk actions)
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Add user
  const [openAdd, setOpenAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newLastName, setNewLastName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState(randPassword());
  const [newTg, setNewTg] = useState("");
  const [newTgId, setNewTgId] = useState("");
  const [newRole, setNewRole] = useState<"student" | "admin">("student");
  const [newCourses, setNewCourses] = useState<Set<string>>(new Set());
  const [sendInvite, setSendInvite] = useState(true);
  // CSV
  const [openCsv, setOpenCsv] = useState(false);
  const [csvText, setCsvText] = useState("");
  const [csvParsed, setCsvParsed] = useState<CsvRow[]>([]);
  const [importing, setImporting] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [showDups, setShowDups] = useState(false);
  const [existingTgIds, setExistingTgIds] = useState<Map<number, string>>(new Map()); // tgId -> email
  const [existingEmails, setExistingEmails] = useState<Set<string>>(new Set());
  const [existingTgUsers, setExistingTgUsers] = useState<Set<string>>(new Set()); // lowercased
  // Lockouts
  const [lockedEmails, setLockedEmails] = useState<Set<string>>(new Set());
  // Manage drawer
  const [manageUser, setManageUser] = useState<UserRow | null>(null);
  const [confirmRole, setConfirmRole] = useState<{ user: UserRow; promote: boolean } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<UserRow | null>(null);

  const reload = async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc("admin_list_users");
    if (error) toast.error(error.message);
    const rows = (data || []) as any[];
    // Hydrate last_name from profiles (RPC doesn't return it)
    if (rows.length) {
      const ids = rows.map((u) => u.id);
      const { data: profs } = await supabase.from("profiles").select("id, last_name").in("id", ids);
      const lnMap: Record<string, string | null> = {};
      (profs || []).forEach((p: any) => { lnMap[p.id] = p.last_name; });
      rows.forEach((u) => { u.last_name = lnMap[u.id] || null; });
    }
    setUsers(rows as UserRow[]);
    const { data: cs } = await supabase.from("courses").select("id, title").order("title");
    setCourses(cs || []);
    const { data: enrolls } = await supabase.from("enrollments").select("user_id, course_id");
    const m: Record<string, Set<string>> = {};
    (enrolls || []).forEach((e: any) => {
      if (!m[e.user_id]) m[e.user_id] = new Set();
      m[e.user_id].add(e.course_id);
    });
    setEnrollMap(m);

    // Load active lockouts (emails with 5+ failures in last 10 min)
    const since = new Date(Date.now() - 10 * 60_000).toISOString();
    const { data: la } = await supabase
      .from("login_attempts")
      .select("key, success")
      .eq("kind", "email")
      .gte("created_at", since);
    const fails = new Map<string, number>();
    (la || []).forEach((r: any) => {
      if (!r.success) fails.set(r.key, (fails.get(r.key) || 0) + 1);
    });
    const locked = new Set<string>();
    fails.forEach((n, email) => { if (n >= 5) locked.add(email); });
    setLockedEmails(locked);

    setLoading(false);
  };

  useEffect(() => { reload(); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter((u) => {
      if (statusFilter !== "all" && u.status !== statusFilter) return false;
      if (roleFilter === "admin" && !u.is_admin) return false;
      if (roleFilter === "student" && u.is_admin) return false;
      if (q) {
        return (
          (u.name || "").toLowerCase().includes(q) ||
          (u.last_name || "").toLowerCase().includes(q) ||
          u.email.toLowerCase().includes(q) ||
          (u.telegram_username || "").toLowerCase().includes(q) ||
          (u.telegram_id ? String(u.telegram_id) : "").includes(q)
        );
      }
      return true;
    });
  }, [users, search, statusFilter, roleFilter]);

  const callCreate = async (rows: any[], extra: Record<string, unknown> = {}) => {
    const r = await fetch(`${FN_BASE}/admin-create-students`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify({
        students: rows,
        courseIds: Array.from(newCourses),
        send_invite: sendInvite,
        redirectTo: `${window.location.origin}/reset-password`,
        ...extra,
      }),
    });
    return r.json();
  };

  const handleAdd = async () => {
    if (!newEmail) return;
    let tgId: number | undefined;
    if (newTgId.trim()) {
      const n = Number(newTgId.trim());
      if (!Number.isInteger(n) || n <= 0) {
        toast.error(t("admin.users.tgIdInvalid", { defaultValue: "Telegram ID must be a positive integer" }));
        return;
      }
      tgId = n;
    }
    const res = await callCreate([{
      name: newName,
      last_name: newLastName || undefined,
      email: newEmail,
      password: newPassword || undefined,
      telegram_username: newTg.replace(/^@/, "") || undefined,
      telegram_user_id: tgId,
      role: newRole,
    }]);
    const r = res?.results?.[0];
    if (r?.status === "created") {
      toast.success(r.action_link
        ? t("admin.users.toasts.createdInvite", { email: newEmail })
        : t("admin.users.toasts.created", { email: newEmail }));
      setOpenAdd(false);
      setNewName(""); setNewLastName(""); setNewEmail(""); setNewPassword(randPassword());
      setNewTg(""); setNewTgId(""); setNewRole("student"); setNewCourses(new Set());
      reload();
    } else {
      toast.error(r?.error || res?.error || t("admin.users.toasts.createFailed"));
    }
  };

  const downloadTemplate = () => {
    const blob = new Blob([CSV_TEMPLATE], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "users_import_template.csv";
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast.success(t("admin.users.templateDownloaded"));
  };

  const parseCsv = (txt: string) => {
    if (!txt || !txt.trim()) { setCsvParsed([]); return; }
    // Strip BOM
    const cleaned = txt.replace(/^\uFEFF/, "");
    const parsed = Papa.parse<string[]>(cleaned, {
      skipEmptyLines: "greedy",
      delimiter: ",",
    });
    const allRows = (parsed.data || []) as string[][];
    if (allRows.length === 0) { setCsvParsed([]); return; }

    // Detect header row
    const first = allRows[0].map((c) => (c || "").trim().toLowerCase());
    const hasHeader = first.includes("email") || first.includes("name") || first.includes("telegram_user_id") || first.includes("telegram_username");
    let headerMap: Record<string, number> | null = null;
    let dataRows: { row: string[]; rowNum: number }[];
    if (hasHeader) {
      headerMap = {};
      first.forEach((h, i) => { if (h) headerMap![h] = i; });
      dataRows = allRows.slice(1).map((row, idx) => ({ row, rowNum: idx + 2 }));
    } else {
      dataRows = allRows.map((row, idx) => ({ row, rowNum: idx + 1 }));
    }

    const seenEmails = new Set<string>();
    const seenTgIds = new Set<number>();
    const seenTgUsers = new Set<string>();
    const get = (row: string[], key: string, fallbackIdx: number): string => {
      if (headerMap && headerMap[key] !== undefined) return (row[headerMap[key]] || "").trim();
      return (row[fallbackIdx] || "").trim();
    };

    const rows: CsvRow[] = dataRows.map(({ row, rowNum }) => {
      // Positional fallback (no header): name,last_name,email,password,telegram_user_id,telegram_username,role
      const name = get(row, "name", 0);
      const last_name = get(row, "last_name", 1);
      const emailRaw = get(row, "email", 2).toLowerCase();
      const password = get(row, "password", 3);
      const tgIdRaw = get(row, "telegram_user_id", 4);
      let tgUser = get(row, "telegram_username", 5);
      const roleRaw = (get(row, "role", 6) || "student").toLowerCase();

      // Strip @ from telegram username, lowercase, drop if empty
      tgUser = tgUser.replace(/^@/, "").toLowerCase();

      const validRole = roleRaw === "admin" || roleRaw === "student";
      const role = (validRole ? roleRaw : "student") as "student" | "admin";

      // telegram_user_id parsing (bigint)
      let tgId: number | undefined;
      let tgIdReason: string | undefined;
      if (tgIdRaw) {
        const cleanedNum = tgIdRaw.replace(/[^\d]/g, "");
        if (!cleanedNum || !/^\d+$/.test(cleanedNum)) {
          tgIdReason = t("admin.users.csvErr.tgIdInvalid", { defaultValue: "telegram_user_id is not a valid bigint" });
        } else {
          const n = Number(cleanedNum);
          if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n <= 0) {
            tgIdReason = t("admin.users.csvErr.tgIdInvalid", { defaultValue: "telegram_user_id is not a valid bigint" });
          } else {
            tgId = n;
          }
        }
      }

      // Email format (optional, but if provided must be valid)
      const hasEmail = !!emailRaw;
      const emailFormatOk = !hasEmail || /^\S+@\S+\.\S+$/.test(emailRaw);
      const hasTgUser = !!tgUser;

      // Determine validity: name + at least one identifier (email | tgId | tgUser)
      let valid = true;
      let reason: string | undefined;
      let duplicate = false;
      let duplicateField: "email" | "telegram_user_id" | "telegram_username" | undefined;

      if (!name || !name.trim()) {
        valid = false;
        reason = t("admin.users.csvErr.nameRequired", { defaultValue: "name is required" });
      } else if (!hasEmail && tgId === undefined && !hasTgUser) {
        valid = false;
        reason = t("admin.users.csvErr.needIdentifier", { defaultValue: "Need at least one identifier" });
      } else if (hasEmail && !emailFormatOk) {
        valid = false;
        reason = t("admin.users.csvErr.emailInvalid", { defaultValue: "email format invalid" });
      } else if (tgIdReason) {
        valid = false;
        reason = tgIdReason;
      } else if (hasEmail && seenEmails.has(emailRaw)) {
        valid = false;
        reason = t("admin.users.csvErr.dupEmail", { defaultValue: "duplicate email within file" });
      } else if (tgId !== undefined && seenTgIds.has(tgId)) {
        valid = false;
        reason = t("admin.users.csvErr.dupTgId", { defaultValue: "duplicate telegram_user_id within file" });
      } else if (hasTgUser && seenTgUsers.has(tgUser)) {
        valid = false;
        reason = t("admin.users.csvErr.dupTgUser", { defaultValue: "duplicate telegram_username within file" });
      } else {
        // Row is structurally valid — now check DB for existing match (silently skip on import)
        if (hasEmail && existingEmails.has(emailRaw)) {
          duplicate = true;
          duplicateField = "email";
        } else if (tgId !== undefined && existingTgIds.has(tgId)) {
          duplicate = true;
          duplicateField = "telegram_user_id";
        } else if (hasTgUser && existingTgUsers.has(tgUser)) {
          duplicate = true;
          duplicateField = "telegram_username";
        }
      }

      if (valid) {
        if (hasEmail) seenEmails.add(emailRaw);
        if (tgId !== undefined) seenTgIds.add(tgId);
        if (hasTgUser) seenTgUsers.add(tgUser);
      }

      return {
        rowNum,
        name: name.trim(),
        last_name: last_name ? last_name.trim() : undefined,
        email: emailRaw,
        password: password || undefined,
        telegram_user_id: tgId,
        telegram_username: tgUser || undefined,
        role,
        valid,
        reason,
        duplicate,
        duplicateField,
      };
    });
    setCsvParsed(rows);
  };

  const importCsv = async () => {
    setImporting(true);
    const toCreate = csvParsed.filter((r) => r.valid && !r.duplicate);
    if (toCreate.length === 0) { setImporting(false); return; }
    const r = await fetch(`${FN_BASE}/admin-create-students`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify({
        students: toCreate,
        send_invite: true,
        csv_import: true,
        redirectTo: `${window.location.origin}/reset-password`,
      }),
    });
    const res = await r.json();
    setImporting(false);
    const created = (res?.results || []).filter((x: any) => x.status === "created").length;
    toast.success(t("admin.users.toasts.imported", { n: created, total: toCreate.length }));
    setOpenCsv(false); setCsvText(""); setCsvParsed([]); reload();
  };

  const resendWelcome = async (emails: string[]) => {
    let ok = 0;
    for (const email of emails) {
      const r = await fetch(`${FN_BASE}/admin-create-students`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({
          action: "resend_welcome",
          email,
          redirectTo: `${window.location.origin}/reset-password`,
        }),
      });
      const j = await r.json();
      if (j?.ok) ok++;
    }
    toast.success(t("admin.users.toasts.welcomeResent", { ok, total: emails.length }));
  };

  const clearLockout = async (email: string) => {
    const r = await fetch(`${FN_BASE}/admin-create-students`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify({ action: "clear_lockout", email }),
    });
    const j = await r.json();
    if (j?.ok) { toast.success(t("admin.users.toasts.lockoutCleared")); reload(); }
    else toast.error(j?.error || t("admin.users.toasts.createFailed"));
  };

  const logAction = async (action: string, body: Record<string, unknown>) => {
    fetch(`${FN_BASE}/log-admin-action`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify({ action, ...body }),
    }).catch(() => {});
  };

  const toggleEnrollment = async (userId: string, courseId: string, enroll: boolean) => {
    if (enroll) {
      const { error } = await supabase.from("enrollments").insert({ user_id: userId, course_id: courseId });
      if (error) return toast.error(error.message);
    } else {
      const { error } = await supabase.from("enrollments").delete().eq("user_id", userId).eq("course_id", courseId);
      if (error) return toast.error(error.message);
    }
    setEnrollMap((prev) => {
      const next = { ...prev };
      if (!next[userId]) next[userId] = new Set();
      const s = new Set(next[userId]);
      if (enroll) s.add(courseId); else s.delete(courseId);
      next[userId] = s;
      return next;
    });
  };

  const setRole = async (user: UserRow, promote: boolean) => {
    if (promote) {
      const { error } = await supabase.from("user_roles").insert({ user_id: user.id, role: "admin" });
      if (error) return toast.error(error.message);
      logAction("promote_to_admin", { target_user_id: user.id, details: { email: user.email } });
      toast.success(t("admin.users.toasts.promoted", { email: user.email }));
    } else {
      const { error } = await supabase.from("user_roles").delete().eq("user_id", user.id).eq("role", "admin");
      if (error) return toast.error(error.message);
      logAction("demote_to_student", { target_user_id: user.id, details: { email: user.email } });
      toast.success(t("admin.users.toasts.demoted", { email: user.email }));
    }
    setConfirmRole(null);
    reload();
  };

  const setStatus = async (user: UserRow, status: "active" | "inactive") => {
    const { error } = await supabase.from("profiles").update({ status }).eq("id", user.id);
    if (error) return toast.error(error.message);
    logAction(status === "active" ? "activate_user" : "deactivate_user", { target_user_id: user.id, details: { email: user.email } });
    toast.success(status === "active" ? t("admin.users.toasts.userActive") : t("admin.users.toasts.userInactive"));
    reload();
  };

  const updateProfile = async (user: UserRow, patch: Record<string, any>) => {
    const { error } = await (supabase.from("profiles") as any).update(patch).eq("id", user.id);
    if (error) return toast.error(error.message);
    logAction("update_profile", { target_user_id: user.id, details: { changed: Object.keys(patch) } });
    toast.success(t("admin.users.toasts.saved"));
    reload();
  };

  const resetPassword = async (user: UserRow) => {
    const { error } = await supabase.auth.resetPasswordForEmail(user.email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    if (error) return toast.error(error.message);
    toast.success(t("admin.users.toasts.passwordReset", { email: user.email }));
  };

  const removeUser = async (user: UserRow) => {
    const r = await fetch(`${FN_BASE}/admin-create-students`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify({ userId: user.id }),
    });
    const res = await r.json();
    if (res?.error) return toast.error(res.error);
    toast.success(t("admin.users.toasts.userRemoved"));
    setConfirmDelete(null); setManageUser(null); reload();
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleSelectAll = () => {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map((u) => u.id)));
  };

  const isLocked = (email: string) => lockedEmails.has(email.toLowerCase());

  return (
    <PageShell>
      <div className="space-y-6">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">{t("admin.users.title")}</h1>
            <p className="text-muted-foreground mt-1">{t("admin.users.subtitle", { total: users.length, admins: users.filter(u => u.is_admin).length })}</p>
          </div>
          <div className="flex gap-2">
            {selected.size > 0 && (
              <Button variant="outline" size="sm" onClick={() => {
                const emails = users.filter((u) => selected.has(u.id)).map((u) => u.email);
                resendWelcome(emails);
              }}>
                <Mail className="h-4 w-4" /> {t("admin.users.resendWelcomeN", { n: selected.size })}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setOpenCsv(true)}><UploadIcon className="h-4 w-4" />{t("admin.users.importCsv")}</Button>
            <Button size="sm" onClick={() => { setNewPassword(randPassword()); setOpenAdd(true); }}><Plus className="h-4 w-4" />{t("admin.users.addUser")}</Button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 items-center">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input placeholder={t("admin.users.searchPh")} value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("admin.users.allStatus")}</SelectItem>
              <SelectItem value="active">{t("admin.users.active")}</SelectItem>
              <SelectItem value="inactive">{t("admin.users.inactive")}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={roleFilter} onValueChange={setRoleFilter}>
            <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("admin.users.allRoles")}</SelectItem>
              <SelectItem value="admin">{t("admin.users.admins")}</SelectItem>
              <SelectItem value="student">{t("admin.users.students")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Card className="overflow-hidden shadow-soft">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs">
                <tr>
                  <th className="p-3 w-8">
                    <Checkbox
                      checked={filtered.length > 0 && selected.size === filtered.length}
                      onCheckedChange={toggleSelectAll}
                    />
                  </th>
                  <th className="text-left p-3">{t("admin.users.headers.name")}</th>
                  <th className="text-left p-3">{t("admin.users.headers.lastName")}</th>
                  <th className="text-left p-3">{t("admin.users.headers.email")}</th>
                  <th className="text-left p-3">{t("admin.users.headers.telegram")}</th>
                  <th className="text-left p-3">{t("admin.users.headers.role")}</th>
                  <th className="text-left p-3">{t("admin.users.headers.status")}</th>
                  <th className="text-left p-3">{t("admin.users.headers.courses")}</th>
                  <th className="text-left p-3">{t("admin.users.headers.lastLogin")}</th>
                  <th className="p-3"></th>
                </tr>
              </thead>
              <tbody>
                {loading && <tr><td colSpan={10} className="p-6 text-center text-muted-foreground">{t("admin.users.loading")}</td></tr>}
                {!loading && filtered.length === 0 && <tr><td colSpan={10} className="p-6 text-center text-muted-foreground">{t("admin.users.empty")}</td></tr>}
                {filtered.map((u) => (
                  <tr key={u.id} className="border-t hover:bg-muted/20">
                    <td className="p-3"><Checkbox checked={selected.has(u.id)} onCheckedChange={() => toggleSelect(u.id)} /></td>
                    <td className="p-3 font-medium">{u.name || "—"}</td>
                    <td className="p-3 text-muted-foreground">{u.last_name || "—"}</td>
                    <td className="p-3 text-muted-foreground">
                      {u.email}
                      {isLocked(u.email) && <Badge variant="destructive" className="ml-2 text-[10px]">{t("admin.users.locked")}</Badge>}
                    </td>
                    <td className="p-3 text-xs">
                      <div className="font-mono text-foreground">{u.telegram_id ?? "—"}</div>
                      {u.telegram_username && <div className="text-muted-foreground">@{u.telegram_username}</div>}
                    </td>
                    <td className="p-3">{u.is_admin ? <Badge>{t("admin.users.admin").toLowerCase()}</Badge> : <Badge variant="secondary">{t("admin.users.student").toLowerCase()}</Badge>}</td>
                    <td className="p-3"><span className={`text-xs px-2 py-0.5 rounded-full ${u.status === "active" ? "bg-muted" : "bg-destructive/10 text-destructive"}`}>{u.status === "active" ? t("admin.users.active") : t("admin.users.inactive")}</span></td>
                    <td className="p-3 text-xs text-muted-foreground">{(enrollMap[u.id]?.size) || 0}</td>
                    <td className="p-3 text-xs text-muted-foreground">{u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleDateString() : "—"}</td>
                    <td className="p-3"><Button variant="ghost" size="sm" onClick={() => setManageUser(u)}>{t("admin.users.manage")}</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {/* Add user dialog */}
      <Dialog open={openAdd} onOpenChange={setOpenAdd}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t("admin.users.addTitle")}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5"><Label>{t("admin.users.firstName")}</Label><Input value={newName} onChange={(e) => setNewName(e.target.value)} /></div>
              <div className="space-y-1.5">
                <Label>{t("admin.users.lastName")}</Label>
                <Input value={newLastName} onChange={(e) => setNewLastName(e.target.value)} placeholder={t("admin.users.lastNameOptional")} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground -mt-1">{t("admin.users.tgHelp")}</p>
            <div className="space-y-1.5"><Label>{t("admin.users.headers.email")}</Label><Input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} /></div>
            <div className="space-y-1.5">
              <Label>{t("admin.users.passwordOptional")}</Label>
              <div className="flex gap-2">
                <Input value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
                <Button type="button" variant="outline" size="icon" onClick={() => setNewPassword(randPassword())}><RefreshCw className="h-4 w-4" /></Button>
                <Button type="button" variant="outline" size="icon" onClick={() => { navigator.clipboard.writeText(newPassword); toast.success(t("admin.common.copied")); }}><Copy className="h-4 w-4" /></Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{t("admin.users.tgIdLabel", { defaultValue: "Telegram ID" })}</Label>
              <Input
                value={newTgId}
                onChange={(e) => setNewTgId(e.target.value.replace(/[^\d]/g, ""))}
                inputMode="numeric"
                placeholder="123456789"
              />
              <p className="text-xs text-muted-foreground">{t("admin.users.tgIdHint", { defaultValue: "Numeric ID from /myid in the bot. Required for Telegram login." })}</p>
            </div>
            <div className="space-y-1.5">
              <Label>{t("admin.users.tgUsernameOptional")}</Label>
              <Input value={newTg} onChange={(e) => setNewTg(e.target.value)} placeholder="@username" />
              <p className="text-xs text-muted-foreground">{t("admin.users.tgUsernameNoteOptional", { defaultValue: "Optional metadata only — not used for matching." })}</p>
            </div>
            <div className="space-y-1.5">
              <Label>{t("admin.users.role")}</Label>
              <Select value={newRole} onValueChange={(v) => setNewRole(v as any)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="student">{t("admin.users.student")}</SelectItem>
                  <SelectItem value="admin">{t("admin.users.admin")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("admin.users.enrollIn")}</Label>
              <div className="space-y-1 max-h-32 overflow-y-auto border rounded-md p-2">
                {courses.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox checked={newCourses.has(c.id)} onCheckedChange={(v) => {
                      const s = new Set(newCourses);
                      if (v) s.add(c.id); else s.delete(c.id);
                      setNewCourses(s);
                    }} />
                    {c.title}
                  </label>
                ))}
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer pt-1">
              <Checkbox checked={sendInvite} onCheckedChange={(v) => setSendInvite(!!v)} />
              {t("admin.users.sendMagicLink")}
            </label>
          </div>
          <DialogFooter><Button onClick={handleAdd}>{t("admin.users.createUser")}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* CSV dialog */}
      <Dialog open={openCsv} onOpenChange={async (o) => {
        setOpenCsv(o);
        if (o) {
          setShowErrors(false);
          // Load existing telegram_ids from DB for cross-check
          try {
            const { data } = await supabase.from("profiles").select("email, telegram_id").not("telegram_id", "is", null);
            const map = new Map<number, string>();
            (data || []).forEach((p: any) => { if (p.telegram_id) map.set(Number(p.telegram_id), (p.email || "").toLowerCase()); });
            setExistingTgIds(map);
          } catch {}
          if (!csvText) {
            const sample = "Aida,Khan,aida@example.com,,123456789,@aidakhan,student\nDilorom Yusupovna 🦋,,,,555111222,@dilorom,student";
            setCsvText(sample);
            parseCsv(sample);
          } else {
            // Re-validate with the freshly-loaded existing IDs
            parseCsv(csvText);
          }
        }
      }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle>{t("admin.users.csvTitle")}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="rounded-lg border bg-muted/30 p-3 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  id="csv-file-input"
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = () => {
                      const text = String(reader.result || "");
                      setCsvText(text);
                      parseCsv(text);
                    };
                    reader.onerror = () => toast.error(t("admin.users.csvReadError", { defaultValue: "Failed to read file" }));
                    reader.readAsText(file);
                    e.target.value = "";
                  }}
                />
                <Button variant="outline" size="sm" onClick={() => document.getElementById("csv-file-input")?.click()}>
                  <UploadIcon className="h-4 w-4 mr-1" />{t("admin.users.uploadCsv", { defaultValue: "Upload CSV file" })}
                </Button>
                <Button variant="default" size="sm" onClick={downloadTemplate}>
                  <Download className="h-4 w-4 mr-1" />{t("admin.users.downloadTemplate")}
                </Button>
              </div>
              <div className="text-xs text-muted-foreground leading-relaxed">
                <div>{t("admin.users.csvFormat")} <code className="text-[11px]">name,last_name,email,password,telegram_user_id,telegram_username,role</code></div>
                <div className="mt-1">{t("admin.users.csvFormatHint")}</div>
              </div>
            </div>
            <Textarea
              rows={6}
              value={csvText}
              onChange={(e) => { setCsvText(e.target.value); parseCsv(e.target.value); }}
              placeholder={"Aida,Khan,aida@example.com,,123456789,@aidakhan,student\nBilol,Karimov,bilol@example.com,SecurePass123!,,,student"}
            />
            {csvParsed.length > 0 && (
              <div className="border rounded-md max-h-64 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-xs sticky top-0">
                    <tr>
                      <th className="text-left p-2">{t("admin.users.csvHeaders.name")}</th>
                      <th className="text-left p-2">{t("admin.users.csvHeaders.lastName")}</th>
                      <th className="text-left p-2">{t("admin.users.csvHeaders.email")}</th>
                      <th className="text-left p-2">{t("admin.users.tgIdLabel", { defaultValue: "Telegram ID" })}</th>
                      <th className="text-left p-2">{t("admin.users.csvHeaders.telegram")}</th>
                      <th className="text-left p-2">{t("admin.users.csvHeaders.role")}</th>
                      <th className="text-left p-2">{t("admin.users.csvHeaders.status")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {csvParsed.map((r, i) => (
                      <tr key={i} className={`border-t ${!r.valid ? "bg-destructive/5" : ""}`}>
                        <td className="p-2">{r.name}</td>
                        <td className="p-2">{r.last_name || "—"}</td>
                        <td className="p-2">{r.email}</td>
                        <td className="p-2 text-xs font-mono">{r.telegram_user_id ?? "—"}</td>
                        <td className="p-2 text-xs">{r.telegram_username ? `@${r.telegram_username}` : "—"}</td>
                        <td className="p-2 text-xs">{r.role}</td>
                        <td className={`p-2 text-xs ${r.valid ? "text-foreground" : "text-destructive font-medium"}`}>
                          {r.valid ? t("admin.users.valid") : r.reason}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="text-xs text-muted-foreground">
                {t("admin.users.validInvalid", { valid: csvParsed.filter(r => r.valid).length, invalid: csvParsed.filter(r => !r.valid).length })}
              </div>
              {csvParsed.some(r => !r.valid) && (
                <Collapsible open={showErrors} onOpenChange={setShowErrors}>
                  <CollapsibleTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-7 text-xs text-destructive">
                      {showErrors ? <ChevronDown className="h-3 w-3 mr-1" /> : <ChevronRight className="h-3 w-3 mr-1" />}
                      {t("admin.users.csvErr.showErrors", { defaultValue: "Show invalid rows" })} ({csvParsed.filter(r => !r.valid).length})
                    </Button>
                  </CollapsibleTrigger>
                </Collapsible>
              )}
            </div>
            {showErrors && csvParsed.some(r => !r.valid) && (
              <div className="border border-destructive/30 rounded-md max-h-48 overflow-y-auto bg-destructive/5">
                <ul className="text-xs divide-y divide-destructive/20">
                  {csvParsed.filter(r => !r.valid).map((r, i) => (
                    <li key={i} className="p-2">
                      <span className="font-mono text-muted-foreground mr-2">Row {r.rowNum}:</span>
                      <span className="text-destructive">{r.reason}</span>
                      {r.name && <span className="text-muted-foreground ml-2">({r.name}{r.email ? ` · ${r.email}` : ""}{r.telegram_user_id ? ` · TG:${r.telegram_user_id}` : ""})</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button onClick={importCsv} disabled={importing || csvParsed.filter(r => r.valid).length === 0}>
              {importing ? t("admin.users.importing") : t("admin.users.importN", { n: csvParsed.filter(r => r.valid).length })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manage drawer */}
      <Sheet open={!!manageUser} onOpenChange={(o) => !o && setManageUser(null)}>
        <SheetContent className="w-full sm:max-w-md overflow-y-auto">
          {manageUser && (
            <>
              <SheetHeader><SheetTitle>{[manageUser.name, manageUser.last_name].filter(Boolean).join(" ") || manageUser.email}</SheetTitle></SheetHeader>
              <div className="mt-6 space-y-5">
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <Label>{t("admin.users.firstName")}</Label>
                    <Input defaultValue={manageUser.name || ""} onBlur={(e) => e.target.value !== (manageUser.name || "") && updateProfile(manageUser, { name: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t("admin.users.lastName")}</Label>
                    <Input defaultValue={manageUser.last_name || ""} onBlur={(e) => {
                      const v = e.target.value || null;
                      if (v !== (manageUser.last_name || null)) updateProfile(manageUser, { last_name: v });
                    }} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>{t("admin.users.manageEmail")}</Label>
                  <Input defaultValue={manageUser.email} onBlur={(e) => e.target.value !== manageUser.email && updateProfile(manageUser, { email: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label>{t("admin.users.tgIdLabel", { defaultValue: "Telegram ID" })}</Label>
                  <Input
                    defaultValue={manageUser.telegram_id ?? ""}
                    inputMode="numeric"
                    placeholder="123456789"
                    onBlur={async (e) => {
                      const raw = e.target.value.replace(/[^\d]/g, "");
                      const next = raw ? Number(raw) : null;
                      const cur = manageUser.telegram_id ?? null;
                      if (next === cur) return;
                      if (next !== null && (!Number.isInteger(next) || next <= 0)) {
                        toast.error(t("admin.users.tgIdInvalid", { defaultValue: "Telegram ID must be a positive integer" }));
                        e.target.value = cur ? String(cur) : "";
                        return;
                      }
                      const { error } = await (supabase.from("profiles") as any)
                        .update({ telegram_id: next })
                        .eq("id", manageUser.id);
                      if (error) {
                        const msg = /duplicate|unique/i.test(error.message)
                          ? t("admin.users.tgIdTaken", { defaultValue: "This Telegram ID is already linked to another user." })
                          : error.message;
                        toast.error(msg);
                        e.target.value = cur ? String(cur) : "";
                        return;
                      }
                      logAction("update_profile", { target_user_id: manageUser.id, details: { changed: ["telegram_id"] } });
                      toast.success(t("admin.users.toasts.saved"));
                      reload();
                    }}
                  />
                  <p className="text-xs text-muted-foreground">{t("admin.users.tgIdHint", { defaultValue: "Numeric ID from /myid in the bot. Required for Telegram login." })}</p>
                </div>
                <div className="space-y-1.5">
                  <Label>{t("admin.users.manageTg")}</Label>
                  <Input
                    value={manageUser.telegram_username ? `@${manageUser.telegram_username}` : ""}
                    readOnly
                    disabled
                    placeholder={t("admin.users.tgUsernameReadonly", { defaultValue: "Auto-filled from Telegram (read-only)" })}
                  />
                  <p className="text-xs text-muted-foreground">{t("admin.users.tgUsernameNoteReadonly", { defaultValue: "Set automatically when the user logs in via the bot. Not used for matching." })}</p>
                </div>
                <div className="space-y-1.5">
                  <Label>{t("admin.users.role")}</Label>
                  <div className="flex gap-2 items-center">
                    <Badge>{manageUser.is_admin ? t("admin.users.admin").toLowerCase() : t("admin.users.student").toLowerCase()}</Badge>
                    <Button size="sm" variant="outline" onClick={() => setConfirmRole({ user: manageUser, promote: !manageUser.is_admin })}>
                      {manageUser.is_admin ? t("admin.users.demote") : t("admin.users.promote")}
                    </Button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>{t("admin.users.headers.status")}</Label>
                  <Select value={manageUser.status} onValueChange={(v) => setStatus(manageUser, v as any)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">{t("admin.users.active")}</SelectItem>
                      <SelectItem value="inactive">{t("admin.users.inactive")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>{t("admin.users.courseAccess")}</Label>
                  <div className="space-y-1 border rounded-md p-2">
                    {courses.map((c) => (
                      <label key={c.id} className="flex items-center gap-2 text-sm cursor-pointer">
                        <Checkbox
                          checked={enrollMap[manageUser.id]?.has(c.id) || false}
                          onCheckedChange={(v) => toggleEnrollment(manageUser.id, c.id, !!v)}
                        />
                        {c.title}
                      </label>
                    ))}
                    {courses.length === 0 && <p className="text-xs text-muted-foreground">{t("admin.users.noCourses")}</p>}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 pt-2">
                  <Button variant="outline" size="sm" onClick={() => resendWelcome([manageUser.email])}><Mail className="h-4 w-4" />{t("admin.users.resendWelcome")}</Button>
                  <Button variant="outline" size="sm" onClick={() => resetPassword(manageUser)}>{t("admin.users.resetPassword")}</Button>
                  {isLocked(manageUser.email) && (
                    <Button variant="outline" size="sm" onClick={() => clearLockout(manageUser.email)}><Unlock className="h-4 w-4" />{t("admin.users.clearLockout")}</Button>
                  )}
                  <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(manageUser)}><Trash2 className="h-4 w-4" />{t("admin.users.removeBtn")}</Button>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={!!confirmRole} onOpenChange={(o) => !o && setConfirmRole(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmRole?.promote ? t("admin.users.promoteTitle") : t("admin.users.demoteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmRole?.promote ? t("admin.users.promoteDesc") : t("admin.users.demoteDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("admin.users.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirmRole && setRole(confirmRole.user, confirmRole.promote)}>{t("admin.users.confirm")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("admin.users.removeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("admin.users.removeDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("admin.users.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirmDelete && removeUser(confirmDelete)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">{t("admin.users.remove")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
  );
}
