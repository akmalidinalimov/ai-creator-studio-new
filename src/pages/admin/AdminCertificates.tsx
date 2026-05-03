import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Loader2, RefreshCw, ExternalLink, Ban } from "lucide-react";

interface CertRow {
  id: string;
  serial_no: string;
  student_full_name: string;
  issued_at: string;
  pdf_url: string | null;
  verification_token: string;
  revoked_at: string | null;
  profile_id: string;
}

export default function AdminCertificates() {
  const [rows, setRows] = useState<CertRow[]>([]);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [profileGroup, setProfileGroup] = useState<Record<string, string | null>>({});
  const [groupFilter, setGroupFilter] = useState<string>("all");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const { data: certs } = await supabase
      .from("certificates")
      .select("*")
      .order("issued_at", { ascending: false });
    setRows((certs || []) as CertRow[]);
    const ids = Array.from(new Set((certs || []).map((c: any) => c.profile_id)));
    if (ids.length) {
      const { data: profs } = await supabase.from("profiles").select("id, group_id").in("id", ids);
      const map: Record<string, string | null> = {};
      (profs || []).forEach((p: any) => { map[p.id] = p.group_id; });
      setProfileGroup(map);
    }
    const { data: gs } = await supabase.from("groups").select("id, name").order("name");
    setGroups((gs || []) as any);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (from && r.issued_at < from) return false;
      if (to && r.issued_at > to + "T23:59:59") return false;
      if (groupFilter !== "all" && profileGroup[r.profile_id] !== groupFilter) return false;
      return true;
    });
  }, [rows, from, to, groupFilter, profileGroup]);

  const stats = useMemo(() => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const yearStart = new Date(now.getFullYear(), 0, 1).toISOString();
    return {
      total: rows.length,
      month: rows.filter((r) => r.issued_at >= monthStart).length,
      year: rows.filter((r) => r.issued_at >= yearStart).length,
    };
  }, [rows]);

  const regenerate = async (r: CertRow) => {
    setBusy(r.id);
    try {
      const { error } = await supabase.functions.invoke("generate-certificate", {
        body: { certificate_id: r.id, send_telegram: false },
      });
      if (error) throw error;
      toast.success("Qayta yaratildi");
      await load();
    } catch (e: any) {
      toast.error(e?.message || "Xatolik");
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (r: CertRow) => {
    if (!confirm(`Sertifikat ${r.serial_no} bekor qilinsinmi?`)) return;
    const { error } = await supabase.from("certificates").update({ revoked_at: new Date().toISOString() }).eq("id", r.id);
    if (error) return toast.error(error.message);
    toast.success("Bekor qilindi");
    load();
  };

  return (
    <PageShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">🏆 Sertifikatlar</h1>
          <p className="text-sm text-muted-foreground">Issued course completion certificates</p>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Card className="p-4"><div className="text-xs text-muted-foreground">Jami</div><div className="text-2xl font-bold">{stats.total}</div></Card>
          <Card className="p-4"><div className="text-xs text-muted-foreground">Bu oy</div><div className="text-2xl font-bold">{stats.month}</div></Card>
          <Card className="p-4"><div className="text-xs text-muted-foreground">Bu yil</div><div className="text-2xl font-bold">{stats.year}</div></Card>
        </div>

        <Card className="p-4">
          <div className="flex flex-wrap gap-3 items-end">
            <div>
              <label className="text-xs text-muted-foreground">Sanadan</label>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Sanagacha</label>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div className="min-w-[180px]">
              <label className="text-xs text-muted-foreground">Guruh</label>
              <Select value={groupFilter} onValueChange={setGroupFilter}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Barchasi</SelectItem>
                  {groups.map((g) => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
        </Card>

        <Card className="p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase">
                <tr>
                  <th className="text-left p-3">Serial</th>
                  <th className="text-left p-3">Talaba</th>
                  <th className="text-left p-3">Sana</th>
                  <th className="text-left p-3">Holat</th>
                  <th className="text-right p-3">Amallar</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">Yuklanmoqda…</td></tr>
                ) : filtered.length === 0 ? (
                  <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">Sertifikatlar topilmadi</td></tr>
                ) : filtered.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="p-3 font-mono text-xs">{r.serial_no}</td>
                    <td className="p-3">{r.student_full_name}</td>
                    <td className="p-3">{new Date(r.issued_at).toLocaleDateString("en-CA")}</td>
                    <td className="p-3">{r.revoked_at ? <span className="text-destructive">Bekor</span> : <span className="text-green-600">Faol</span>}</td>
                    <td className="p-3 text-right">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" disabled={busy === r.id} onClick={() => regenerate(r)} title="Qayta yaratish">
                          {busy === r.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                        </Button>
                        {r.pdf_url && (
                          <Button size="sm" variant="ghost" asChild title="Ko'rish">
                            <a href={r.pdf_url} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" /></a>
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" asChild title="Verify">
                          <a href={`/verify/${r.verification_token}`} target="_blank" rel="noreferrer">🔗</a>
                        </Button>
                        {!r.revoked_at && (
                          <Button size="sm" variant="ghost" onClick={() => revoke(r)} title="Bekor qilish">
                            <Ban className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </PageShell>
  );
}
