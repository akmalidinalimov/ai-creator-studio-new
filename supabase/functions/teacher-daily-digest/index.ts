// Daily teacher digest (21:00 Asia/Tashkent via pg_cron). Sends each teacher an end-of-day report so
// they can reflect: active time in the channel, questions answered today + median response time,
// questions/homework still waiting, homework graded, and their weekly standing (🥇🥈🥉). Every metric
// is an honest proxy (see teacher_daily_report()). A short line tells the teacher the same stats go to
// admins (accountability). After the teacher loop, admins get one aggregate summary.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { sendTelegram } from "../_shared/telegram-send.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
};
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const SITE_URL = Deno.env.get("SITE_URL") || "https://aicreator.academy";

const __admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
// Rotation-safe internal-secret check (re-fetch once on mismatch, debounced) — matches the fix for
// the stale-cached-secret 403 class.
let __sec: string | null = null;
let __lastFetch = 0;
async function __internalSecret(force = false): Promise<string> {
  const now = Date.now();
  if (__sec && (!force || now - __lastFetch < 15_000)) return __sec;
  __lastFetch = now;
  const { data, error } = await __admin.rpc("internal_fn_secret");
  if (error) throw error;
  __sec = data as string;
  return __sec;
}

function randomToken(len = 32): string {
  const b = new Uint8Array(len / 2);
  crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

// parse_mode=HTML: escape user-controlled names (Telegram first_names can contain < > &, which would
// otherwise break the whole sendMessage — critical for the single admin-aggregate message).
function escHtml(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type Loc = "uz" | "ru" | "en";
const U = { soat: { uz: "soat", ru: "ч", en: "h" }, daq: { uz: "daq", ru: "мин", en: "min" } };
function fmtDur(min: number, loc: Loc): string {
  const h = Math.floor(min / 60), m = min % 60;
  return h > 0 ? `${h} ${U.soat[loc]} ${m} ${U.daq[loc]}` : `${m} ${U.daq[loc]}`;
}
const medal = (r?: number) => (r === 1 ? "🥇" : r === 2 ? "🥈" : r === 3 ? "🥉" : r ? `#${r}` : "—");

// --- Daily group board (per-group student leaderboards appended to the digest) ---
type BoardRow = { board: "alltime" | "weekly"; rank: number; first_name: string; last_initial: string; xp: number; level: number; current_streak: number };
type Btn = { text: string; url?: string; web_app?: { url: string } };
const nm = (r: BoardRow) => `${r.first_name}${r.last_initial ? " " + r.last_initial + "." : ""}`;
const actPct = (s: { active_students: number; total_students: number }) =>
  (s.total_students > 0 ? Math.round((s.active_students / s.total_students) * 100) : 0);
type GroupCard = { name: string; stats: any; weekly: BoardRow[]; alltime: BoardRow[] };
const BL: Record<Loc, { groups: string; week: string; all: string; noWeek: string; faol: string; tug: string; nishon: string; kut: string; btn: string; moreGroups: string }> = {
  uz: { groups: "📊 <b>Guruh reytingi</b>", week: "🔥 Shu hafta", all: "🏆 Umumiy", noWeek: "🔥 Shu hafta: hali XP yig'ilmagan", faol: "faol", tug: "tugallanish", nishon: "nishon", kut: "kutilmoqda", btn: "📊 Guruh reytingi", moreGroups: "guruh — ilovada to'liq" },
  ru: { groups: "📊 <b>Рейтинг группы</b>", week: "🔥 Эта неделя", all: "🏆 Общий", noWeek: "🔥 Эта неделя: пока нет XP", faol: "активны", tug: "прогресс", nishon: "наград", kut: "на проверке", btn: "📊 Рейтинг группы", moreGroups: "групп — полностью в приложении" },
  en: { groups: "📊 <b>Group board</b>", week: "🔥 This week", all: "🏆 All-time", noWeek: "🔥 This week: no XP yet", faol: "active", tug: "completion", nishon: "badges", kut: "pending", btn: "📊 Group board", moreGroups: "more groups — full board in the app" },
};
// One group's block: compact stats line + weekly top-5 (+XP earned this week) + all-time top-5.
function boardBlock(groupName: string, s: any, weekly: BoardRow[], alltime: BoardRow[], loc: Loc): string {
  const b = BL[loc];
  const lines = [
    `📊 <b>${escHtml(groupName)}</b>`,
    `${s.active_students} ${b.faol} (${actPct(s)}%) · ${b.tug} ${s.avg_completion_pct}% · ${s.badges_earned} ${b.nishon} · ${s.pending_homework} ${b.kut}`,
  ];
  if (weekly.length) {
    lines.push(b.week + ":");
    for (const r of weekly.slice(0, 5)) lines.push(`${medal(r.rank)} ${escHtml(nm(r))} +${r.xp} XP`);
  } else {
    lines.push(b.noWeek);
  }
  if (alltime.length) {
    lines.push(b.all + ":");
    for (const r of alltime.slice(0, 5)) lines.push(`${medal(r.rank)} ${escHtml(nm(r))} ${r.xp} XP`);
  }
  return lines.join("\n");
}
// The board as its OWN message (capped to 3 groups in text — the rest live in the Mini App), so a
// board/length fault can never suppress the core teacher report it follows.
function boardMessage(cards: GroupCard[], loc: Loc): string {
  const b = BL[loc];
  const shown = cards.slice(0, 3);
  const out = [b.groups];
  for (const c of shown) out.push("", boardBlock(c.name, c.stats, c.weekly, c.alltime, loc));
  if (cards.length > shown.length) out.push("", `… +${cards.length - shown.length} ${b.moreGroups}`);
  return out.join("\n");
}
const BOARD_URL = `${SITE_URL}/tg/group-board`;

// record=false for send-classes that write their OWN *_failed admin_actions row below (so a failure
// isn't double-logged); record=true (default) for the board sends, whose only failure signal is
// sendTelegram's classified telegram_send_failed row.
async function sendTg(chatId: number, text: string, buttons?: Btn[][], purpose = "teacher_daily_digest", record = true): Promise<boolean> {
  const out = await sendTelegram(BOT_TOKEN, "sendMessage", {
    chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true,
    ...(buttons && buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
  }, { admin: __admin, purpose, recipientId: chatId, record });
  return out.ok;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const __p = req.headers.get("x-internal-secret");
  let __s = await __internalSecret();
  if (!__p || __p !== __s) __s = await __internalSecret(true);
  if (!__p || __p !== __s) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const admin = __admin;

  // Same-day dedup: the cron fires once, but a manual re-invoke must not re-DM everyone.
  const _since = new Date(Date.now() - 20 * 3600_000).toISOString();
  const { data: _prior } = await admin.from("admin_actions").select("id")
    .eq("action", "teacher_daily_report_run").gte("created_at", _since).limit(1);
  if (_prior && (_prior as any[]).length) {
    return new Response(JSON.stringify({ ok: true, skipped: "already_ran_today" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // 1) All teachers' daily stats (one row per teacher) + the weekly ranking board.
  const { data: reportData, error: repErr } = await admin.rpc("teacher_daily_report");
  if (repErr) {
    await admin.from("admin_actions").insert({ actor_user_id: null, action: "teacher_daily_report_error", details: { error: repErr.message } }).then(() => {}, () => {});
    return new Response(JSON.stringify({ ok: false, error: repErr.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const rows = ((reportData || []) as any[]);
  const rankMap: Record<string, number> = {};
  if (rows.length) {
    try {
      const { data: board } = await admin.rpc("teacher_leaderboard", { uid: rows[0].teacher_id, _limit: 100 });
      for (const b of ((board || []) as any[])) rankMap[b.teacher_id] = b.rank;
    } catch { /* leaderboard optional — show "—" if absent */ }
  }
  // profile locales for per-teacher language
  const locById: Record<string, Loc> = {};
  const { data: profs } = rows.length
    ? await admin.from("profiles").select("id, preferred_locale").in("id", rows.map((r) => r.teacher_id))
    : { data: [] as any[] };
  for (const p of ((profs || []) as any[])) {
    locById[p.id] = (["uz", "ru", "en"].includes(p.preferred_locale) ? p.preferred_locale : "uz") as Loc;
  }

  // --- Group board data (kill-switch: platform_settings.group_board.digest_enabled). If the row is
  // absent the migration hasn't applied yet (RPCs may not exist) → board stays off, digest unchanged.
  let boardEnabled = false;
  const boardByTeacher: Record<string, { name: string; stats: any; weekly: BoardRow[]; alltime: BoardRow[] }[]> = {};
  const allGroupCards: { name: string; stats: any; weekly: BoardRow[]; alltime: BoardRow[] }[] = [];
  try {
    const { data: gbFlag } = await admin.from("platform_settings").select("value").eq("key", "group_board").maybeSingle();
    boardEnabled = !!gbFlag && (gbFlag.value as any)?.digest_enabled !== false;
  } catch { /* board optional */ }
  if (boardEnabled) {
    try {
      const { data: grpRows } = await admin.from("groups").select("id, name, course_id, teacher_id").not("teacher_id", "is", null);
      const groups = ((grpRows || []) as any[]);
      const courseIds = [...new Set(groups.map((g) => g.course_id).filter(Boolean))];
      const statsById: Record<string, any> = {};
      for (const cid of courseIds) {
        const { data } = await admin.rpc("admin_course_group_stats", { _course_id: cid, _window_days: 7 });
        for (const r of ((data || []) as any[])) statsById[r.group_id] = r;
      }
      for (const g of groups) {
        const st = statsById[g.id];
        if (!st) continue; // group has no course / no stats row
        const { data: bd } = await admin.rpc("group_student_leaderboard", { _group_id: g.id, _limit: 10 });
        const brows = ((bd || []) as BoardRow[]);
        const card = {
          name: g.name, stats: st,
          weekly: brows.filter((r) => r.board === "weekly").sort((a, b) => a.rank - b.rank),
          alltime: brows.filter((r) => r.board === "alltime").sort((a, b) => a.rank - b.rank),
        };
        allGroupCards.push(card);
        (boardByTeacher[g.teacher_id] ||= []).push(card);
      }
    } catch (e) {
      boardEnabled = false;
      await admin.from("admin_actions").insert({ actor_user_id: null, action: "group_board_build_error", details: { error: String(e) } }).then(() => {}, () => {});
    }
  }

  const T: Record<Loc, any> = {
    uz: {
      title: (n: string) => `📊 <b>Bugungi hisobot</b> — ${n}`,
      active: (d: string) => `⏱ Kanalda faollik: <b>${d}</b>`,
      answered: (n: number) => `💬 Bugun javob berilgan savollar: <b>${n}</b>`,
      wait: (m: number) => `⏲ O'rtacha javob vaqti: <b>${m} daq</b>`,
      open: (n: number) => `❓ Javobsiz savollar: <b>${n}</b>`,
      backlog: (n: number, o: string) => `📥 Baholanmagan vazifalar: <b>${n}</b>${o}`,
      oldest: (h: number) => ` (eng eskisi ${h} soat)`,
      graded: (n: number, a: string) => `✍️ Bugun baholadingiz: <b>${n}</b>${a}`,
      avg: (p: number) => ` · o'rtacha ${p}%`,
      rank: (mm: string, r: number) => `🏅 Haftalik reyting: <b>${mm} ${r}-o'rin</b>`,
      idle: "😴 Bugun kanalda faollik qayd etilmadi. Ertaga ko'rishamiz!",
      footer: "📩 Bu statistika administratorga ham yuboriladi — birga o'samiz! 💪",
    },
    ru: {
      title: (n: string) => `📊 <b>Отчёт за сегодня</b> — ${n}`,
      active: (d: string) => `⏱ Активность в канале: <b>${d}</b>`,
      answered: (n: number) => `💬 Отвечено на вопросы сегодня: <b>${n}</b>`,
      wait: (m: number) => `⏲ Среднее время ответа: <b>${m} мин</b>`,
      open: (n: number) => `❓ Без ответа: <b>${n}</b>`,
      backlog: (n: number, o: string) => `📥 Непроверенные задания: <b>${n}</b>${o}`,
      oldest: (h: number) => ` (старейшее ${h} ч)`,
      graded: (n: number, a: string) => `✍️ Проверили сегодня: <b>${n}</b>${a}`,
      avg: (p: number) => ` · в среднем ${p}%`,
      rank: (mm: string, r: number) => `🏅 Недельный рейтинг: <b>${mm} ${r} место</b>`,
      idle: "😴 Сегодня активность в канале не зафиксирована. До завтра!",
      footer: "📩 Эта статистика также отправлена администратору — растём вместе! 💪",
    },
    en: {
      title: (n: string) => `📊 <b>Today's report</b> — ${n}`,
      active: (d: string) => `⏱ Active in the channel: <b>${d}</b>`,
      answered: (n: number) => `💬 Questions answered today: <b>${n}</b>`,
      wait: (m: number) => `⏲ Median response time: <b>${m} min</b>`,
      open: (n: number) => `❓ Unanswered questions: <b>${n}</b>`,
      backlog: (n: number, o: string) => `📥 Ungraded homework: <b>${n}</b>${o}`,
      oldest: (h: number) => ` (oldest ${h}h)`,
      graded: (n: number, a: string) => `✍️ Graded today: <b>${n}</b>${a}`,
      avg: (p: number) => ` · avg ${p}%`,
      rank: (mm: string, r: number) => `🏅 Weekly rank: <b>${mm} #${r}</b>`,
      idle: "😴 No channel activity logged today. See you tomorrow!",
      footer: "📩 These stats are also sent to your admins — let's grow together! 💪",
    },
  };

  let sent = 0, failed = 0, boardSent = 0, boardFailed = 0;
  for (const t of rows) {
    if (!t.telegram_id) continue;
    try {
    const loc = locById[t.teacher_id] || "uz";
    const l = T[loc];
    const lines: string[] = [l.title(escHtml(t.name || "")), ""];
    const active = Number(t.active_minutes || 0);
    lines.push(l.active(fmtDur(active, loc)));
    if (active === 0 && Number(t.answered_today || 0) === 0 && Number(t.graded_today || 0) === 0) {
      lines.push(l.idle);
    }
    lines.push(l.answered(Number(t.answered_today || 0)));
    if (t.median_wait_min != null) lines.push(l.wait(Number(t.median_wait_min)));
    lines.push(l.open(Number(t.open_questions || 0)));
    lines.push(l.backlog(Number(t.ungraded_backlog || 0),
      t.ungraded_backlog > 0 && t.oldest_pending_hours != null ? l.oldest(Number(t.oldest_pending_hours)) : ""));
    if (Number(t.graded_today || 0) > 0) {
      lines.push(l.graded(Number(t.graded_today), t.avg_score_pct != null ? l.avg(Number(t.avg_score_pct)) : ""));
    }
    const rk = rankMap[t.teacher_id];
    if (rk) lines.push("", l.rank(medal(rk), rk));
    lines.push("", l.footer);

    // magic link into the teacher's profile
    const token = randomToken(32);
    await admin.from("telegram_magic_links").insert({
      token, user_id: t.teacher_id, purpose: "login", target_path: "/profile",
      expires_at: new Date(Date.now() + 2 * 86400_000).toISOString(),
    }).then(() => {}, () => {});
    const url = `${SITE_URL}/auth/magic?t=${token}`;

    // Core report + Profil (url) button only — never at risk from the board's web_app button/length.
    const ok = await sendTg(Number(t.telegram_id), lines.join("\n"), [[{ text: "👤 Profil / Profile", url }]], "teacher_daily_report", false);
    if (ok) {
      sent++;
      await admin.from("notifications_log").insert({
        user_id: t.teacher_id, notification_type: "teacher_daily_report",
        payload: { active_minutes: active, answered_today: t.answered_today, open_questions: t.open_questions, ungraded_backlog: t.ungraded_backlog, graded_today: t.graded_today, rank: rk ?? null },
        sent_at: new Date().toISOString(),
      }).then(() => {}, () => {});
    } else {
      failed++;
      await admin.from("admin_actions").insert({
        actor_user_id: null, action: "teacher_daily_report_failed",
        details: { teacher_id: t.teacher_id, telegram_id: t.telegram_id },
      }).then(() => {}, () => {});
    }

    // The group board is a SEPARATE message (copy-paste-ready for the group) with the Mini App
    // button — isolated so a board fault can't suppress the core report sent above.
    const cards = boardEnabled ? (boardByTeacher[t.teacher_id] || []) : [];
    if (cards.length) {
      try {
        const bok = await sendTg(Number(t.telegram_id), boardMessage(cards, loc), [[{ text: BL[loc].btn, web_app: { url: BOARD_URL } }]], "teacher_daily_board");
        if (bok) boardSent++; else boardFailed++;
      } catch { boardFailed++; } // board accounting stays independent of the core report's sent/failed
    }
    } catch (e) {
      failed++;
      await admin.from("admin_actions").insert({ actor_user_id: null, action: "teacher_daily_report_failed",
        details: { teacher_id: t.teacher_id, error: String(e) } }).then(() => {}, () => {});
    }
  }

  // 2) Aggregate summary to admins (accountability copy). Sorted by rank, podium first.
  const sortedForAdmin = [...rows].sort((a, b) => (rankMap[a.teacher_id] || 999) - (rankMap[b.teacher_id] || 999));
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tashkent" });
  const adminLines = [`👨‍🏫 <b>Ustozlar kunlik hisoboti</b> — ${today}`, ""];
  for (const t of sortedForAdmin) {
    const rk = rankMap[t.teacher_id];
    adminLines.push(
      `${medal(rk)} <b>${escHtml(t.name || "?")}</b> — ${fmtDur(Number(t.active_minutes || 0), "uz")} · ` +
      `${t.answered_today || 0} javob · ${t.open_questions || 0} javobsiz · ${t.ungraded_backlog || 0} baholanmagan` +
      (Number(t.graded_today || 0) > 0 ? ` · ${t.graded_today} baho` : ""));
  }
  adminLines.push("", `📤 ${sent} ustozga yuborildi${failed ? ` · ${failed} xato` : ""}.`);

  // Separate admin board message (groups roll-up, most-active-first) + Mini App button — isolated
  // from the core roll-up above, same reasoning as the teacher board.
  let adminBoardMsg = "";
  if (boardEnabled && allGroupCards.length) {
    const sortedGroups = [...allGroupCards].sort((a, b) => actPct(b.stats) - actPct(a.stats));
    const gl = ["📊 <b>Guruhlar</b> (faollik bo'yicha):"];
    for (const c of sortedGroups.slice(0, 25)) {
      const top = c.weekly[0] || c.alltime[0];
      gl.push(
        `• <b>${escHtml(c.name)}</b>: ${c.stats.active_students}/${c.stats.total_students} faol (${actPct(c.stats)}%)` +
        (top ? ` · 🔥 ${escHtml(nm(top))}` : ""));
    }
    adminBoardMsg = gl.join("\n");
  }

  const { data: adminRoles } = await admin.from("user_roles").select("user_id").in("role", ["admin", "superadmin"]);
  const adminIds = ((adminRoles || []) as any[]).map((r) => r.user_id);
  let adminSent = 0;
  if (adminIds.length) {
    const { data: admins } = await admin.from("profiles").select("id, telegram_id").in("id", adminIds).not("telegram_id", "is", null);
    const seen = new Set<number>();
    const adminBoardBtn: Btn[][] = [[{ text: "📊 Guruh reytingi", web_app: { url: BOARD_URL } }]];
    for (const a of ((admins || []) as any[])) {
      const cid = Number(a.telegram_id);
      if (seen.has(cid)) continue;
      seen.add(cid);
      if (await sendTg(cid, adminLines.join("\n"), undefined, "teacher_daily_admin_summary", false)) adminSent++;
      else await admin.from("admin_actions").insert({ actor_user_id: null, action: "teacher_daily_admin_send_failed", details: { telegram_id: cid } }).then(() => {}, () => {});
      if (adminBoardMsg) { if (await sendTg(cid, adminBoardMsg, adminBoardBtn, "teacher_daily_admin_board")) boardSent++; else boardFailed++; }
    }
  }

  await admin.from("admin_actions").insert({
    actor_user_id: null, action: "teacher_daily_report_run",
    details: { teachers: rows.length, sent, failed, admin_sent: adminSent, board_enabled: boardEnabled, groups: allGroupCards.length, board_sent: boardSent, board_failed: boardFailed, at: new Date().toISOString() },
  }).then(() => {}, () => {});

  return new Response(JSON.stringify({ ok: true, teachers: rows.length, sent, failed, admin_sent: adminSent, board_sent: boardSent, board_failed: boardFailed }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
