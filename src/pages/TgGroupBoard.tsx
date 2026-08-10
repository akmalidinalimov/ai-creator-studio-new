// Telegram Mini App: the daily group board. Opened from the digest DM's "📊 Guruh reytingi" web_app
// button — runs INSIDE Telegram with no Supabase session. It reads Telegram's signed initData and
// sends it to the tg-group-board edge function, which validates it and checks admin/teacher role.
// Built to be screenshotted and dropped into the group chat: big medals, clean cards, branded header.
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, Trophy, Flame, Users as UsersIcon, Camera } from "lucide-react";

interface BoardRow {
  board: "alltime" | "weekly";
  rank: number;
  first_name: string;
  last_initial: string;
  xp: number;
  level: number;
  current_streak: number;
}
interface GroupStats {
  total_students: number; active_students: number; badges_earned: number;
  avg_completion_pct: number; homework_submitted: number; homework_avg_score: number | null;
  pending_homework: number; total_xp: number;
}
interface GroupBoard {
  group_id: string; group_name: string; tier_name: string | null; teacher_name: string;
  stats: GroupStats; alltime: BoardRow[]; weekly: BoardRow[];
}
interface Course { id: string; title: string }
interface LoadResult {
  role: "admin" | "teacher";
  courses?: Course[];
  course_id?: string;
  groups: GroupBoard[];
}

const medal = (r: number) => (r === 1 ? "🥇" : r === 2 ? "🥈" : r === 3 ? "🥉" : `${r}`);
const fullName = (r: BoardRow) => `${r.first_name}${r.last_initial ? " " + r.last_initial + "." : ""}`;
const todayTashkent = () =>
  new Date().toLocaleDateString("uz-UZ", { timeZone: "Asia/Tashkent", day: "numeric", month: "long", year: "numeric" });

function BoardCard({ title, icon, accent, rows, unit }: {
  title: string; icon: React.ReactNode; accent: string; rows: BoardRow[]; unit: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card shadow-soft overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border" style={{ background: accent }}>
        <span className="text-white">{icon}</span>
        <h3 className="text-sm font-bold text-white tracking-wide">{title}</h3>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-muted-foreground">Hali ma'lumot yo'q</div>
      ) : (
        <ol className="divide-y divide-border/60">
          {rows.map((r) => (
            <li key={`${r.board}-${r.rank}`} className="flex items-center gap-3 px-4 py-2.5">
              <span className={`w-7 text-center text-base ${r.rank <= 3 ? "" : "text-muted-foreground text-sm font-medium"}`}>
                {medal(r.rank)}
              </span>
              <span className="flex-1 font-medium truncate">{fullName(r)}</span>
              {r.current_streak > 0 && (
                <span className="text-xs text-muted-foreground tabular-nums">🔥{r.current_streak}</span>
              )}
              <span className="text-sm font-bold tabular-nums" style={{ color: accent }}>
                {r.xp.toLocaleString()} <span className="text-[10px] font-normal text-muted-foreground">{unit}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function StatChip({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2 text-center">
      <div className="text-lg font-bold tabular-nums leading-tight">{value}</div>
      <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</div>
    </div>
  );
}

export default function TgGroupBoard() {
  const [initData, setInitData] = useState<string | null | undefined>(undefined); // undefined=loading, null=not in TG
  const [res, setRes] = useState<LoadResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [courseId, setCourseId] = useState<string>("");
  const [groupIdx, setGroupIdx] = useState(0);
  const pollRef = useRef<number | null>(null);

  // Read Telegram's injected initData (same battle-tested pattern as TgBroadcast).
  useEffect(() => {
    let cancelled = false;
    const done = (v: string | null) => { if (!cancelled) setInitData(v); };
    const tryRead = (attempts: number) => {
      if (cancelled) return;
      const wa = (window as unknown as { Telegram?: { WebApp?: any } }).Telegram?.WebApp;
      if (wa?.initData) { try { wa.ready(); wa.expand(); } catch { /* ignore */ } return done(wa.initData); }
      if (attempts <= 0) return done(null);
      window.setTimeout(() => tryRead(attempts - 1), 150);
    };
    if ((window as unknown as { Telegram?: { WebApp?: any } }).Telegram?.WebApp) {
      tryRead(20);
    } else {
      const s = document.createElement("script");
      s.src = "https://telegram.org/js/telegram-web-app.js";
      s.async = true;
      s.onload = () => tryRead(20);
      s.onerror = () => tryRead(20);
      document.head.appendChild(s);
    }
    return () => { cancelled = true; if (pollRef.current) window.clearInterval(pollRef.current); };
  }, []);

  const load = async (cid?: string) => {
    if (!initData) return;
    setLoading(true); setErr(null);
    const { data, error } = await supabase.functions.invoke("tg-group-board", {
      body: { initData, ...(cid ? { course_id: cid } : {}) },
    });
    setLoading(false);
    if (error) { setErr("Ruxsat yo'q yoki xatolik"); return; }
    const r = data as LoadResult;
    setRes(r);
    setGroupIdx(0);
    if (r.role === "admin" && r.course_id) setCourseId(r.course_id);
  };

  useEffect(() => { if (initData) load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [initData]);

  if (initData === undefined) {
    return <div className="min-h-screen flex items-center justify-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  }
  if (initData === null) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Bu sahifani Telegram bot ichidagi <b>📊 Guruh reytingi</b> tugmasi orqali oching.
      </div>
    );
  }

  const groups = res?.groups || [];
  const g = groups[groupIdx];

  return (
    <div className="min-h-screen bg-background text-foreground p-4">
      <div className="max-w-lg mx-auto space-y-4">
        <div className="flex items-center gap-2">
          <Trophy className="h-5 w-5 text-yellow-500" />
          <h1 className="text-xl font-semibold">Guruh reytingi</h1>
          <span className="ml-auto text-xs text-muted-foreground">{todayTashkent()}</span>
        </div>

        {/* Admin course picker */}
        {res?.role === "admin" && (res.courses?.length ?? 0) > 0 && (
          <select
            value={courseId}
            onChange={(e) => { setCourseId(e.target.value); load(e.target.value); }}
            className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
          >
            {res!.courses!.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
        )}

        {/* Group tabs (when more than one) */}
        {groups.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            {groups.map((gr, i) => (
              <button
                key={gr.group_id}
                onClick={() => setGroupIdx(i)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                  i === groupIdx ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:bg-muted"
                }`}
              >
                {gr.group_name}
              </button>
            ))}
          </div>
        )}

        {loading && <div className="py-10 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}
        {err && !loading && (
          <div className="py-8 text-center space-y-3">
            <p className="text-sm text-muted-foreground">{err}</p>
            <button onClick={() => load(courseId || undefined)} className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted">Qayta urinish</button>
          </div>
        )}
        {!loading && !err && groups.length === 0 && (
          <div className="py-10 text-center text-sm text-muted-foreground">Guruh topilmadi.</div>
        )}

        {!loading && !err && g && (
          <div className="space-y-4">
            {/* Group header */}
            <div className="text-center">
              <h2 className="text-lg font-bold">{g.group_name}</h2>
              <p className="text-xs text-muted-foreground">
                {g.tier_name ? `${g.tier_name} · ` : ""}👨‍🏫 {g.teacher_name}
              </p>
            </div>

            {/* Stats strip */}
            <div className="grid grid-cols-4 gap-2">
              <StatChip label="Faol" value={`${g.stats.active_students}/${g.stats.total_students}`} />
              <StatChip label="Tugallanish" value={`${g.stats.avg_completion_pct}%`} />
              <StatChip label="Nishon" value={g.stats.badges_earned} />
              <StatChip label="Kutilmoqda" value={g.stats.pending_homework} />
            </div>

            {/* The two boards — weekly first (the fresh race) */}
            <BoardCard title="🔥 SHU HAFTA" icon={<Flame className="h-4 w-4" />} accent="hsl(20 90% 50%)" rows={g.weekly} unit="XP" />
            <BoardCard title="🏆 UMUMIY TOP" icon={<Trophy className="h-4 w-4" />} accent="hsl(var(--primary))" rows={g.alltime} unit="XP" />

            <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground pt-1">
              <Camera className="h-3.5 w-3.5" /> Skrinshot qiling va guruhga ulashing
            </div>
            <div className="flex items-center justify-center gap-1 text-[11px] text-muted-foreground/70">
              <UsersIcon className="h-3 w-3" /> aicreator.academy
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
