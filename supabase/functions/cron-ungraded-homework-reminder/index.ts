// Hourly job: when a homework submission has been ungraded for 24h+, DM every reachable teacher of the
// student's group — the primary AND the co-teachers (_shared/group-teachers.ts). Up to 3 reminders per
// submission, 24h apart. Submissions with no reachable teacher go to the admins as ONE message per run
// (routing + copy in route.ts). Mirrors notify-homework-submission for auth + Telegram send pattern.
//
// 2026-09-30: with platform_settings.teacher_miniapp on, 🎯 opens THIS submission in the teacher Mini App
// (web_app → /tg/teacher/grade?sub=<id>, _shared/teacher-miniapp.ts); the in-chat flow and the web page stay as
// the second row. Off → today's keyboard, byte-identical. A web_app button Telegram rejects is resent once with
// today's keyboard (recorded as teacher_miniapp_button_rejected — never the student watch-button alarm's
// miniapp_button_rejected). The audit row's details.buttons counts both kinds.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { verifyInternalSecret } from "../_shared/internal-secret.ts";
import { sendTelegram } from "../_shared/telegram-send.ts";
import { logHealth } from "../_shared/edge.ts";
import { sendWithWatchFallback } from "../_shared/miniapp-button.ts";
import {
  GRADE_APP_LABEL,
  GRADE_CHAT_LABEL,
  loadTeacherMiniAppFlag,
  teacherAppButton,
  teacherGradePath,
} from "../_shared/teacher-miniapp.ts";
import { loadGroupTeachers } from "../_shared/group-teachers.ts";
import { loadAssignmentLabels, loadGroupNames } from "../_shared/hw-label-load.ts";
import {
  type AdminItem,
  adminDigestText,
  itemLabel,
  type Locale,
  normLocale,
  routeReminder,
  teacherReminderKeyboard,
  teacherReminderText,
  type TeacherProfile,
} from "./route.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";

const __admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

function tashkentHour(): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tashkent", hour12: false, hour: "2-digit" });
    let h = parseInt(fmt.format(new Date()).slice(0, 2), 10);
    if (h === 24) h = 0;
    return h;
  } catch {
    return new Date().getUTCHours() + 5;
  }
}

const ADMIN_BTN: Record<Locale, string> = { uz: "🎯 Ko'rib chiqish", ru: "🎯 Проверить", en: "🎯 Review" };
const ADMIN_URL = "https://aicreator.academy/admin/homework";

function fullName(p: any): string {
  const a = (p?.name || "").trim();
  const b = (p?.last_name || "").trim();
  return [a, b].filter(Boolean).join(" ") || "—";
}

const JSON_HEADERS = { ...corsHeaders, "Content-Type": "application/json" };
const fail = (error: string) => new Response(JSON.stringify({ ok: false, error }), { status: 500, headers: JSON_HEADERS });

type Sub = { id: string; user_id: string; assignment_id: string; submitted_at: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (!(await verifyInternalSecret(req, __admin))) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: JSON_HEADERS });
  }
  if (!BOT_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: "bot not configured" }), { headers: JSON_HEADERS });
  }
  const admin = __admin;

  // QUIET HOURS: skip whole run between 22:00 and 08:00 Tashkent
  const hr = tashkentHour();
  if (hr < 8 || hr >= 22) {
    return new Response(JSON.stringify({ ok: true, skipped: "quiet_hours", hour: hr }), { headers: JSON_HEADERS });
  }

  // Candidate query — the RPC does the anti-join in SQL (excludes rows already
  // at 3 reminders in their current cycle, or reminded in the last 24h) BEFORE
  // the limit, so exhausted old rows can't starve newer ungraded homework.
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: subs, error: subsErr } = await admin
    .rpc("ungraded_reminder_candidates", { p_cutoff: cutoff, p_limit: 200 });
  if (subsErr) return fail(subsErr.message);
  const eligible: Sub[] = ((subs || []) as any[]).map((s) => ({
    id: s.id, user_id: s.user_id, assignment_id: s.assignment_id, submitted_at: s.submitted_at,
  }));

  if (!eligible.length) {
    return new Response(JSON.stringify({ ok: true, processed: 0 }), { headers: JSON_HEADERS });
  }

  // Bulk load related rows. The reads that decide WHO is reminded fail the run (retried next hour)
  // instead of reading as "no rows": a masked failure would route every candidate to the wrong people.
  const studentIds = Array.from(new Set(eligible.map((s) => s.user_id)));
  const assignmentIds = Array.from(new Set(eligible.map((s) => s.assignment_id)));
  // Label reads (task → module → course; the student's group name) never fail the run: a failed read only
  // shortens the label, and is recorded once a day as hw_label_lookup_failed.
  const [{ data: students, error: studentsErr }, labels] = await Promise.all([
    admin.from("profiles").select("id, name, last_name, group_id, preferred_locale").in("id", studentIds),
    loadAssignmentLabels(admin, assignmentIds, "cron-ungraded-homework-reminder"),
  ]);
  if (studentsErr) return fail(`students read failed: ${studentsErr.message}`);
  const studentMap = new Map<string, any>((students || []).map((p: any) => [p.id, p]));
  const groupNames = (await loadGroupNames(admin, (students || []).map((p: any) => p.group_id), "cron-ungraded-homework-reminder")).map;

  // Teachers of each group = primary ∪ co-teachers — the same set both teacher-DM enqueue paths use.
  // Reading only groups.teacher_id sent a co-teacher nothing, and sent a group whose teachers are all
  // co-teachers to the admins as if it had no teacher.
  let teachersOf: Map<string, string[]>;
  try {
    teachersOf = await loadGroupTeachers(admin, (students || []).map((p: any) => p.group_id));
  } catch (e) {
    return fail(String((e as Error)?.message || e));
  }
  const teacherIds = Array.from(new Set(Array.from(teachersOf.values()).flat()));
  const { data: teachers, error: teachersErr } = teacherIds.length
    ? await admin.from("profiles").select("id, telegram_id, preferred_locale, notifications_enabled").in("id", teacherIds)
    : { data: [] as any[], error: null };
  if (teachersErr) return fail(`teacher profiles read failed: ${teachersErr.message}`);
  const teacherMap = new Map<string, TeacherProfile>(((teachers || []) as any[]).map((t: any) => [t.id, t]));

  // Reminder tracker (cycle counting). A failed read would restart every counter at 1/3, and the
  // tracker write below would then let reminders run past three.
  const { data: rems, error: remsErr } = await admin.from("homework_ungraded_reminders")
    .select("submission_id, reminders_sent, last_reminder_at, cycle_submitted_at")
    .in("submission_id", eligible.map((s) => s.id));
  if (remsErr) return fail(`reminder tracker read failed: ${remsErr.message}`);
  const remMap = new Map<string, any>(((rems || []) as any[]).map((r: any) => [r.submission_id, r]));
  const reminderNumber = (s: Sub): number => {
    const rr = remMap.get(s.id);
    const sameCycle = !!(rr && rr.cycle_submitted_at && new Date(rr.cycle_submitted_at).getTime() === new Date(s.submitted_at).getTime());
    return (sameCycle ? (rr?.reminders_sent ?? 0) : 0) + 1;
  };

  // One tracker row + one audit row per submission (ops_daily_digest counts the audit rows).
  async function markReminded(batch: { s: Sub; n: number; details: Record<string, unknown> }[]) {
    if (!batch.length) return;
    const at = new Date().toISOString();
    const { error: upErr } = await admin.from("homework_ungraded_reminders").upsert(
      batch.map((b) => ({ submission_id: b.s.id, reminders_sent: b.n, last_reminder_at: at, cycle_submitted_at: b.s.submitted_at })),
      { onConflict: "submission_id" },
    );
    // Not harmless: last_reminder_at does not move, so the RPC picks the same submission again next
    // hour and its recipients are reminded every hour instead of every 24h.
    if (upErr) {
      await logHealth(admin, "ungraded_reminder_tracker_write_failed", {
        error: upErr.message, submissions: batch.length, submission_ids: batch.slice(0, 20).map((b) => b.s.id),
      }, { source: "cron-ungraded-homework-reminder" });
    }
    const { error: auditErr } = await admin.from("admin_actions").insert(batch.map((b) => ({
      actor_user_id: b.s.user_id,
      action: "ungraded_homework_reminder_sent",
      target_resource_type: "homework_submission",
      target_resource_id: b.s.id,
      details: b.details,
    })));
    if (auditErr) console.error("ungraded reminder audit insert failed", auditErr.message);
  }

  // Admins fallback (cached for the run)
  let adminRecipients: any[] | null = null;
  async function loadAdmins() {
    if (adminRecipients) return adminRecipients;
    const { data: roles } = await admin.from("user_roles").select("user_id, role").in("role", ["admin", "superadmin"] as any);
    const ids = Array.from(new Set((roles || []).map((r: any) => r.user_id)));
    if (!ids.length) { adminRecipients = []; return adminRecipients; }
    const { data: profs } = await admin.from("profiles").select("id, telegram_id, preferred_locale, notifications_enabled").in("id", ids);
    adminRecipients = (profs || []).filter((p: any) => p.telegram_id && p.notifications_enabled !== false);
    return adminRecipients;
  }

  let sent = 0, skipped = 0, teacherDms = 0;
  const adminQueue: { s: Sub; item: AdminItem }[] = [];
  // Teacher Mini App kill-switch, once per run (cached 60 s; a read error = today's buttons, DB-visible).
  const teacherFlag = await loadTeacherMiniAppFlag(admin, "cron-ungraded-homework-reminder");

  for (const s of eligible) {
    try {
      const student = studentMap.get(s.user_id);
      if (!student) { skipped++; continue; }
      const info = labels.map.get(s.assignment_id);
      const rawName = fullName(student);
      const hours = Math.floor((Date.now() - new Date(s.submitted_at).getTime()) / 3600000);
      const n = reminderNumber(s);
      // "<course> · <group> · M<n> V<step> — <title>"; the course is the task's own course.
      const item: AdminItem = {
        studentName: rawName,
        taskTitle: info?.title || "—",
        groupName: student.group_id ? (groupNames.get(student.group_id) ?? null) : null,
        courseTitle: info?.courseTitle ?? null,
        moduleNumber: info?.moduleNumber ?? null,
        step: info?.step ?? null,
        hours, n, reason: "no_teacher", // only read on the admin path, where the route's reason replaces it
      };

      const route = routeReminder(student.group_id, teachersOf, teacherMap);
      if (route.kind === "admin") {
        // Collected and sent as ONE message per admin after the loop.
        adminQueue.push({ s, item: { ...item, reason: route.reason } });
        continue;
      }

      const label = itemLabel(item);
      let delivered = 0;
      const btn = { web_app: 0, callback: 0, rejected: 0 };
      for (const r of route.recipients) {
        const gradeApp = await teacherAppButton({
          text: GRADE_APP_LABEL[r.locale], flag: teacherFlag, chatId: r.chatId, path: teacherGradePath(s.id),
          src: "teacher_hw_reminder", ref: s.id, fn: "cron-ungraded-homework-reminder", admin,
        });
        const payload = (app: typeof gradeApp) => ({
          chat_id: r.chatId,
          text: teacherReminderText(r.locale, rawName, label, hours, n),
          parse_mode: "HTML",
          reply_markup: teacherReminderKeyboard(r.locale, s.id, app, GRADE_CHAT_LABEL[r.locale]),
        });
        const { result: out, retried } = await sendWithWatchFallback(
          (p) => sendTelegram(BOT_TOKEN, "sendMessage", p, { admin, purpose: "ungraded_homework_reminder", recipientId: r.chatId }),
          payload(gradeApp),
          async () => (gradeApp ? payload(null) : null),
          { fn: "cron-ungraded-homework-reminder", admin },
        );
        if (retried) btn.rejected++;
        if (out.ok) {
          delivered++;
          btn[gradeApp && !retried ? "web_app" : "callback"]++;
        }
      }
      if (!delivered) { skipped++; continue; }
      teacherDms += delivered;

      await markReminded([{
        s, n,
        details: {
          recipient_kind: "teacher", reminders_sent: n, hours_waiting: hours, teachers_notified: delivered, teachers_reachable: route.recipients.length,
          buttons: btn, // which 🎯 went out: web_app (teacher Mini App) / callback (in-chat flow) / rejected (resent)
        },
      }]);
      sent++;
    } catch (e) {
      console.error("ungraded reminder loop error", s.id, e);
      skipped++;
    }
  }

  let adminBatched = 0;
  if (adminQueue.length) {
    try {
      const admins = await loadAdmins();
      if (!admins.length) {
        skipped += adminQueue.length;
      } else {
        // Each item already carries its label parts (course, group name, M/V, title) from the loop above.
        const items = adminQueue.map((q) => q.item);

        let delivered = 0;
        const seen = new Set<number>();
        for (const a of admins) {
          const chatId = Number(a.telegram_id);
          if (!Number.isFinite(chatId) || seen.has(chatId)) continue;
          seen.add(chatId);
          const loc = normLocale(a.preferred_locale);
          const out = await sendTelegram(BOT_TOKEN, "sendMessage", {
            chat_id: chatId,
            text: adminDigestText(items, loc),
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: ADMIN_BTN[loc], url: ADMIN_URL }]] },
          }, { admin, purpose: "ungraded_homework_reminder", recipientId: chatId });
          if (out.ok) delivered++;
        }
        if (delivered) {
          await markReminded(adminQueue.map((q) => ({
            s: q.s, n: q.item.n,
            details: { recipient_kind: "admin", reason: q.item.reason, reminders_sent: q.item.n, hours_waiting: q.item.hours, batch_size: adminQueue.length, admins_notified: delivered },
          })));
          sent += adminQueue.length;
          adminBatched = adminQueue.length;
        } else {
          skipped += adminQueue.length;
        }
      }
    } catch (e) {
      console.error("ungraded reminder admin batch error", e);
      skipped += adminQueue.length;
    }
  }

  return new Response(JSON.stringify({ ok: true, processed: eligible.length, sent, skipped, teacher_dms: teacherDms, admin_batched: adminBatched }), {
    headers: JSON_HEADERS,
  });
});
