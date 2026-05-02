import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronLeft } from "lucide-react";

type Overview = {
  group_id: string;
  group_name: string;
  total_students: number;
  active_7d: number;
  avg_completion_pct: number;
  avg_score_pct: number;
  health: number;
};

type Member = {
  user_id: string;
  name: string | null;
  email: string;
  telegram_username: string | null;
  last_active_at: string | null;
  completion_pct: number;
  avg_score_pct: number | null;
};

export default function GroupDetail() {
  const { id } = useParams<{ id: string }>();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    (async () => {
      setLoading(true);
      const [ov, mem] = await Promise.all([
        supabase.rpc("staff_group_overview" as any, { _group_id: id }),
        supabase.rpc("staff_group_members" as any, { _group_id: id }),
      ]);
      const ovRow = Array.isArray(ov.data) ? ov.data[0] : ov.data;
      setOverview((ovRow as Overview) || null);
      setMembers(((mem.data as any[]) || []) as Member[]);
      setLoading(false);
    })();
  }, [id]);

  return (
    <PageShell>
      <div className="space-y-6">
        <Link to="/admin/groups" className="inline-flex items-center text-sm text-muted-foreground hover:underline">
          <ChevronLeft className="h-4 w-4 mr-1" /> Back to groups
        </Link>
        <div>
          <h1 className="text-2xl font-semibold">{overview?.group_name || "Group"}</h1>
          <p className="text-sm text-muted-foreground">Group analytics and members</p>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !overview ? (
          <p className="text-sm text-muted-foreground">Group not found or no analytics yet.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <Card className="p-4"><div className="text-xs text-muted-foreground">Students</div><div className="text-2xl font-semibold">{overview.total_students}</div></Card>
              <Card className="p-4"><div className="text-xs text-muted-foreground">Active 7d</div><div className="text-2xl font-semibold">{overview.active_7d}</div></Card>
              <Card className="p-4"><div className="text-xs text-muted-foreground">Avg completion</div><div className="text-2xl font-semibold">{overview.avg_completion_pct}%</div></Card>
              <Card className="p-4"><div className="text-xs text-muted-foreground">Avg score</div><div className="text-2xl font-semibold">{overview.avg_score_pct}%</div></Card>
              <Card className="p-4"><div className="text-xs text-muted-foreground">Health</div><div className="text-2xl font-semibold">{overview.health}</div></Card>
            </div>

            <Card className="p-0 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="text-left p-3">Name</th>
                    <th className="text-left p-3">Email</th>
                    <th className="text-left p-3">Telegram</th>
                    <th className="text-left p-3">Last active</th>
                    <th className="text-left p-3">Completion</th>
                    <th className="text-left p-3">Avg score</th>
                  </tr>
                </thead>
                <tbody>
                  {members.length === 0 ? (
                    <tr><td colSpan={6} className="text-center text-muted-foreground py-6">No members.</td></tr>
                  ) : members.map((m) => (
                    <tr key={m.user_id} className="border-t">
                      <td className="p-3">{m.name || "—"}</td>
                      <td className="p-3 text-xs">{m.email}</td>
                      <td className="p-3 text-xs">{m.telegram_username ? `@${m.telegram_username}` : "—"}</td>
                      <td className="p-3 text-xs">{m.last_active_at ? new Date(m.last_active_at).toLocaleDateString() : <Badge variant="secondary">never</Badge>}</td>
                      <td className="p-3">{m.completion_pct}%</td>
                      <td className="p-3">{m.avg_score_pct ?? "—"}{m.avg_score_pct != null ? "%" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>

            <Button asChild variant="outline" size="sm">
              <Link to="/admin/users">Manage members in Users page →</Link>
            </Button>
          </>
        )}
      </div>
    </PageShell>
  );
}
