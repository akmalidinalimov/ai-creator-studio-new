import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { Loader2, RefreshCw, ArrowLeft } from "lucide-react";

interface ProfileLite {
  id: string;
  name: string | null;
  last_name: string | null;
  email: string;
  telegram_id: number | null;
  telegram_username: string | null;
  group_id: string | null;
  created_at: string;
}

interface Cluster {
  key: string;
  key_type: "telegram_id" | "telegram_username";
  canonical: ProfileLite;
  duplicates: ProfileLite[];
}

const fmtName = (p: ProfileLite) =>
  [p.name, p.last_name].filter(Boolean).join(" ") || "—";

export default function AdminUsersDuplicates() {
  const [loading, setLoading] = useState(true);
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [dupCount, setDupCount] = useState(0);
  const [merging, setMerging] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkRunning, setBulkRunning] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("admin-merge-duplicates", {
        body: { action: "list" },
      });
      if (error) throw error;
      setClusters(data?.clusters ?? []);
      setDupCount(data?.duplicate_row_count ?? 0);
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to load duplicates");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const mergeOne = async (canonicalId: string) => {
    setMerging(canonicalId);
    try {
      const { data, error } = await supabase.functions.invoke("admin-merge-duplicates", {
        body: { action: "merge_one", canonical_id: canonicalId },
      });
      if (error) throw error;
      toast.success(`Merged ${data?.merged_ids?.length ?? 0} duplicate(s)`);
      await load();
    } catch (e: any) {
      toast.error(e?.message ?? "Merge failed");
    } finally {
      setMerging(null);
    }
  };

  const mergeAll = async () => {
    setBulkRunning(true);
    try {
      const { data, error } = await supabase.functions.invoke("admin-merge-duplicates", {
        body: { action: "merge_all" },
      });
      if (error) throw error;
      toast.success(`Merged ${data?.merged ?? 0} clusters; ${data?.failed ?? 0} failed`);
      setBulkOpen(false);
      await load();
    } catch (e: any) {
      toast.error(e?.message ?? "Bulk merge failed");
    } finally {
      setBulkRunning(false);
    }
  };

  return (
    <PageShell>
      <div className="max-w-6xl mx-auto p-4 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <Link to="/admin/users" className="text-sm text-muted-foreground inline-flex items-center gap-1 hover:underline">
              <ArrowLeft className="h-3 w-3" /> Back to Users
            </Link>
            <h1 className="text-2xl font-semibold mt-1">Duplicate profiles</h1>
            <p className="text-sm text-muted-foreground">
              Clusters grouped by Telegram ID (or username if ID is missing). Canonical = oldest profile.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className="h-4 w-4 mr-1" /> Refresh
            </Button>
            <Button
              size="sm"
              onClick={() => setBulkOpen(true)}
              disabled={loading || clusters.length === 0}
            >
              Bulk Merge all ({clusters.length})
            </Button>
          </div>
        </div>

        <Card className="p-4 flex gap-6 text-sm">
          <div><span className="text-muted-foreground">Clusters:</span> <strong>{clusters.length}</strong></div>
          <div><span className="text-muted-foreground">Duplicate rows to delete:</span> <strong>{dupCount}</strong></div>
        </Card>

        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : clusters.length === 0 ? (
          <Card className="p-8 text-center text-muted-foreground">No duplicate clusters found 🎉</Card>
        ) : (
          <div className="space-y-3">
            {clusters.map((c) => (
              <Card key={c.canonical.id} className="p-4 space-y-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2 text-sm">
                    <Badge variant="secondary">{c.key_type}</Badge>
                    <code className="text-xs">{c.key}</code>
                    <Badge>{c.duplicates.length + 1} rows</Badge>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => mergeOne(c.canonical.id)}
                    disabled={merging === c.canonical.id}
                  >
                    {merging === c.canonical.id ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                    Merge ({c.duplicates.length} → 1)
                  </Button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-muted-foreground">
                      <tr className="border-b">
                        <th className="text-left py-1 pr-3">Role</th>
                        <th className="text-left py-1 pr-3">Profile ID</th>
                        <th className="text-left py-1 pr-3">Name</th>
                        <th className="text-left py-1 pr-3">Email</th>
                        <th className="text-left py-1 pr-3">tg_id</th>
                        <th className="text-left py-1 pr-3">tg_user</th>
                        <th className="text-left py-1 pr-3">group_id</th>
                        <th className="text-left py-1 pr-3">created_at</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b bg-primary/5">
                        <td className="py-1 pr-3"><Badge variant="default">canonical</Badge></td>
                        <td className="py-1 pr-3"><code>{c.canonical.id.slice(0, 8)}…</code></td>
                        <td className="py-1 pr-3">{fmtName(c.canonical)}</td>
                        <td className="py-1 pr-3">{c.canonical.email}</td>
                        <td className="py-1 pr-3">{c.canonical.telegram_id ?? "—"}</td>
                        <td className="py-1 pr-3">{c.canonical.telegram_username ?? "—"}</td>
                        <td className="py-1 pr-3">{c.canonical.group_id ? c.canonical.group_id.slice(0,8)+"…" : "—"}</td>
                        <td className="py-1 pr-3">{new Date(c.canonical.created_at).toLocaleString()}</td>
                      </tr>
                      {c.duplicates.map((d) => (
                        <tr key={d.id} className="border-b text-muted-foreground">
                          <td className="py-1 pr-3"><Badge variant="outline">duplicate</Badge></td>
                          <td className="py-1 pr-3"><code>{d.id.slice(0, 8)}…</code></td>
                          <td className="py-1 pr-3">{fmtName(d)}</td>
                          <td className="py-1 pr-3">{d.email}</td>
                          <td className="py-1 pr-3">{d.telegram_id ?? "—"}</td>
                          <td className="py-1 pr-3">{d.telegram_username ?? "—"}</td>
                          <td className="py-1 pr-3">{d.group_id ? d.group_id.slice(0,8)+"…" : "—"}</td>
                          <td className="py-1 pr-3">{new Date(d.created_at).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      <AlertDialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Merge all duplicate clusters?</AlertDialogTitle>
            <AlertDialogDescription>
              This will merge <strong>{clusters.length}</strong> cluster(s) and delete{" "}
              <strong>{dupCount}</strong> duplicate profile row(s) (and matching auth users).
              The oldest profile in each cluster is kept as canonical. This action is logged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkRunning}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); mergeAll(); }} disabled={bulkRunning}>
              {bulkRunning ? <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Merging…</> : "Merge all"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
  );
}
