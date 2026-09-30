// Telegram Mini App: the daily group board. Opened from the digest DM's "📊 Guruh reytingi" web_app
// button — runs INSIDE Telegram with no Supabase session. It reads Telegram's signed initData and
// sends it to the tg-group-board edge function, which validates it and checks admin/teacher role.
// Built to be screenshotted and dropped into the group chat: big medals, clean cards, branded header.
//
// i18n: every visible string comes from `miniapp.groupBoard.*` (uz/ru/en). This page has no session,
// so tg-group-board returns the CALLER's own language (profile preferred_language, else the bot's
// preferred_locale, else Uzbek) and the page switches to it once loaded — NOT the phone's language,
// which would turn the board Russian/English for most staff and for the screenshots they post into
// Uzbek groups (all 9 staff on Telegram chose Uzbek, 2026-09-27). The Uzbek strings are byte-identical to the original
// hard-coded ones (src/test/TgGroupBoard.test.tsx pins them); "XP" and the brand line are not
// translated on purpose.
import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, Trophy, Flame, Users as UsersIcon, Camera } from "lucide-react";
import { displayRank } from "@/lib/studentStats";

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
  lang?: string; // the caller's own saved language (uz/ru/en), resolved server-side
  courses?: Course[];
  course_id?: string;
  groups: GroupBoard[];
}

// No medal and no rank for 0 points: this board is screenshotted into the groups, and a Challenge 6.0 group
// on day 1 would otherwise show 🥇🥈🥉 next to "0 XP" (the order among zeros is only streak + id).
const medal = (r: number, xp: number) => {
  const shown = displayRank(r, xp);
  return shown == null ? "—" : shown === 1 ? "🥇" : shown === 2 ? "🥈" : shown === 3 ? "🥉" : `${shown}`;
};
const fullName = (r: BoardRow) => `${r.first_name}${r.last_initial ? " " + r.last_initial + "." : ""}`;
// Date in the UI language; Uzbek keeps the exact "uz-UZ" formatting the board always used.
const DATE_LOCALE: Record<string, string> = { uz: "uz-UZ", ru: "ru-RU", en: "en-US" };
const todayTashkent = (lng: string) =>
  new Date().toLocaleDateString(DATE_LOCALE[lng] ?? "uz-UZ", { timeZone: "Asia/Tashkent", day: "numeric", month: "long", year: "numeric" });

function BoardCard({ title, icon, accent, rows, unit }: {
  title: string; icon: React.ReactNode; accent: string; rows: BoardRow[]; unit: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-2xl border border-border bg-card shadow-soft overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border" style={{ background: accent }}>
        <span className="text-white">{icon}</span>
        <h3 className="text-sm font-bold text-white tracking-wide">{title}</h3>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-muted-foreground">{t("miniapp.groupBoard.empty")}</div>
      ) : (
        <ol className="divide-y divide-border/60">
          {rows.map((r) => (
            <li key={`${r.board}-${r.rank}`} className="flex items-center gap-3 px-4 py-2.5">
              <span className={`w-7 text-center text-base ${r.rank <= 3 && r.xp > 0 ? "" : "text-muted-foreground text-sm font-medium"}`}>
                {medal(r.rank, r.xp)}
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
  const { t, i18n } = useTranslation();
  const lng = (i18n.resolvedLanguage || i18n.language || "uz").slice(0, 2);
  const [initData, setInitData] = useState<string | null | undefined>(undefined); // undefined=loading, null=not in TG
  const [res, setRes] = useState<LoadResult | null>(null);
  const [loading, setLoading] = useState(false);
  // A flag, not a message: the text is rendered via t() so it follows a language change.
  const [err, setErr] = useState(false);
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
    setLoading(true); setErr(false);
    const { data, error } = await supabase.functions.invoke("tg-group-board", {
      body: { initData, ...(cid ? { course_id: cid } : {}) },
    });
    setLoading(false);
    if (error) { setErr(true); return; }
    const r = data as LoadResult;
    if (r.lang && ["uz", "ru", "en"].includes(r.lang) && r.lang !== lng) void i18n.changeLanguage(r.lang);
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
        <Trans i18nKey="miniapp.groupBoard.openInTelegram" components={{ b: <b /> }} />
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
          <h1 className="text-xl font-semibold">{t("miniapp.groupBoard.title")}</h1>
          <span className="ml-auto text-xs text-muted-foreground">{todayTashkent(lng)}</span>
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
            <p className="text-sm text-muted-foreground">{t("miniapp.groupBoard.loadError")}</p>
            <button onClick={() => load(courseId || undefined)} className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted">{t("miniapp.retry")}</button>
          </div>
        )}
        {!loading && !err && groups.length === 0 && (
          <div className="py-10 text-center text-sm text-muted-foreground">{t("miniapp.groupBoard.noGroups")}</div>
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
              <StatChip label={t("miniapp.groupBoard.statActive")} value={`${g.stats.active_students}/${g.stats.total_students}`} />
              <StatChip label={t("miniapp.groupBoard.statCompletion")} value={`${g.stats.avg_completion_pct}%`} />
              <StatChip label={t("miniapp.groupBoard.statBadges")} value={g.stats.badges_earned} />
              <StatChip label={t("miniapp.groupBoard.statPending")} value={g.stats.pending_homework} />
            </div>

            {/* The two boards — weekly first (the fresh race) */}
            <BoardCard title={t("miniapp.groupBoard.weekly")} icon={<Flame className="h-4 w-4" />} accent="hsl(20 90% 50%)" rows={g.weekly} unit="XP" />
            <BoardCard title={t("miniapp.groupBoard.allTime")} icon={<Trophy className="h-4 w-4" />} accent="hsl(var(--primary))" rows={g.alltime} unit="XP" />

            <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground pt-1">
              <Camera className="h-3.5 w-3.5" /> {t("miniapp.groupBoard.shareHint")}
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
