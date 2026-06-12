import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Trophy } from "lucide-react";

interface Row {
  rank: number; user_id: string; first_name: string; last_initial: string;
  score: number; current_streak: number; lessons_30d: number;
}

export default function Leaderboard() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [my, setMy] = useState<{ rank: number | null; total: number; score: number | null } | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      const [{ data: top }, { data: mine }] = await Promise.all([
        supabase.rpc("leaderboard_top", { _limit: 10 }),
        user ? supabase.rpc("leaderboard_my_rank", { uid: user.id }) : Promise.resolve({ data: null } as any),
      ]);
      const tops = (top as any) || [];
      setRows(tops);
      const m: any = Array.isArray(mine) ? mine[0] : (mine as any)?.[0];
      if (m) setMy({ rank: m.rank, total: m.total, score: m.score });
      setLoading(false);
    })();
  }, [user]);

  return (
    <PageShell>
      <div className="max-w-3xl space-y-6">
        <div className="flex items-center gap-3">
          <Trophy className="h-7 w-7 text-yellow-500" />
          <h1 className="text-3xl font-semibold tracking-tight">🏆 TOP 10 Reyting</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Faollik bali oxirgi 30 kun ichidagi darslar, daqiqalar va streak asosida hisoblanadi (har 15 daqiqada yangilanadi).
        </p>

        <Card className="overflow-hidden shadow-soft">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium w-12">#</th>
                <th className="text-left px-4 py-2.5 font-medium">Talaba</th>
                <th className="text-right px-4 py-2.5 font-medium">Bal</th>
                <th className="text-right px-4 py-2.5 font-medium">🔥</th>
                <th className="text-right px-4 py-2.5 font-medium">Darslar (30k)</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">Yuklanmoqda…</td></tr>}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">Hali ma'lumot yo'q</td></tr>
              )}
              {rows.map((r) => {
                const mine = r.user_id === user?.id;
                return (
                  <tr key={r.user_id} className={`border-t ${mine ? "bg-primary/5 font-semibold" : ""}`}>
                    <td className="px-4 py-2.5 tabular-nums">{r.rank}</td>
                    <td className="px-4 py-2.5">{r.first_name} {r.last_initial ? r.last_initial + "." : ""}{mine && " (Siz)"}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{r.score}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{r.current_streak}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{r.lessons_30d}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>

        {my && my.rank && my.rank > 10 && (
          <Card className="p-4 text-sm">
            Sizning o'rningiz: <span className="font-semibold">{my.rank}</span> / {my.total} · Bal: <span className="font-semibold">{my.score}</span>
          </Card>
        )}
      </div>
    </PageShell>
  );
}
