import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Download, Users as UsersIcon } from "lucide-react";
import { toast } from "sonner";

type Group = { id: string; name: string };
type Stat = { group_id: string; logged_in_count: number; total_active: number };
type RosterRow = {
  name?: string | null; last_name?: string | null;
  telegram_username?: string | null; telegram_user_id?: number | null;
  first_login_at?: string | null; last_login_at?: string | null;
  has_logged_in?: boolean; lessons_completed?: number; homework_avg?: number;
  status?: string; created_at?: string; email?: string;
};

export function TeacherLoginAnalytics() {
  const { user, role } = useAuth();
  const [groups, setGroups] = useState<Group[]>([]);
  const [stats, setStats] = useState<Record<string, Stat>>({});
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState<string | null>(null);
  const [neverModal, setNeverModal] = useState<{ group: Group; rows: RosterRow[] } | null>(null);

  useEffect(() => {
    if (!user || role !== "teacher") { setLoading(false); return; }
    (async () => {
      setLoading(true);
      const { data: gs } = await supabase.from("groups").select("id, name").eq("teacher_id", user.id).order("name");
      const gList = ((gs as any[]) || []) as Group[];
      setGroups(gList);
      if (gList.length) {
        const { data: ls } = await supabase.rpc("admin_group_login_stats" as any);
        const map: Record<string, Stat> = {};
        ((ls as any[]) || []).forEach((r) => { map[r.group_id] = r as Stat; });
        setStats(map);
      }
      setLoading(false);
    })();
  }, [user, role]);

  if (role !== "teacher") return null;
  if (loading) return null;

  if (groups.length === 0) {
    return (
      <Card className="p-6 border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400">
        Sizga hali guruh biriktirilmagan. Admin biriktirgach bu yerda ko'rinadi.
      </Card>
    );
  }

  const downloadCsv = async (g: Group) => {
    setExporting(g.id);
    try {
      const { data, error } = await supabase.rpc("admin_export_group_csv" as any, { _group_id: g.id, _include_archived: false });
      if (error) throw error;
      const rows = ((data as any[]) || []) as RosterRow[];
      const headers = ["name","last_name","email","telegram_user_id","telegram_username","first_login_at","last_login_at","has_logged_in","lessons_completed","homework_avg","status","created_at"];
      const esc = (v: unknown) => {
        const s = v === null || v === undefined ? "" : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const csv = [headers.join(","), ...rows.map((r: any) => headers.map((h) => esc(r[h])).join(","))].join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `group_${g.name.replace(/\s+/g, "_")}_logins.csv`; a.click();
      URL.revokeObjectURL(url);
      toast.success(`${rows.length} qator eksport qilindi`);
    } catch (e: any) {
      toast.error(e?.message || "Eksport xatosi");
    } finally {
      setExporting(null);
    }
  };

  const openNever = async (g: Group) => {
    try {
      const { data, error } = await supabase.rpc("admin_export_group_csv" as any, { _group_id: g.id, _include_archived: false });
      if (error) throw error;
      const rows = (((data as any[]) || []) as RosterRow[]).filter((r) => !r.has_logged_in);
      setNeverModal({ group: g, rows });
    } catch (e: any) {
      toast.error(e?.message || "Yuklab bo'lmadi");
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <UsersIcon className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">Login analitikasi</h3>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {groups.map((g) => {
          const s = stats[g.id] || { logged_in_count: 0, total_active: 0, group_id: g.id };
          const total = s.total_active || 0;
          const logged = s.logged_in_count || 0;
          const never = Math.max(0, total - logged);
          const pct = total > 0 ? Math.round((logged / total) * 100) : 0;
          const pctCls = total === 0 ? "text-muted-foreground" : logged === 0 ? "text-rose-600" : pct < 50 ? "text-amber-600" : "text-emerald-600";
          return (
            <Card key={g.id} className="p-5">
              <div className="flex items-start justify-between gap-3 mb-4">
                <div>
                  <div className="text-xs text-muted-foreground">Guruh</div>
                  <div className="text-lg font-semibold">{g.name}</div>
                </div>
                <Button variant="outline" size="sm" disabled={exporting === g.id} onClick={() => downloadCsv(g)}>
                  <Download className="h-3.5 w-3.5" /> {exporting === g.id ? "Eksport…" : "Yuklab olish"}
                </Button>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="p-3 rounded-md bg-muted">
                  <div className="text-xs text-muted-foreground">Jami</div>
                  <div className="text-2xl font-bold tabular-nums">{total}</div>
                </div>
                <div className="p-3 rounded-md bg-emerald-500/10">
                  <div className="text-xs text-emerald-700 dark:text-emerald-400">Kirgan</div>
                  <div className={`text-2xl font-bold tabular-nums ${pctCls}`}>{logged}</div>
                  <div className="text-xs text-muted-foreground">{pct}%</div>
                </div>
                <div className="p-3 rounded-md bg-rose-500/10">
                  <div className="text-xs text-rose-700 dark:text-rose-400">Hech qachon</div>
                  <div className="text-2xl font-bold tabular-nums text-rose-600">{never}</div>
                </div>
              </div>
              {never > 0 && (
                <button
                  onClick={() => openNever(g)}
                  className="mt-3 text-xs text-rose-600 hover:text-rose-700 hover:underline"
                >
                  Hech qachon kirmaganlar ro'yxati →
                </button>
              )}
            </Card>
          );
        })}
      </div>

      <Dialog open={!!neverModal} onOpenChange={(o) => !o && setNeverModal(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{neverModal?.group.name} — Hech qachon kirmaganlar ({neverModal?.rows.length || 0})</DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-auto">
            {neverModal?.rows.length === 0 ? (
              <div className="text-sm text-muted-foreground py-6 text-center">Hammasi kirgan 🎉</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground border-b">
                  <tr><th className="text-left p-2">Ism</th><th className="text-left p-2">Familiya</th><th className="text-left p-2">Telegram</th><th className="text-left p-2">Qo'shilgan</th></tr>
                </thead>
                <tbody>
                  {neverModal?.rows.map((r, i) => (
                    <tr key={i} className="border-b">
                      <td className="p-2">{r.name || "—"}</td>
                      <td className="p-2">{r.last_name || "—"}</td>
                      <td className="p-2">{r.telegram_username ? `@${r.telegram_username}` : (r.telegram_user_id || "—")}</td>
                      <td className="p-2 text-muted-foreground">{r.created_at ? new Date(r.created_at).toLocaleDateString() : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
