// tg-group-board: Telegram MINI APP entry point for the daily group board. Opened from the digest
// DM's "📊 Guruh reytingi" web_app button — runs INSIDE Telegram with no Supabase session. Telegram
// hands it a signed initData string; we validate the HMAC-SHA256 signature with the bot token
// (Telegram's standard, same as tg-broadcast), map telegram_id → profile → role, then return a
// screenshot-ready view: per-group stats + two student leaderboards (all-time + this-week).
//
// Auth model (asymmetric, on purpose):
//   * admin / superadmin → any course; a course picker is returned.
//   * teacher            → ONLY the groups they own (groups.teacher_id = their profile id).
//   * anyone else        → 403.
// Read-only: no writes, no XP awards. Top-N only — never a "bottom" list.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function ctEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Validate Telegram Mini App initData. secret = HMAC_SHA256(key="WebAppData", msg=bot_token);
// hash = HMAC_SHA256(key=secret, msg=data_check_string). Enforce a 1h freshness window.
async function validateInitData(initData: string): Promise<{ ok: boolean; userId?: number }> {
  if (!initData || !BOT_TOKEN) return { ok: false };
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false };
  params.delete("hash"); // ONLY hash; `signature` (Telegram's Ed25519 field) STAYS in the bot-token HMAC dcs.
  const dcs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("\n");
  const enc = new TextEncoder();
  const wk = await crypto.subtle.importKey("raw", enc.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secret = new Uint8Array(await crypto.subtle.sign("HMAC", wk, enc.encode(BOT_TOKEN)));
  const sk = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", sk, enc.encode(dcs)));
  const hex = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  if (!ctEq(hex, hash)) return { ok: false };
  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > 3600) return { ok: false };
  try {
    const user = JSON.parse(params.get("user") || "{}");
    return { ok: true, userId: Number(user?.id) || undefined };
  } catch {
    return { ok: false };
  }
}

type BoardRow = { board: string; rank: number; first_name: string; last_initial: string; xp: number; level: number; current_streak: number };

// Assemble stats + both leaderboards for a set of {id, course_id} groups.
// deno-lint-ignore no-explicit-any
async function buildGroups(admin: any, groups: { id: string; course_id: string | null }[], windowDays: number) {
  const byCourse = new Map<string, string[]>();
  for (const g of groups) {
    if (!g.course_id) continue;
    const arr = byCourse.get(g.course_id) || [];
    arr.push(g.id);
    byCourse.set(g.course_id, arr);
  }
  // On RPC error, don't silently return an empty board — record a DB-visible signal (health rule).
  const logErr = (where: string, error: any) =>
    admin.from("admin_actions").insert({ actor_user_id: null, action: "group_board_rpc_error", details: { where, error: String(error?.message || error) } }).then(() => {}, () => {});
  // One stats call per distinct course (returns every group of that course); index by group_id.
  const statsById = new Map<string, any>();
  for (const cid of byCourse.keys()) {
    const { data, error } = await admin.rpc("admin_course_group_stats", { _course_id: cid, _window_days: windowDays });
    if (error) await logErr(`admin_course_group_stats:${cid}`, error);
    for (const r of ((data || []) as any[])) statsById.set(r.group_id, r);
  }
  const out: any[] = [];
  for (const g of groups) {
    const st = statsById.get(g.id);
    if (!st) continue; // group has no course or no stats row
    const { data: board, error: bErr } = await admin.rpc("group_student_leaderboard", { _group_id: g.id, _limit: 10 });
    if (bErr) await logErr(`group_student_leaderboard:${g.id}`, bErr);
    const rows = (board || []) as BoardRow[];
    out.push({
      group_id: g.id,
      group_name: st.group_name,
      tier_name: st.tier_name,
      teacher_name: st.teacher_name,
      stats: {
        total_students: st.total_students, active_students: st.active_students,
        activated_count: st.activated_count, badges_earned: st.badges_earned,
        students_with_badges: st.students_with_badges, avg_completion_pct: st.avg_completion_pct,
        accessible_lessons: st.accessible_lessons, total_xp: st.total_xp, avg_xp: st.avg_xp,
        homework_submitted: st.homework_submitted, homework_avg_score: st.homework_avg_score,
        pending_homework: st.pending_homework,
      },
      alltime: rows.filter((r) => r.board === "alltime").sort((a, b) => a.rank - b.rank),
      weekly: rows.filter((r) => r.board === "weekly").sort((a, b) => a.rank - b.rank),
    });
  }
  // Stable, most-active-first order (matches the web dashboard's default ranking).
  out.sort((a, b) => {
    const pa = a.stats.total_students > 0 ? a.stats.active_students / a.stats.total_students : 0;
    const pb = b.stats.total_students > 0 ? b.stats.active_students / b.stats.total_students : 0;
    return pb - pa;
  });
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const body = await req.json().catch(() => ({}));
  const { ok, userId } = await validateInitData(String(body?.initData || ""));
  if (!ok || !userId) return json({ error: "unauthorized" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: prof } = await admin.from("profiles").select("id").eq("telegram_id", userId).maybeSingle();
  if (!prof?.id) return json({ error: "forbidden" }, 403);
  const { data: roleRows } = await admin.from("user_roles").select("role")
    .eq("user_id", prof.id).in("role", ["admin", "superadmin", "teacher"]);
  const roles = new Set(((roleRows || []) as any[]).map((r) => r.role));
  const isAdmin = roles.has("admin") || roles.has("superadmin");
  const isTeacher = roles.has("teacher");
  if (!isAdmin && !isTeacher) return json({ error: "forbidden" }, 403);

  const windowDays = Math.min(Math.max(Number(body?.window_days) || 7, 1), 90);

  if (isAdmin) {
    // Courses that actually have groups, for the picker.
    const { data: grpCourses } = await admin.from("groups").select("course_id").not("course_id", "is", null);
    const courseIds = [...new Set(((grpCourses || []) as any[]).map((g) => g.course_id))];
    const { data: courseRows } = courseIds.length
      ? await admin.from("courses").select("id, title").in("id", courseIds)
      : { data: [] as any[] };
    const courses = ((courseRows || []) as any[]).map((c) => ({ id: c.id, title: c.title }));
    const courseId = String(body?.course_id || "") || (courses[0]?.id || "");
    if (!courseId) return json({ role: "admin", courses, course_id: "", groups: [], window_days: windowDays });
    const { data: grps } = await admin.from("groups").select("id, course_id").eq("course_id", courseId);
    const groups = await buildGroups(admin, ((grps || []) as any[]), windowDays);
    return json({ role: "admin", courses, course_id: courseId, groups, window_days: windowDays });
  }

  // Teacher: only their own groups.
  const { data: grps } = await admin.from("groups").select("id, course_id").eq("teacher_id", prof.id);
  const groups = await buildGroups(admin, ((grps || []) as any[]), windowDays);
  return json({ role: "teacher", groups, window_days: windowDays });
});
