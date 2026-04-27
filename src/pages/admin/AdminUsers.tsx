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
import { Plus, Upload as UploadIcon, Search, Copy, RefreshCw, Trash2, Download, Mail, Unlock } from "lucide-react";
import { toast } from "sonner";

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
  name: string;
  last_name?: string;
  email: string;
  password?: string;
  telegram_username?: string;
  role: "student" | "admin";
  valid: boolean;
  reason?: string;
}

const randPassword = () =>
  Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6).toUpperCase();

const CSV_TEMPLATE = `name,last_name,email,password,telegram_username,role
Aida,Khan,aida@example.com,,@aidakhan,student
Bilol,Karimov,bilol@example.com,SecurePass123!,,student
Chen,Wei,chen@example.com,,,student
Dilnoza,Yusupova,dilnoza@example.com,,,student
Elnur,Aliyev,elnur@example.com,AdminPass456!,@elnura,admin
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
  const [newRole, setNewRole] = useState<"student" | "admin">("student");
  const [newCourses, setNewCourses] = useState<Set<string>>(new Set());
  const [sendInvite, setSendInvite] = useState(true);
  // CSV
  const [openCsv, setOpenCsv] = useState(false);
  const [csvText, setCsvText] = useState("");
  const [csvParsed, setCsvParsed] = useState<CsvRow[]>([]);
  const [importing, setImporting] = useState(false);
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
          (u.telegram_username || "").toLowerCase().includes(q)
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
    const res = await callCreate([{
      name: newName,
      last_name: newLastName || undefined,
      email: newEmail,
      password: newPassword || undefined,
      telegram_username: newTg.replace(/^@/, "") || undefined,
      role: newRole,
    }]);
    const r = res?.results?.[0];
    if (r?.status === "created") {
      toast.success(r.action_link
        ? t("admin.users.toasts.createdInvite", { email: newEmail })
        : t("admin.users.toasts.created", { email: newEmail }));
      setOpenAdd(false);
      setNewName(""); setNewLastName(""); setNewEmail(""); setNewPassword(randPassword());
      setNewTg(""); setNewRole("student"); setNewCourses(new Set());
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
    const lines = txt.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const seen = new Set<string>();
    const rows: CsvRow[] = lines.map((line, i) => {
      // Skip header (detect by presence of "email" + ("name" or "last_name"))
      if (i === 0 && /email/i.test(line) && /(name|last_name)/i.test(line)) return null as any;
      const parts = line.split(",").map((p) => p.trim());
      // Detect new vs legacy format.
      // New: name,last_name,email,password,telegram_username,role  (6 cols)
      // Legacy: name,email,password,telegram_username,role          (5 cols)
      let name = "", last_name = "", email = "", password = "", tg = "", role = "";
      if (parts.length >= 6) {
        [name, last_name, email, password, tg, role] = parts;
      } else {
        // Legacy 5-col fallback
        [name, email, password, tg, role] = parts;
      }
      const r = (role || "student").toLowerCase();
      const validRole = r === "admin" || r === "student";
      const validEmail = !!email && /^\S+@\S+\.\S+$/.test(email);
      const dup = seen.has((email || "").toLowerCase());
      seen.add((email || "").toLowerCase());
      let reason: string | undefined;
      let valid = true;
      if (!validEmail) { valid = false; reason = t("validation.emailInvalid"); }
      else if (dup) { valid = false; reason = t("admin.users.csvHeaders.email"); }
      else if (!validRole) { valid = false; reason = t("admin.users.role"); }
      return {
        name: name || "",
        last_name: last_name || undefined,
        email: email || "",
        password: password || undefined,
        telegram_username: (tg || "").replace(/^@/, "") || undefined,
        role: (validRole ? r : "student") as "student" | "admin",
        valid, reason,
      };
    }).filter(Boolean) as CsvRow[];
    setCsvParsed(rows);
  };

  const importCsv = async () => {
    setImporting(true);
    const valid = csvParsed.filter((r) => r.valid);
    const r = await fetch(`${FN_BASE}/admin-create-students`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify({
        students: valid,
        send_invite: true,
        csv_import: true,
        redirectTo: `${window.location.origin}/reset-password`,
      }),
    });
    const res = await r.json();
    setImporting(false);
    const created = (res?.results || []).filter((x: any) => x.status === "created").length;
    toast.success(t("admin.users.toasts.imported", { n: created, total: valid.length }));
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
            <h1 className="text-3xl font-semibold tracking-tight">Users</h1>
            <p className="text-muted-foreground mt-1">{users.length} total · {users.filter(u => u.is_admin).length} admins</p>
          </div>
          <div className="flex gap-2">
            {selected.size > 0 && (
              <Button variant="outline" size="sm" onClick={() => {
                const emails = users.filter((u) => selected.has(u.id)).map((u) => u.email);
                resendWelcome(emails);
              }}>
                <Mail className="h-4 w-4" /> Resend welcome ({selected.size})
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setOpenCsv(true)}><UploadIcon className="h-4 w-4" />Import CSV</Button>
            <Button size="sm" onClick={() => { setNewPassword(randPassword()); setOpenAdd(true); }}><Plus className="h-4 w-4" />Add user</Button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 items-center">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search by name, email, or @telegram" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All status</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>
          <Select value={roleFilter} onValueChange={setRoleFilter}>
            <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All roles</SelectItem>
              <SelectItem value="admin">Admins</SelectItem>
              <SelectItem value="student">Students</SelectItem>
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
                  <th className="text-left p-3">Name</th>
                  <th className="text-left p-3">Last name</th>
                  <th className="text-left p-3">Email</th>
                  <th className="text-left p-3">Telegram</th>
                  <th className="text-left p-3">Role</th>
                  <th className="text-left p-3">Status</th>
                  <th className="text-left p-3">Courses</th>
                  <th className="text-left p-3">Last login</th>
                  <th className="p-3"></th>
                </tr>
              </thead>
              <tbody>
                {loading && <tr><td colSpan={10} className="p-6 text-center text-muted-foreground">Loading…</td></tr>}
                {!loading && filtered.length === 0 && <tr><td colSpan={10} className="p-6 text-center text-muted-foreground">No users found</td></tr>}
                {filtered.map((u) => (
                  <tr key={u.id} className="border-t hover:bg-muted/20">
                    <td className="p-3"><Checkbox checked={selected.has(u.id)} onCheckedChange={() => toggleSelect(u.id)} /></td>
                    <td className="p-3 font-medium">{u.name || "—"}</td>
                    <td className="p-3 text-muted-foreground">{u.last_name || "—"}</td>
                    <td className="p-3 text-muted-foreground">
                      {u.email}
                      {isLocked(u.email) && <Badge variant="destructive" className="ml-2 text-[10px]">Locked</Badge>}
                    </td>
                    <td className="p-3 text-xs text-muted-foreground">{u.telegram_username ? `@${u.telegram_username}` : "—"}</td>
                    <td className="p-3">{u.is_admin ? <Badge>admin</Badge> : <Badge variant="secondary">student</Badge>}</td>
                    <td className="p-3"><span className={`text-xs px-2 py-0.5 rounded-full ${u.status === "active" ? "bg-muted" : "bg-destructive/10 text-destructive"}`}>{u.status}</span></td>
                    <td className="p-3 text-xs text-muted-foreground">{(enrollMap[u.id]?.size) || 0}</td>
                    <td className="p-3 text-xs text-muted-foreground">{u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleDateString() : "—"}</td>
                    <td className="p-3"><Button variant="ghost" size="sm" onClick={() => setManageUser(u)}>Manage</Button></td>
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
          <DialogHeader><DialogTitle>Add user</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5"><Label>First name</Label><Input value={newName} onChange={(e) => setNewName(e.target.value)} /></div>
              <div className="space-y-1.5">
                <Label>Last name</Label>
                <Input value={newLastName} onChange={(e) => setNewLastName(e.target.value)} placeholder="Optional" />
              </div>
            </div>
            <p className="text-xs text-muted-foreground -mt-1">Helps Telegram login match by full name when username is missing.</p>
            <div className="space-y-1.5"><Label>Email</Label><Input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} /></div>
            <div className="space-y-1.5">
              <Label>Password (optional — leave blank to send magic-link invite)</Label>
              <div className="flex gap-2">
                <Input value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
                <Button type="button" variant="outline" size="icon" onClick={() => setNewPassword(randPassword())}><RefreshCw className="h-4 w-4" /></Button>
                <Button type="button" variant="outline" size="icon" onClick={() => { navigator.clipboard.writeText(newPassword); toast.success("Copied"); }}><Copy className="h-4 w-4" /></Button>
              </div>
            </div>
            <div className="space-y-1.5"><Label>Telegram username (optional)</Label><Input value={newTg} onChange={(e) => setNewTg(e.target.value)} placeholder="@username" /></div>
            <div className="space-y-1.5">
              <Label>Role</Label>
              <Select value={newRole} onValueChange={(v) => setNewRole(v as any)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="student">Student</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Enroll in courses</Label>
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
              Send magic-link welcome email
            </label>
          </div>
          <DialogFooter><Button onClick={handleAdd}>Create user</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* CSV dialog */}
      <Dialog open={openCsv} onOpenChange={setOpenCsv}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle>Import users from CSV</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 p-3">
              <div className="text-xs text-muted-foreground">
                Format: <code>name,last_name,email,password,telegram_username,role</code><br />
                <span>last_name, password, telegram_username, role are optional. Defaults: blank, magic-link invite, no telegram, role=student.</span>
              </div>
              <Button variant="default" size="sm" onClick={downloadTemplate}><Download className="h-4 w-4" />Download template</Button>
            </div>
            <Textarea
              rows={6}
              value={csvText}
              onChange={(e) => { setCsvText(e.target.value); parseCsv(e.target.value); }}
              placeholder="Aida,Khan,aida@example.com,,@aidakhan,student&#10;Bilol,Karimov,bilol@example.com,SecurePass123!,,student"
            />
            {csvParsed.length > 0 && (
              <div className="border rounded-md max-h-64 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-xs sticky top-0">
                    <tr>
                      <th className="text-left p-2">Name</th>
                      <th className="text-left p-2">Last name</th>
                      <th className="text-left p-2">Email</th>
                      <th className="text-left p-2">Telegram</th>
                      <th className="text-left p-2">Role</th>
                      <th className="text-left p-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {csvParsed.map((r, i) => (
                      <tr key={i} className={`border-t ${!r.valid ? "bg-destructive/5" : ""}`}>
                        <td className="p-2">{r.name}</td>
                        <td className="p-2">{r.last_name || "—"}</td>
                        <td className="p-2">{r.email}</td>
                        <td className="p-2 text-xs">{r.telegram_username ? `@${r.telegram_username}` : "—"}</td>
                        <td className="p-2 text-xs">{r.role}</td>
                        <td className={`p-2 text-xs ${r.valid ? "text-foreground" : "text-destructive font-medium"}`}>
                          {r.valid ? "Valid" : r.reason}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="text-xs text-muted-foreground">{csvParsed.filter(r => r.valid).length} valid · {csvParsed.filter(r => !r.valid).length} invalid</div>
          </div>
          <DialogFooter>
            <Button onClick={importCsv} disabled={importing || csvParsed.filter(r => r.valid).length === 0}>
              {importing ? "Importing…" : `Import ${csvParsed.filter(r => r.valid).length} users`}
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
                    <Label>First name</Label>
                    <Input defaultValue={manageUser.name || ""} onBlur={(e) => e.target.value !== (manageUser.name || "") && updateProfile(manageUser, { name: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Last name</Label>
                    <Input defaultValue={manageUser.last_name || ""} onBlur={(e) => {
                      const v = e.target.value || null;
                      if (v !== (manageUser.last_name || null)) updateProfile(manageUser, { last_name: v });
                    }} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Email</Label>
                  <Input defaultValue={manageUser.email} onBlur={(e) => e.target.value !== manageUser.email && updateProfile(manageUser, { email: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label>Telegram username</Label>
                  <Input defaultValue={manageUser.telegram_username || ""} placeholder="username" onBlur={(e) => {
                    const v = e.target.value.replace(/^@/, "") || null;
                    if (v !== manageUser.telegram_username) updateProfile(manageUser, { telegram_username: v });
                  }} />
                </div>
                <div className="space-y-1.5">
                  <Label>Role</Label>
                  <div className="flex gap-2 items-center">
                    <Badge>{manageUser.is_admin ? "admin" : "student"}</Badge>
                    <Button size="sm" variant="outline" onClick={() => setConfirmRole({ user: manageUser, promote: !manageUser.is_admin })}>
                      {manageUser.is_admin ? "Demote to student" : "Promote to admin"}
                    </Button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Status</Label>
                  <Select value={manageUser.status} onValueChange={(v) => setStatus(manageUser, v as any)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="inactive">Inactive</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Course access</Label>
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
                    {courses.length === 0 && <p className="text-xs text-muted-foreground">No courses</p>}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 pt-2">
                  <Button variant="outline" size="sm" onClick={() => resendWelcome([manageUser.email])}><Mail className="h-4 w-4" />Resend welcome</Button>
                  <Button variant="outline" size="sm" onClick={() => resetPassword(manageUser)}>Reset password</Button>
                  {isLocked(manageUser.email) && (
                    <Button variant="outline" size="sm" onClick={() => clearLockout(manageUser.email)}><Unlock className="h-4 w-4" />Clear lockout</Button>
                  )}
                  <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(manageUser)}><Trash2 className="h-4 w-4" />Remove</Button>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Role confirm */}
      <AlertDialog open={!!confirmRole} onOpenChange={(o) => !o && setConfirmRole(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmRole?.promote ? "Promote to admin?" : "Demote to student?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmRole?.promote
                ? "Admins can create courses, manage all users, and see all data. Continue?"
                : "This user will lose all admin privileges."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirmRole && setRole(confirmRole.user, confirmRole.promote)}>Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirm */}
      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this user?</AlertDialogTitle>
            <AlertDialogDescription>Cascade-deletes enrollments, progress, comments, and notes. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirmDelete && removeUser(confirmDelete)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
  );
}
