import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Upload as UploadIcon } from "lucide-react";
import { toast } from "sonner";

interface StudentRow { id: string; email: string; name: string | null; created_at: string; status: string }

export default function Admin() {
  const { t } = useTranslation();
  const { session } = useAuth();
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [stats, setStats] = useState<any>({ total: 0, active7d: 0, signups7d: 0, enrollments: 0 });
  const [openAdd, setOpenAdd] = useState(false);
  const [openCsv, setOpenCsv] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [csvText, setCsvText] = useState("");
  const [csvParsed, setCsvParsed] = useState<{ name: string; email: string; password?: string; valid: boolean; reason?: string }[]>([]);
  const [importing, setImporting] = useState(false);

  const reload = async () => {
    const { data: profs } = await supabase.from("profiles").select("id, email, name, created_at, status").order("created_at", { ascending: false });
    setStudents((profs || []) as StudentRow[]);
    const total = profs?.length || 0;
    const cutoff = Date.now() - 7 * 86400_000;
    const signups7d = (profs || []).filter((p: any) => new Date(p.created_at).getTime() > cutoff).length;
    const { count: enr } = await supabase.from("enrollments").select("id", { count: "exact", head: true });
    setStats({ total, signups7d, active7d: signups7d, enrollments: enr || 0 });
  };

  useEffect(() => { reload(); }, []);

  const callCreate = async (rows: { name?: string; email: string; password?: string }[]) => {
    const { data: course } = await supabase.from("courses").select("id").eq("is_default_for_signup", true).maybeSingle();
    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-create-students`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify({ students: rows, courseId: course?.id }),
    });
    return r.json();
  };

  const handleAdd = async () => {
    if (!newEmail) return;
    const res = await callCreate([{ name: newName, email: newEmail, password: newPassword || undefined }]);
    if (res?.results?.[0]?.status === "created") {
      const r = res.results[0];
      toast.success(`${t("admin.overview.createdToast")} ${r.password ? `Password: ${r.password}` : ""}`);
      setOpenAdd(false); setNewName(""); setNewEmail(""); setNewPassword(""); reload();
    } else {
      toast.error(res?.results?.[0]?.error || res?.error || t("admin.overview.createFailed"));
    }
  };

  const parseCsv = (txt: string) => {
    const lines = txt.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const rows = lines.map((line, i) => {
      if (i === 0 && /name.*email/i.test(line)) return null;
      const parts = line.split(",").map((p) => p.trim());
      const [name, email, password] = parts;
      const valid = !!email && /^\S+@\S+\.\S+$/.test(email);
      return { name: name || "", email: email || "", password, valid, reason: !valid ? t("admin.common.invalid") : undefined };
    }).filter(Boolean) as any[];
    setCsvParsed(rows);
  };

  const importCsv = async () => {
    setImporting(true);
    const validRows = csvParsed.filter((r) => r.valid);
    const res = await callCreate(validRows.map((r) => ({ name: r.name, email: r.email, password: r.password })));
    setImporting(false);
    const created = (res?.results || []).filter((r: any) => r.status === "created").length;
    toast.success(t("admin.overview.importedToast", { n: created, total: validRows.length }));
    setOpenCsv(false); setCsvText(""); setCsvParsed([]); reload();
  };

  return (
    <PageShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{t("admin.overview.title")}</h1>
          <p className="text-muted-foreground mt-1">{t("admin.overview.subtitle")}</p>
        </div>
        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">{t("admin.overview.tabs.overview")}</TabsTrigger>
            <TabsTrigger value="students">{t("admin.overview.tabs.students")}</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard label={t("admin.overview.stats.totalStudents")} value={stats.total} />
              <StatCard label={t("admin.overview.stats.new7d")} value={stats.signups7d} />
              <StatCard label={t("admin.overview.stats.active7d")} value={stats.active7d} />
              <StatCard label={t("admin.overview.stats.enrollments")} value={stats.enrollments} />
            </div>
          </TabsContent>
          <TabsContent value="students" className="space-y-4">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <h2 className="font-semibold">{t("admin.overview.studentsCount", { count: students.length })}</h2>
              <div className="flex gap-2">
                <Dialog open={openCsv} onOpenChange={setOpenCsv}>
                  <DialogTrigger asChild><Button variant="outline" size="sm"><UploadIcon className="h-4 w-4" />{t("admin.common.importCsv").replace(/^\+\s*/, "")}</Button></DialogTrigger>
                  <DialogContent className="max-w-2xl">
                    <DialogHeader><DialogTitle>{t("admin.overview.csvTitle")}</DialogTitle></DialogHeader>
                    <div className="space-y-3">
                      <p className="text-xs text-muted-foreground" dangerouslySetInnerHTML={{ __html: t("admin.overview.csvFormat") }} />
                      <Textarea rows={6} value={csvText} onChange={(e) => { setCsvText(e.target.value); parseCsv(e.target.value); }} placeholder="Sam Patel,sam@test.io,test123&#10;Mira Cohen,mira@test.io,test123" />
                      {csvParsed.length > 0 && (
                        <div className="border rounded-md max-h-48 overflow-y-auto">
                          <table className="w-full text-sm">
                            <thead className="bg-muted/40 text-xs"><tr><th className="text-left p-2">{t("admin.overview.name")}</th><th className="text-left p-2">{t("admin.overview.email")}</th><th className="text-left p-2">{t("admin.overview.status")}</th></tr></thead>
                            <tbody>
                              {csvParsed.map((r, i) => (
                                <tr key={i} className="border-t">
                                  <td className="p-2">{r.name}</td>
                                  <td className="p-2">{r.email}</td>
                                  <td className={`p-2 text-xs ${r.valid ? "text-foreground" : "text-destructive"}`}>{r.valid ? t("admin.common.valid") : r.reason}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                      <div className="text-xs text-muted-foreground">{t("admin.overview.validCount", { valid: csvParsed.filter(r => r.valid).length, invalid: csvParsed.filter(r => !r.valid).length })}</div>
                    </div>
                    <DialogFooter>
                      <Button onClick={importCsv} disabled={importing || csvParsed.filter(r => r.valid).length === 0}>
                        {importing ? t("admin.overview.importing") : t("admin.overview.importN", { n: csvParsed.filter(r => r.valid).length })}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
                <Dialog open={openAdd} onOpenChange={setOpenAdd}>
                  <DialogTrigger asChild><Button size="sm"><Plus className="h-4 w-4" />{t("admin.overview.addStudent")}</Button></DialogTrigger>
                  <DialogContent>
                    <DialogHeader><DialogTitle>{t("admin.overview.addStudentTitle")}</DialogTitle></DialogHeader>
                    <div className="space-y-3">
                      <div className="space-y-1.5"><Label>{t("admin.overview.name")}</Label><Input value={newName} onChange={(e) => setNewName(e.target.value)} /></div>
                      <div className="space-y-1.5"><Label>{t("admin.overview.email")}</Label><Input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} /></div>
                      <div className="space-y-1.5"><Label>{t("admin.overview.passwordAuto")}</Label><Input value={newPassword} onChange={(e) => setNewPassword(e.target.value)} /></div>
                    </div>
                    <DialogFooter><Button onClick={handleAdd}>{t("admin.overview.createStudent")}</Button></DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            </div>
            <Card className="overflow-hidden shadow-soft">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs">
                  <tr><th className="text-left p-3">{t("admin.overview.name")}</th><th className="text-left p-3">{t("admin.overview.email")}</th><th className="text-left p-3">{t("admin.overview.joined")}</th><th className="text-left p-3">{t("admin.overview.status")}</th></tr>
                </thead>
                <tbody>
                  {students.map((s) => (
                    <tr key={s.id} className="border-t hover:bg-muted/20">
                      <td className="p-3 font-medium">{s.name || "—"}</td>
                      <td className="p-3 text-muted-foreground">{s.email}</td>
                      <td className="p-3 text-muted-foreground text-xs">{new Date(s.created_at).toLocaleDateString()}</td>
                      <td className="p-3"><span className="text-xs px-2 py-0.5 rounded-full bg-muted">{s.status === "active" ? t("admin.common.active") : t("admin.common.inactive")}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </PageShell>
  );
}

const StatCard = ({ label, value }: { label: string; value: any }) => (
  <Card className="p-5 shadow-soft">
    <div className="text-xs text-muted-foreground">{label}</div>
    <div className="text-3xl font-semibold tracking-tight mt-1 tabular-nums">{value}</div>
  </Card>
);
