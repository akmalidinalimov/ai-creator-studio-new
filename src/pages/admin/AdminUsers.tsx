import { useEffect, useMemo, useState } from "react";
import { getSiteUrl } from "@/lib/siteUrl";
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

type RoleName = "student" | "teacher" | "admin" | "superadmin";

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  last_name?: string | null;
  avatar_url: string | null;
  status: "active" | "inactive" | "archived";
  telegram_username: string | null;
  telegram_id: number | null;
  created_at: string;
  last_sign_in_at: string | null;
  is_admin: boolean;
  role_name?: RoleName;
  group_id?: string | null;
  archived_at?: string | null;
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
  group_name?: string;
  valid: boolean;
  reason?: string;
  duplicate?: boolean;
  duplicateField?: "email" | "telegram_user_id" | "telegram_username";
}

const randPassword = () =>
  Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6).toUpperCase();

const CSV_TEMPLATE = `name,last_name,email,password,telegram_user_id,telegram_username,role,group_name
Aida,Khan,aida@example.com,,123456789,@aidakhan,student,Group A
Bilol,Karimov,bilol@example.com,SecurePass123!,,,student,Group A
Chen,Wei,chen@example.com,,987654321,,student,
Dilnoza,Yusupova,dilnoza@example.com,,,,student,Group B
Elnur,Aliyev,elnur@example.com,AdminPass456!,555555555,@elnura,admin,
`;

const FN_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

export default function AdminUsers() {
  const { t } = useTranslation();
  const { session, role } = useAuth();
  const isTeacher = role === "teacher";
  const isAdmin = role === "admin";
  const [users, setUsers] = useState<UserRow[]>([]);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [bulkGroupId, setBulkGroupId] = useState<string>("");
  const [bulkRole, setBulkRole] = useState<{ user: UserRow; newRole: RoleName } | null>(null);
  const [courses, setCourses] = useState<{ id: string; title: string }[]>([]);
  const [enrollMap, setEnrollMap] = useState<Record<string, Set<string>>>({});
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("active");
  const initialRoleFilter = (() => {
    if (typeof window === "undefined") return "all";
    const p = new URLSearchParams(window.location.search).get("role");
    return p === "teacher" || p === "admin" || p === "student" ? p : "all";
  })();
  const [roleFilter, setRoleFilter] = useState<string>(initialRoleFilter);
  const [groupFilter, setGroupFilter] = useState<string>("all");
  const [orphansOnly, setOrphansOnly] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState<{ ids: string[]; mode: "archive" | "unarchive" } | null>(null);
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
  const [newRole, setNewRole] = useState<"student" | "teacher" | "admin">("student");
  const [newCourses, setNewCourses] = useState<Set<string>>(new Set());
  const [newGroupId, setNewGroupId] = useState<string>("none");
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
    const { data, error } = await supabase.rpc(isTeacher ? "staff_list_students" as any : "admin_list_users");
    if (error) toast.error(error.message);
    const rows = (data || []) as any[];
    // Hydrate last_name + group_id (joined to groups.name) from profiles, and roles from user_roles.
    // Chunked to avoid URL-length / 1000-row limits with large user counts.
    if (rows.length) {
      const ids = rows.map((u) => u.id);
      const lnMap: Record<string, string | null> = {};
      const grpMap: Record<string, string | null> = {};
      const grpNameMap: Record<string, string | null> = {};
      const rolesMap: Record<string, string[]> = {};
      const PAGE = 300;
      const profPromises: Promise<any>[] = [];
      const rolePromises: Promise<any>[] = [];
      for (let i = 0; i < ids.length; i += PAGE) {
        const slice = ids.slice(i, i + PAGE);
        profPromises.push(
          Promise.resolve(supabase.from("profiles").select("id, last_name, group_id, groups:group_id(name)").in("id", slice))
        );
        rolePromises.push(
          Promise.resolve(supabase.from("user_roles").select("user_id, role").in("user_id", slice))
        );
      }
      const profResults = await Promise.all(profPromises);
      const roleResults = await Promise.all(rolePromises);
      profResults.forEach(({ data }) => {
        (data || []).forEach((p: any) => {
          lnMap[p.id] = p.last_name;
          grpMap[p.id] = p.group_id;
          grpNameMap[p.id] = p?.groups?.name || null;
        });
      });
      roleResults.forEach(({ data }) => {
        (data || []).forEach((r: any) => { (rolesMap[r.user_id] ||= []).push(r.role); });
      });
      const rank: Record<string, number> = { superadmin: 1, admin: 2, teacher: 3, student: 4 };
      rows.forEach((u) => {
        u.last_name = lnMap[u.id] || null;
        u.group_id = grpMap[u.id] || null;
        (u as any).group_name = grpNameMap[u.id] || null;
        const list = rolesMap[u.id] || [];
        const top = list.sort((a, b) => (rank[a] || 99) - (rank[b] || 99))[0] as RoleName | undefined;
        u.role_name = (top || "student") as RoleName;
      });
    }
    setUsers(rows as UserRow[]);
    const [{ data: cs }, { data: gs }] = await Promise.all([
      supabase.from("courses").select("id, title").order("title"),
      supabase.from("groups").select("id, name").order("name"),
    ]);
    setCourses(cs || []);
    setGroups(gs || []);
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

  const groupNameById = useMemo(() => {
    const m = new Map<string, string>();
    groups.forEach((g) => m.set(g.id, g.name));
    return m;
  }, [groups]);

  const activeGroupIds = useMemo(() => new Set(groups.map((g) => g.id)), [groups]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter((u) => {
      if (statusFilter !== "all" && u.status !== statusFilter) return false;
      if (roleFilter !== "all") {
        if ((u.role_name || "student") !== roleFilter) return false;
      }
      if (groupFilter !== "all") {
        if (groupFilter === "none") {
          if (u.group_id) return false;
        } else if (u.group_id !== groupFilter) {
          return false;
        }
      }
      if (orphansOnly) {
        if (u.group_id && activeGroupIds.has(u.group_id)) return false;
      }
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
  }, [users, search, statusFilter, roleFilter, groupFilter, orphansOnly, activeGroupIds]);

  const counts = useMemo(() => {
    let active = 0, archived = 0;
    for (const u of users) {
      if (u.status === "archived") archived++;
      else active++;
    }
    return { all: users.length, active, archived };
  }, [users]);

  const exportFilteredCsv = async () => {
    // Fetch fresh group_id mapping joined with group name to guarantee group_name in export
    const ids = filtered.map((u) => u.id);
    const groupOf = new Map<string, string>();
    if (ids.length) {
      const PAGE = 1000;
      for (let i = 0; i < ids.length; i += PAGE) {
        const slice = ids.slice(i, i + PAGE);
        const { data } = await supabase
          .from("profiles")
          .select("id, group_id, groups:group_id(name)")
          .in("id", slice);
        (data || []).forEach((p: any) => {
          const gname = p?.groups?.name || (p.group_id ? groupNameById.get(p.group_id) : "") || "";
          if (gname) groupOf.set(p.id, gname);
        });
      }
    }
    const rows = filtered.map((u) => ({
      name: u.name || "",
      last_name: u.last_name || "",
      email: u.email.endsWith("@telegram.local") ? "" : u.email,
      password: "",
      telegram_user_id: u.telegram_id ?? "",
      telegram_username: u.telegram_username || "",
      role: u.role_name || "student",
      group_name: groupOf.get(u.id) || (u as any).group_name || (u.group_id ? (groupNameById.get(u.group_id) || "") : ""),
      status: u.status,
    }));
    const csv = Papa.unparse(rows, { columns: ["name","last_name","email","password","telegram_user_id","telegram_username","role","group_name","status"] });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const groupSlug = groupFilter === "all" ? "all" : groupFilter === "none" ? "no-group" : (groupNameById.get(groupFilter) || "group").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    const date = new Date().toISOString().slice(0, 10);
    a.href = url; a.download = `users_${groupSlug}_${date}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast.success(t("admin.users.exportedToast", { defaultValue: "Exported {{n}} users", n: rows.length }));
  };

  const callCreate = async (rows: any[], extra: Record<string, unknown> = {}) => {
    const r = await fetch(`${FN_BASE}/admin-create-students`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify({
        students: rows,
        courseIds: Array.from(newCourses),
        send_invite: sendInvite,
        redirectTo: `${getSiteUrl()}/reset-password`,
        ...extra,
      }),
    });
    return r.json();
  };

  const handleAdd = async () => {
    const tgIdRaw = newTgId.trim();
    const tgUserRaw = newTg.replace(/^@/, "").trim();
    const emailRaw = newEmail.trim();
    if (!emailRaw && !tgIdRaw && !tgUserRaw) {
      toast.error("Email, Telegram ID yoki Telegram username dan kamida bittasi kerak");
      return;
    }
    let tgId: number | undefined;
    if (tgIdRaw) {
      const n = Number(tgIdRaw);
      if (!Number.isInteger(n) || n <= 0) {
        toast.error(t("admin.users.tgIdInvalid", { defaultValue: "Telegram ID must be a positive integer" }));
        return;
      }
      tgId = n;
    }
    const res = await callCreate([{
      name: newName,
      last_name: newLastName || undefined,
      email: emailRaw,
      password: newPassword || undefined,
      telegram_username: tgUserRaw || undefined,
      telegram_user_id: tgId,
      role: newRole,
    }], newGroupId && newGroupId !== "none" ? { target_group_id: newGroupId } : {});
    const r = res?.results?.[0];
    const okStatuses = ["created", "updated", "matched", "skipped_already_in_group"];
    const label = newEmail.trim() || (newTgId.trim() ? `tg:${newTgId.trim()}` : "") || (newTg.trim() || "user");
    if (r && okStatuses.includes(r.status)) {
      if (r.status === "created") {
        toast.success(r.action_link
          ? t("admin.users.toasts.createdInvite", { email: label })
          : t("admin.users.toasts.created", { email: label }));
      } else if (r.status === "skipped_already_in_group") {
        toast.info(`${label} allaqachon ushbu guruhda mavjud`);
      } else {
        toast.success(`${label} yangilandi va guruhga qo'shildi`);
      }
      setOpenAdd(false);
      setNewName(""); setNewLastName(""); setNewEmail(""); setNewPassword(randPassword());
      setNewTg(""); setNewTgId(""); setNewRole("student"); setNewCourses(new Set()); setNewGroupId("none");
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
      const groupName = get(row, "group_name", 7);

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
        group_name: groupName ? groupName.trim() : undefined,
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
        redirectTo: `${getSiteUrl()}/reset-password`,
      }),
    });
    const res = await r.json();
    setImporting(false);
    const results: any[] = res?.results || [];
    const autoCreated: Array<{ id: string; name: string }> = res?.auto_created_groups || [];
    const autoSet = new Set(autoCreated.map((g) => (g.name || "").toLowerCase()));
    // v3.14.14: build per-group breakdown.
    const buckets = new Map<string, { created: number; updated: number; skipped: number; errors: number }>();
    const bump = (key: string, field: "created" | "updated" | "skipped" | "errors") => {
      const b = buckets.get(key) || { created: 0, updated: 0, skipped: 0, errors: 0 };
      b[field]++;
      buckets.set(key, b);
    };
    for (const rr of results) {
      const idx = (rr.row_index || 0) - 1;
      const row = toCreate[idx];
      const gname = (row?.group_name || "").trim() || "__none__";
      if (rr.status === "created") bump(gname, "created");
      else if (rr.status === "updated") bump(gname, "updated");
      else if (rr.status === "skipped_already_in_group") bump(gname, "skipped");
      else bump(gname, "errors");
    }
    const totalCreated = results.filter((x: any) => x.status === "created").length;
    const totalErrors = results.filter((x: any) => x.status === "error" || x.status === "invalid_email").length;
    const lines: string[] = [];
    for (const [key, b] of Array.from(buckets.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
      const label = key === "__none__"
        ? "Guruhsiz"
        : `${key}${autoSet.has(key.toLowerCase()) ? " (yangi guruh yaratildi)" : ""}`;
      const parts: string[] = [];
      if (b.created) parts.push(`${b.created} yangi`);
      if (b.updated) parts.push(`${b.updated} mavjud`);
      if (b.skipped) parts.push(`${b.skipped} allaqachon`);
      if (b.errors) parts.push(`${b.errors} xato`);
      lines.push(`${label}: ${parts.join(" ") || "0"}`);
    }
    if (totalErrors) lines.push(`Xato: ${totalErrors}`);
    const summary = lines.join("\n");
    const head = t("admin.users.toasts.imported", { n: totalCreated, total: toCreate.length });
    if (summary.length > 220) {
      toast.success(head, { description: summary, duration: 12000 });
    } else {
      toast.success(head + (summary ? `\n${summary}` : ""), { duration: 9000 });
    }
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
          redirectTo: `${getSiteUrl()}/reset-password`,
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

  const changeUserRole = async (user: UserRow, newRole: RoleName) => {
    try {
      const { data, error } = await supabase.functions.invoke("admin-change-role", {
        body: { target_user_id: user.id, new_role: newRole },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      toast.success(t("admin.users.toasts.roleUpdated", { defaultValue: "Role updated" }));
      setBulkRole(null);
      reload();
    } catch (e: any) {
      toast.error(e.message || "Failed to change role");
      setBulkRole(null);
    }
  };

  const bulkAssignGroup = async (groupId: string) => {
    if (selected.size === 0) return;
    const ids = Array.from(selected);
    const { data, error } = await supabase.rpc("admin_assign_group", { _user_ids: ids, _group_id: groupId });
    if (error) return toast.error(error.message);
    toast.success(t("admin.users.toasts.bulkMoved", { defaultValue: "{{n}} users moved", n: data || ids.length }));
    setSelected(new Set());
    setBulkGroupId("");
    reload();
  };

  const setStatus = async (user: UserRow, status: "active" | "inactive") => {
    const { error } = await supabase.from("profiles").update({ status }).eq("id", user.id);
    if (error) return toast.error(error.message);
    logAction(status === "active" ? "activate_user" : "deactivate_user", { target_user_id: user.id, details: { email: user.email } });
    toast.success(status === "active" ? t("admin.users.toasts.userActive") : t("admin.users.toasts.userInactive"));
    reload();
  };

  const bulkArchive = async (ids: string[], mode: "archive" | "unarchive") => {
    if (ids.length === 0) return;
    const patch = mode === "archive"
      ? { status: "archived" as any, archived_at: new Date().toISOString() }
      : { status: "active" as any, archived_at: null };
    const { error } = await (supabase.from("profiles") as any).update(patch).in("id", ids);
    if (error) return toast.error(error.message);
    logAction(mode === "archive" ? "archived_users" : "unarchived_users", { details: { profile_ids: ids, count: ids.length } });
    toast.success(mode === "archive"
      ? `${ids.length} ta talaba arxivlandi`
      : `${ids.length} ta talaba qayta faollashtirildi`);
    setSelected(new Set());
    setConfirmArchive(null);
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
      redirectTo: `${getSiteUrl()}/reset-password`,
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

  const roleBadge = (r?: RoleName) => {
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

  return (
    <PageShell>
      <div className="space-y-6">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">{t("admin.users.title")}</h1>
            <p className="text-muted-foreground mt-1">
              {statusFilter === "archived"
                ? `Arxiv: ${counts.archived} • Faol: ${counts.active} • Jami: ${counts.all}`
                : statusFilter === "active"
                ? `Faol: ${counts.active} • Arxiv: ${counts.archived} • Jami: ${counts.all}`
                : `Jami: ${counts.all} (Faol: ${counts.active}, Arxiv: ${counts.archived})`}
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            {isAdmin && selected.size > 0 && statusFilter !== "archived" && (
              <Select value={bulkGroupId} onValueChange={(v) => { setBulkGroupId(v); bulkAssignGroup(v); }}>
                <SelectTrigger className="w-[200px] h-9 text-xs">
                  <SelectValue placeholder={t("admin.users.bulkMoveTo", { defaultValue: "Move {{n}} to group…", n: selected.size })} />
                </SelectTrigger>
                <SelectContent>
                  {groups.map((g) => (
                    <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {isAdmin && selected.size > 0 && statusFilter !== "archived" && (
              <Button variant="outline" size="sm" onClick={() => setConfirmArchive({ ids: Array.from(selected), mode: "archive" })}>
                {`Arxivlash (${selected.size})`}
              </Button>
            )}
            {isAdmin && selected.size > 0 && statusFilter === "archived" && (
              <Button variant="outline" size="sm" onClick={() => setConfirmArchive({ ids: Array.from(selected), mode: "unarchive" })}>
                {`Qayta faollashtirish (${selected.size})`}
              </Button>
            )}
            {selected.size > 0 && (
              <Button variant="outline" size="sm" onClick={() => {
                const emails = users.filter((u) => selected.has(u.id)).map((u) => u.email);
                resendWelcome(emails);
              }}>
                <Mail className="h-4 w-4" /> {t("admin.users.resendWelcomeN", { n: selected.size })}
              </Button>
            )}
            {isAdmin && <Button variant="outline" size="sm" onClick={() => setOpenCsv(true)}><UploadIcon className="h-4 w-4" />{t("admin.users.importCsv")}</Button>}
            <Button variant="outline" size="sm" onClick={exportFilteredCsv} disabled={filtered.length === 0}><Download className="h-4 w-4" />{t("admin.users.exportCsv", { defaultValue: "Export CSV" })}</Button>
            {isAdmin && <Button variant="outline" size="sm" asChild><a href="/admin/users/duplicates">Duplicates</a></Button>}
            {isAdmin && <Button size="sm" onClick={() => { setNewPassword(randPassword()); setOpenAdd(true); }}><Plus className="h-4 w-4" />{t("admin.users.addUser")}</Button>}
          </div>
        </div>

        {/* Status chips */}
        <div className="flex flex-wrap gap-2 items-center">
          {(["active", "all", "archived"] as const).map((s) => (
            <Button
              key={s}
              variant={statusFilter === s ? "default" : "outline"}
              size="sm"
              onClick={() => { setStatusFilter(s); setSelected(new Set()); }}
            >
              {s === "active" ? `Faol (${counts.active})` : s === "archived" ? `Arxiv (${counts.archived})` : `Hammasi (${counts.all})`}
            </Button>
          ))}
          {isAdmin && (
            <label className="flex items-center gap-2 text-xs cursor-pointer ml-2">
              <Checkbox checked={orphansOnly} onCheckedChange={(v) => setOrphansOnly(!!v)} />
              Faqat guruhsiz/eski talabalar
            </label>
          )}
          {isAdmin && orphansOnly && filtered.length > 0 && statusFilter !== "archived" && (
            <Button size="sm" variant="outline" onClick={() => setConfirmArchive({ ids: filtered.map((u) => u.id), mode: "archive" })}>
              {`Tanlanganlarni arxivlash (${filtered.length})`}
            </Button>
          )}
        </div>

        <div className="flex flex-wrap gap-2 items-center">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input placeholder={t("admin.users.searchPh")} value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
          </div>
          <Select value={roleFilter} onValueChange={setRoleFilter}>
            <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("admin.users.allRoles")}</SelectItem>
              <SelectItem value="admin">{t("admin.users.admins")}</SelectItem>
              <SelectItem value="student">{t("admin.users.students")}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={groupFilter} onValueChange={setGroupFilter}>
            <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("admin.users.allGroups", { defaultValue: "All groups" })}</SelectItem>
              <SelectItem value="none">{t("admin.users.noGroup", { defaultValue: "No group" })}</SelectItem>
              {groups.map((g) => (
                <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>


        {/* Mobile: card list */}
        <div className="md:hidden space-y-2">
          {loading && <p className="text-center text-sm text-muted-foreground py-6">{t("admin.users.loading")}</p>}
          {!loading && filtered.length === 0 && <p className="text-center text-sm text-muted-foreground py-6">{t("admin.users.empty")}</p>}
          {filtered.map((u) => (
            <Card key={u.id} className="p-3">
              <div className="flex items-start gap-3">
                <Checkbox className="mt-1" checked={selected.has(u.id)} onCheckedChange={() => toggleSelect(u.id)} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium truncate">{[u.name, u.last_name].filter(Boolean).join(" ") || "—"}</div>
                    {roleBadge(u.role_name)}
                  </div>
                  <div className="text-xs text-muted-foreground truncate mt-0.5">
                    {u.email}
                    {isLocked(u.email) && <Badge variant="destructive" className="ml-2 text-[10px]">{t("admin.users.locked")}</Badge>}
                  </div>
                  {(u.telegram_id || u.telegram_username) && (
                    <div className="text-xs mt-1">
                      <span className="font-mono">{u.telegram_id ?? "—"}</span>
                      {u.telegram_username && <span className="text-muted-foreground ml-2">@{u.telegram_username}</span>}
                    </div>
                  )}
                  {u.group_id && (
                    <div className="text-xs mt-1"><Badge variant="secondary">{(u as any).group_name || groupNameById.get(u.group_id) || "—"}</Badge></div>
                  )}
                  <div className="flex items-center justify-between mt-2 gap-2">
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className={`px-2 py-0.5 rounded-full ${u.status === "active" ? "bg-muted" : u.status === "archived" ? "bg-amber-500/10 text-amber-700 dark:text-amber-400" : "bg-destructive/10 text-destructive"}`}>
                        {u.status === "active" ? t("admin.users.active") : u.status === "archived" ? "Arxiv" : t("admin.users.inactive")}
                      </span>
                      <span className="text-muted-foreground">{(enrollMap[u.id]?.size) || 0} {t("admin.users.headers.courses").toLowerCase()}</span>
                      <span className="text-muted-foreground">{u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleDateString() : "—"}</span>
                    </div>
                    {isAdmin && <Button variant="ghost" size="sm" className="h-7" onClick={() => setManageUser(u)}>{t("admin.users.manage")}</Button>}
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>

        {/* Desktop: table */}
        <Card className="hidden md:block overflow-hidden shadow-soft">
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
                  <th className="text-left p-3">{t("admin.users.headers.group", { defaultValue: "Group" })}</th>
                  <th className="text-left p-3">{t("admin.users.headers.status")}</th>
                  <th className="text-left p-3">{t("admin.users.headers.courses")}</th>
                  <th className="text-left p-3">{t("admin.users.headers.lastLogin")}</th>
                  <th className="p-3"></th>
                </tr>
              </thead>
              <tbody>
                {loading && <tr><td colSpan={11} className="p-6 text-center text-muted-foreground">{t("admin.users.loading")}</td></tr>}
                {!loading && filtered.length === 0 && <tr><td colSpan={11} className="p-6 text-center text-muted-foreground">{t("admin.users.empty")}</td></tr>}
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
                    <td className="p-3">
                      <div className="flex flex-col items-start gap-1">
                        {roleBadge(u.role_name)}
                        {isAdmin && (
                          <Select
                            value={u.role_name || "student"}
                            disabled={u.id === session?.user?.id}
                            onValueChange={(v) => {
                              const next = v as RoleName;
                              if (next !== (u.role_name || "student")) setBulkRole({ user: u, newRole: next });
                            }}
                          >
                            <SelectTrigger className="h-7 w-[120px] text-[11px]"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="student">Student</SelectItem>
                              <SelectItem value="teacher">Teacher</SelectItem>
                              <SelectItem value="admin">Admin</SelectItem>
                              <SelectItem value="superadmin">Superadmin</SelectItem>
                            </SelectContent>
                          </Select>
                        )}
                      </div>
                    </td>
                    <td className="p-3 text-xs">{u.group_id ? <Badge variant="secondary">{(u as any).group_name || groupNameById.get(u.group_id) || "—"}</Badge> : <span className="text-muted-foreground">—</span>}</td>
                    <td className="p-3"><span className={`text-xs px-2 py-0.5 rounded-full ${u.status === "active" ? "bg-muted" : u.status === "archived" ? "bg-amber-500/10 text-amber-700 dark:text-amber-400" : "bg-destructive/10 text-destructive"}`}>{u.status === "active" ? t("admin.users.active") : u.status === "archived" ? "Arxiv" : t("admin.users.inactive")}</span></td>
                    <td className="p-3 text-xs text-muted-foreground">{(enrollMap[u.id]?.size) || 0}</td>
                    <td className="p-3 text-xs text-muted-foreground">{u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleDateString() : "—"}</td>
                    <td className="p-3">{isAdmin && <Button variant="ghost" size="sm" onClick={() => setManageUser(u)}>{t("admin.users.manage")}</Button>}</td>
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
            <div className="space-y-1.5">
              <Label>{t("admin.users.headers.email")} (optional)</Label>
              <Input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="optional — Telegram ID/username is the real identity" />
              <p className="text-xs text-muted-foreground">Email is metadata only. Identity matching uses Telegram ID/username.</p>
            </div>
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
                  <SelectItem value="student">Talaba</SelectItem>
                  <SelectItem value="teacher">Ustoz</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {newRole !== "admin" && (
              <div className="space-y-1.5">
                <Label>{newRole === "teacher" ? "Mas'ul guruh" : t("admin.users.group", { defaultValue: "Group" })}</Label>
                <Select value={newGroupId} onValueChange={setNewGroupId}>
                  <SelectTrigger><SelectValue placeholder={t("admin.users.noGroup", { defaultValue: "No group" })} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t("admin.users.noGroup", { defaultValue: "No group" })}</SelectItem>
                    {groups.map((g) => (
                      <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {newRole === "teacher" && (
                  <p className="text-xs text-muted-foreground">Yangi guruhga biriktirish eski guruhni o'zgartirmaydi</p>
                )}
              </div>
            )}
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
          setShowDups(false);
          // Load existing emails / telegram_ids / telegram_usernames from DB for cross-check.
          // Paginate to bypass the 1000-row default limit.
          try {
            const tgIdMap = new Map<number, string>();
            const emails = new Set<string>();
            const tgUsers = new Set<string>();
            const PAGE = 1000;
            for (let from = 0; ; from += PAGE) {
              const { data, error } = await supabase
                .from("profiles")
                .select("email, telegram_id, telegram_username")
                .range(from, from + PAGE - 1);
              if (error || !data || data.length === 0) break;
              for (const p of data as any[]) {
                if (p.email) emails.add(String(p.email).toLowerCase());
                if (p.telegram_id) tgIdMap.set(Number(p.telegram_id), String(p.email || "").toLowerCase());
                if (p.telegram_username) tgUsers.add(String(p.telegram_username).toLowerCase().replace(/^@/, ""));
              }
              if (data.length < PAGE) break;
            }
            setExistingTgIds(tgIdMap);
            setExistingEmails(emails);
            setExistingTgUsers(tgUsers);
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
                <div>{t("admin.users.csvFormat")} <code className="text-[11px]">name,last_name,email,password,telegram_user_id,telegram_username,role,group_name</code></div>
                <div className="mt-1">{t("admin.users.csvFormatHint")} <span className="text-[11px]">group_name is optional; unknown groups are auto-created.</span></div>
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
                    {csvParsed.map((r, i) => {
                      const rowBg = !r.valid ? "bg-destructive/5" : r.duplicate ? "bg-muted/40" : "";
                      const statusCls = !r.valid
                        ? "text-destructive font-medium"
                        : r.duplicate
                        ? "text-muted-foreground"
                        : "text-foreground";
                      const statusText = !r.valid
                        ? r.reason
                        : r.duplicate
                        ? t("admin.users.duplicate", { defaultValue: "Already in DB" })
                        : t("admin.users.valid");
                      return (
                        <tr key={i} className={`border-t ${rowBg}`}>
                          <td className="p-2">{r.name}</td>
                          <td className="p-2">{r.last_name || "—"}</td>
                          <td className="p-2">{r.email}</td>
                          <td className="p-2 text-xs font-mono">{r.telegram_user_id ?? "—"}</td>
                          <td className="p-2 text-xs">{r.telegram_username ? `@${r.telegram_username}` : "—"}</td>
                          <td className="p-2 text-xs">{r.role}</td>
                          <td className={`p-2 text-xs ${statusCls}`}>{statusText}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {(() => {
              const addedCount = csvParsed.filter(r => r.valid && !r.duplicate).length;
              const dupCount = csvParsed.filter(r => r.valid && r.duplicate).length;
              const invalidCount = csvParsed.filter(r => !r.valid).length;
              return (
                <>
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="text-xs text-muted-foreground">
                      {csvParsed.length === 0
                        ? t("admin.users.validInvalid", { valid: 0, invalid: 0 })
                        : t("admin.users.csvSummary", {
                            defaultValue: "{{added}} added · {{dup}} already in DB · {{invalid}} invalid",
                            added: addedCount,
                            dup: dupCount,
                            invalid: invalidCount,
                          })}
                    </div>
                    <div className="flex items-center gap-2">
                      {dupCount > 0 && (
                        <Collapsible open={showDups} onOpenChange={setShowDups}>
                          <CollapsibleTrigger asChild>
                            <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground">
                              {showDups ? <ChevronDown className="h-3 w-3 mr-1" /> : <ChevronRight className="h-3 w-3 mr-1" />}
                              {t("admin.users.showDuplicates", { defaultValue: "Show duplicates" })} ({dupCount})
                            </Button>
                          </CollapsibleTrigger>
                        </Collapsible>
                      )}
                      {invalidCount > 0 && (
                        <Collapsible open={showErrors} onOpenChange={setShowErrors}>
                          <CollapsibleTrigger asChild>
                            <Button variant="ghost" size="sm" className="h-7 text-xs text-destructive">
                              {showErrors ? <ChevronDown className="h-3 w-3 mr-1" /> : <ChevronRight className="h-3 w-3 mr-1" />}
                              {t("admin.users.csvErr.showErrors", { defaultValue: "Show invalid rows" })} ({invalidCount})
                            </Button>
                          </CollapsibleTrigger>
                        </Collapsible>
                      )}
                    </div>
                  </div>
                  {showDups && dupCount > 0 && (
                    <div className="border rounded-md max-h-48 overflow-y-auto bg-muted/30">
                      <ul className="text-xs divide-y divide-border">
                        {csvParsed.filter(r => r.valid && r.duplicate).map((r, i) => (
                          <li key={i} className="p-2">
                            <span className="font-mono text-muted-foreground mr-2">Row {r.rowNum}:</span>
                            <span className="text-foreground">{r.name}{r.telegram_username ? ` (@${r.telegram_username})` : r.email ? ` (${r.email})` : ""}</span>
                            <span className="text-muted-foreground ml-2">— {t("admin.users.dupMatched", { defaultValue: "matched existing {{field}}", field: r.duplicateField })}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {showErrors && invalidCount > 0 && (
                    <div className="border border-destructive/30 rounded-md max-h-48 overflow-y-auto bg-destructive/5">
                      <ul className="text-xs divide-y divide-destructive/20">
                        {csvParsed.filter(r => !r.valid).map((r, i) => (
                          <li key={i} className="p-2">
                            <span className="font-mono text-muted-foreground mr-2">Row {r.rowNum}:</span>
                            <span className="text-destructive">{r.reason}</span>
                            {r.name && <span className="text-muted-foreground ml-2">({r.name}{r.email ? ` · ${r.email}` : ""}{r.telegram_user_id ? ` · TG:${r.telegram_user_id}` : ""}{r.telegram_username ? ` · @${r.telegram_username}` : ""})</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
          <DialogFooter>
            {(() => {
              const addedCount = csvParsed.filter(r => r.valid && !r.duplicate).length;
              const hasAnyValid = csvParsed.some(r => r.valid);
              const allDup = hasAnyValid && addedCount === 0;
              return (
                <Button onClick={importCsv} disabled={importing || addedCount === 0}>
                  {importing
                    ? t("admin.users.importing")
                    : allDup
                    ? t("admin.users.allInDb", { defaultValue: "All already in DB" })
                    : t("admin.users.addNewN", { defaultValue: "Add {{n}} new users", n: addedCount })}
                </Button>
              );
            })()}
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
                  <Select
                    value={manageUser.is_admin ? "admin" : "student"}
                    onValueChange={async (newRole) => {
                      try {
                        const { data, error } = await supabase.functions.invoke("admin-change-role", {
                          body: { target_user_id: manageUser.id, new_role: newRole },
                        });
                        if (error) throw error;
                        if ((data as any)?.error) throw new Error((data as any).error);
                        toast.success(t("admin.users.toasts.saved"));
                        reload();
                      } catch (e: any) {
                        toast.error(e.message || "Failed to change role");
                      }
                    }}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="student">Student</SelectItem>
                      <SelectItem value="teacher">Teacher</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                      <SelectItem value="superadmin">Superadmin</SelectItem>
                    </SelectContent>
                  </Select>
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

      <AlertDialog open={!!bulkRole} onOpenChange={(o) => !o && setBulkRole(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("admin.users.changeRoleTitle", { defaultValue: "Change role?" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {bulkRole && t("admin.users.changeRoleDesc", {
                defaultValue: "Change {{name}}'s role from {{old}} to {{new}}?",
                name: [bulkRole.user.name, bulkRole.user.last_name].filter(Boolean).join(" ") || bulkRole.user.email,
                old: bulkRole.user.role_name || "student",
                new: bulkRole.newRole,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("admin.users.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => bulkRole && changeUserRole(bulkRole.user, bulkRole.newRole)}>
              {t("admin.users.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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

      <AlertDialog open={!!confirmArchive} onOpenChange={(o) => !o && setConfirmArchive(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmArchive?.mode === "archive"
                ? `${confirmArchive?.ids.length} ta talabani arxivlash`
                : `${confirmArchive?.ids.length} ta talabani qayta faollashtirish`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmArchive?.mode === "archive"
                ? "Ularning ma'lumotlari, baholari, sertifikatlari saqlanadi. Arxivlangan talabalar dashboard, leaderboard, eslatmalar va digestdan chiqariladi (lekin botda javob berishni davom ettiradi)."
                : "Ushbu talabalar yana barcha hisob-kitoblarga, eslatmalarga va digestga qo'shiladi."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirmArchive && bulkArchive(confirmArchive.ids, confirmArchive.mode)}>
              Davom ettirish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
  );
}
