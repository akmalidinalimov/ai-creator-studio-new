// submit-homework — Mini App in-app homework submission (item 4 of the in-app upload work).
//
// POST { assignment_id: uuid, image_path: string, submitted_text?: string, resubmit?: boolean }
//   -> { submission_id, status: "submitted" | "resubmitted", attempt_number }
//
// Auth: a real Supabase session JWT (verify_jwt = true, see supabase/config.toml). The frontend
// gets that session from tg-miniapp-auth (Telegram initData -> minted Supabase session) and then
// calls this function like any other authenticated endpoint — this function does NOT touch
// Telegram initData itself. Boilerplate follows the bunny-upload-init / study-assistant pattern
// (userClient scoped to the caller's JWT for auth.uid()-dependent RPCs + identity resolution;
// admin service-role client for the privileged writes) rather than tg-miniapp-auth's HMAC dance,
// which is specific to the initial sign-in bridge. Checked supabase/functions/_shared/ — nothing
// there applies to this flow (no internal-secret, no initData, no session minting needed here).
//
// This function writes into the SAME homework_submissions table the Telegram bot capture paths
// write into (telegram-bot-webhook/index.ts ~5187-5210 picker finalize, ~5895-5921 auto capture)
// so grading + XP + teacher notification all flow through the existing engine untouched:
//   - XP is 100% trigger-driven (20260706090000_profile_gamification_phase1.sql:115-135) — this
//     function NEVER writes xp_events/user_xp. +15 fires on INSERT, +25 fires when a teacher
//     later sets score >= 9. A resubmission's content UPDATE does not re-INSERT, so it does not
//     re-fire the first-homework-badge/first-submission XP trigger either.
//   - Teacher notification is NOT automatic — enqueued into homework_teacher_dm_queue below,
//     mirroring notifyTeachersOfSubmission (index.ts:6015-6160). The existing
//     notify-homework-submission cron (runs every minute) drains it; this function does not send
//     the Telegram DM itself, so delivery is never duplicated.
//
// ERROR-HANDLING RULE (2026-08-18 review fix, class A): supabase-js v2 never throws on a Postgres
// error by itself — every `{ data, error }` result MUST be checked. Every privileged write in
// this file either checks its `error` and returns/throws, or (inside enqueueTeacherDm) throws so
// the outer try/catch turns it into a `notify_enqueue_failed` DB-visible health signal instead of
// a silently-successful 200 with no teacher ever notified.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BUCKET = "homework_images";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// Incident doctrine (CLAUDE.md): this path must be DB-visible, not log-only. One row per attempt,
// success or failure, so a detector/reconciler can query admin_actions for this action family.
// This write itself is intentionally best-effort (never let the health SIGNAL break the actual
// response) — but its failure is still logged to console so it isn't a silent double-swallow.
async function logOutcome(
  admin: any,
  ok: boolean,
  actorUserId: string | null,
  details: Record<string, unknown>,
  targetResourceId?: string | null,
) {
  try {
    const { error } = await admin.from("admin_actions").insert({
      actor_user_id: actorUserId,
      action: ok ? "miniapp_homework_submitted" : "miniapp_homework_submit_failed",
      target_user_id: null,
      target_resource_type: "homework_submission",
      target_resource_id: targetResourceId ?? null,
      details,
    });
    if (error) console.error("submit-homework logOutcome insert failed", error.message);
  } catch (e) { console.error("submit-homework logOutcome threw", String(e)); }
}

async function resolveGroupId(admin: any, userId: string): Promise<string | null> {
  const { data, error } = await admin.from("profiles").select("group_id").eq("id", userId).maybeSingle();
  if (error) throw error; // a masked failure here would misclassify as "student has no group"
  return data?.group_id ?? null;
}

// Mirrors notifyTeachersOfSubmission (telegram-bot-webhook/index.ts:6015-6160), minus the
// immediate-send half: this only ENQUEUES. The every-minute notify-homework-submission cron
// (supabase/functions/notify-homework-submission/index.ts) is the sole sender, so delivery is
// never duplicated between the two code paths.
//
// Every await below that can return `{ error }` is checked and THROWS on failure — this function
// has no immediate-send fallback (unlike the bot's in-webhook path, which sends right away outside
// quiet hours), so a swallowed error here means the teacher is silently never notified, forever,
// with no queue row for any reconciler to find. The caller wraps this whole call in try/catch and
// turns a thrown error into the notify_enqueue_failed health signal (class A fix).
async function enqueueTeacherDm(
  admin: any,
  args: {
    studentId: string;
    groupId: string | null;
    moduleId: string;
    moduleNumber: number;
    stepNumber: number;
    assignmentId: string;
    assignmentTitle: string;
    submissionId: string;
    attemptNumber: number;
  },
) {
  const { studentId, groupId, moduleId, moduleNumber, stepNumber, assignmentId, assignmentTitle, submissionId, attemptNumber } = args;
  if (!groupId) {
    const { error } = await admin.from("admin_actions").insert({
      actor_user_id: studentId,
      action: "homework_submission_dm_sent",
      target_user_id: null,
      target_resource_type: "homework_submission",
      target_resource_id: submissionId,
      details: { reason: "no_group", student_id: studentId, source: "miniapp", queued: false },
    });
    if (error) throw error;
    return;
  }
  const { data: g, error: gErr } = await admin.from("groups").select("teacher_id").eq("id", groupId).maybeSingle();
  if (gErr) throw gErr; // a masked failure here would misclassify as "group has no teacher"
  const teacherId = g?.teacher_id;
  if (!teacherId) {
    const { error } = await admin.from("admin_actions").insert({
      actor_user_id: studentId,
      action: "homework_submission_dm_sent",
      target_user_id: null,
      target_resource_type: "homework_submission",
      target_resource_id: submissionId,
      details: { reason: "no_teacher", student_id: studentId, group_id: groupId, module_id: moduleId, source: "miniapp", queued: false },
    });
    if (error) throw error;
    return;
  }

  // message_url doubles as the Telegram inline "open" button URL rendered unconditionally by the
  // drainer (notify-homework-submission/index.ts:135) AND as half of the per-row dedupe key
  // (submission_id, message_url) that notifyTeachersOfSubmission checks before inserting
  // (index.ts:6060-6065) — a non-URL synthetic string (the naive "miniapp:<id>:<attempt>" idea)
  // would make Telegram reject the WHOLE sendMessage (BUTTON_URL_INVALID), silently dropping every
  // miniapp teacher DM. A bot deep-link is always a valid https:// URL; the payload is namespaced
  // "hw_" (distinct from the bot's own "login_" prefix — telegram-bot-webhook/index.ts:7330) so an
  // accidental tap just falls through to the standard help keyboard (index.ts:7333-7335), never an
  // error. It also varies per (submission_id, attempt_number), which the dedupe check needs: a
  // resubmission MUST always queue a fresh DM (see the comment at index.ts:6057-6059) even though
  // it reuses the same submission_id. The reconciler (20260818170000_*.sql) builds this SAME URL
  // shape when it has to resurrect a missing row — keep the two in sync if this ever changes.
  const botUsername = (Deno.env.get("TELEGRAM_BOT_USERNAME") || "").replace(/^@/, "");
  const messageUrl = botUsername
    ? `https://t.me/${botUsername}?start=hw_${submissionId}_${attemptNumber}`
    : `https://t.me/?start=hw_${submissionId}_${attemptNumber}`; // degraded but still a syntactically valid https URL

  const { data: recent, error: recentErr } = await admin.from("homework_teacher_dm_queue")
    .select("id, message_url").eq("submission_id", submissionId).limit(5);
  if (recentErr) throw recentErr; // a masked failure here could either skip a legit dedupe or (worse) look like success
  if (recent && recent.some((r: any) => r.message_url === messageUrl)) return; // defends a double-tap/retry of this same attempt

  const now = new Date();
  const tashHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tashkent", hour: "2-digit", hour12: false }).format(now));
  let scheduled = now;
  if (tashHour >= 22 || tashHour < 8) {
    const utcMs = now.getTime();
    const tashMs = utcMs + 5 * 60 * 60 * 1000;
    const tashDate = new Date(tashMs);
    const y = tashDate.getUTCFullYear(); const m = tashDate.getUTCMonth(); const d = tashDate.getUTCDate();
    const targetTashMs = Date.UTC(y, m, d + (tashHour >= 22 ? 1 : 0), 8, 0, 0);
    scheduled = new Date(targetTashMs - 5 * 60 * 60 * 1000);
  }
  const quiet = tashHour >= 22 || tashHour < 8;

  const { data: prof, error: profErr } = await admin.from("profiles")
    .select("name, last_name, telegram_username").eq("id", studentId).maybeSingle();
  if (profErr) throw profErr;
  const uname = (prof?.telegram_username || "").toString().trim().replace(/^@/, "");
  const studentName = ([prof?.name, prof?.last_name].filter(Boolean).join(" ") || "—") + (uname ? ` (@${uname})` : "");

  // THE core class-A bug: this insert's result used to be discarded entirely (`const { data:
  // queued } = await ...insert(...)`, `error` never named). supabase-js does not throw on a
  // Postgres error — a failed insert here used to resolve silently, the function would report a
  // clean 200 to the student, and the teacher would never be notified with no trace anywhere.
  const { error: qErr } = await admin.from("homework_teacher_dm_queue").insert({
    submission_id: submissionId,
    teacher_id: teacherId,
    student_id: studentId,
    group_id: groupId,
    module_id: moduleId,
    assignment_id: assignmentId,
    module_number: moduleNumber,
    task_number: stepNumber,
    assignment_title: assignmentTitle,
    student_name: studentName,
    message_url: messageUrl,
    scheduled_for: scheduled.toISOString(),
    queued_for_quiet_hours: quiet,
  });
  if (qErr) throw qErr;
  // No immediate send here on purpose — the every-minute notify-homework-submission cron drains
  // this row. Sending here too would duplicate delivery.
}

// Resubmission: bumps attempt_number (and, only when a score already existed, archives it into
// previous_attempts + flags score_is_stale=true while keeping the old score visible — hybrid
// retention, unified with the bot's own null-score resubmit path via the `state` computation in
// student_assignable_homework()) via the SAME RPC the website's "🔁 Qayta topshirish" button calls
// (HomeworkSection.tsx:178), then writes ONLY the new content columns. Deliberately does not touch
// score / score_feedback / scored_by / scored_at / score_is_stale / attempt_number /
// previous_attempts here — those were already correctly set by the RPC; touching attempt_number
// again would double-bump it, and touching score would fight homework_submissions_guard for no
// reason since we are keeping the RPC's stale-but-visible score, not nulling it.
async function applyResubmission(
  userClient: any,
  admin: any,
  userId: string,
  assignmentId: string,
  targetId: string,
  submittedText: string,
  imagePath: string,
  mediaItem: Record<string, string>,
  nowIso: string,
): Promise<{ submissionId: string; attemptNumber: number } | { errorResponse: Response }> {
  const { data: resub, error: resubErr } = await userClient.rpc("start_homework_resubmission", { p_submission_id: targetId });
  if (resubErr || !resub) {
    await logOutcome(admin, false, userId, { reason: "resubmit_rpc_failed", assignment_id: assignmentId, submission_id: targetId, error: resubErr?.message }, targetId);
    return { errorResponse: json({ error: "resubmit_failed" }, 500) };
  }
  const attemptNumber = (resub as any).attempt_number ?? 1;
  // Carry previous_score too (index.ts:5121/5891 pattern) for any consumer still reading the
  // scalar column unconditionally — score_is_stale + score already cover teacher-facing display
  // (index.ts:4042-4045), so this is defense-in-depth, not the primary signal.
  const previousScoreToCarry: number | null = (resub as any).score ?? null;

  const { error: updErr } = await admin.from("homework_submissions").update({
    submitted_text: submittedText,
    submitted_image_url: imagePath,
    media: [mediaItem],
    source: "miniapp",
    submitted_at: nowIso,
    previous_score: previousScoreToCarry,
  }).eq("id", targetId);
  if (updErr) {
    await logOutcome(admin, false, userId, { reason: "write_failed", assignment_id: assignmentId, submission_id: targetId, error: updErr.message }, targetId);
    return { errorResponse: json({ error: "internal_error" }, 500) };
  }
  return { submissionId: targetId, attemptNumber };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // --- 1. Auth: resolve the caller from their JWT (never log the JWT itself). ---
  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!jwt) return json({ error: "unauthorized" }, 401);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: authErr } = await userClient.auth.getUser(jwt);
  if (authErr || !userData?.user) return json({ error: "unauthorized" }, 401);
  const userId = userData.user.id;

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  const assignmentId = String(body?.assignment_id || "").trim();
  const imagePath = String(body?.image_path || "").trim();
  const submittedText = typeof body?.submitted_text === "string" ? body.submitted_text.slice(0, 4000) : "";
  // Additive beyond the base 3-field contract: without an explicit resubmit confirmation, a
  // graded-and-not-stale submission is left locked (409) rather than silently overwritten by a
  // stray retry — mirrors the picker's action==="replace" gate (index.ts:5122) and the website's
  // explicit "🔁 Qayta topshirish" click (HomeworkSection.tsx:178) which both require a deliberate
  // user action before a live grade is touched.
  const resubmitConfirmed = body?.resubmit === true;

  if (!UUID_RE.test(assignmentId)) {
    await logOutcome(admin, false, userId, { reason: "invalid_assignment_id" });
    return json({ error: "invalid_assignment_id" }, 400);
  }
  if (!imagePath) {
    await logOutcome(admin, false, userId, { reason: "image_path_required", assignment_id: assignmentId });
    return json({ error: "image_path_required" }, 400);
  }

  // --- 3. image_path must belong to the caller: "<uid>/<file>" (matches the storage RLS shape
  // from 20260502233427_*:104-106 — a student can only ever have uploaded under their own uid). ---
  if (!imagePath.startsWith(`${userId}/`)) {
    await logOutcome(admin, false, userId, { reason: "image_path_not_own", assignment_id: assignmentId });
    return json({ error: "forbidden" }, 403);
  }

  // The client claims to have already uploaded this object — verify it actually exists rather
  // than trusting the string (a signed-URL attempt is a proven check already used for this same
  // bucket at index.ts:4060).
  const { error: signErr } = await admin.storage.from(BUCKET).createSignedUrl(imagePath, 60);
  if (signErr) {
    await logOutcome(admin, false, userId, { reason: "image_not_found", assignment_id: assignmentId });
    return json({ error: "image_not_found" }, 400);
  }

  // --- 2. Assignable-set + tier check: replicate by calling student_assignable_homework() AS
  // the caller (userClient, so auth.uid() resolves — the service-role admin client's auth.uid()
  // is NULL and would make the RPC itself raise not_authenticated). The RPC already folds the
  // tier gate (has_module_access) into which rows it returns, so "in the assignable set" AND
  // "tier-allowed" are the SAME check here. ---
  const { data: assignable, error: rpcErr } = await userClient.rpc("student_assignable_homework");
  if (rpcErr) {
    await logOutcome(admin, false, userId, { reason: "assignable_rpc_failed", assignment_id: assignmentId, error: rpcErr.message });
    return json({ error: "internal_error" }, 500);
  }
  const target = ((assignable || []) as any[]).find((r) => r.assignment_id === assignmentId);
  if (!target) {
    await logOutcome(admin, false, userId, { reason: "not_assignable", assignment_id: assignmentId });
    return json({ error: "not_assignable" }, 403);
  }

  // --- 4. Already-graded guard + resubmission. Fresh read under admin (bypasses RLS, avoids
  // trusting the RPC snapshot from a moment ago) is the actual gate for the write. ---
  const { data: prior, error: priorErr } = await admin.from("homework_submissions")
    .select("id, score, score_is_stale")
    .eq("user_id", userId).eq("assignment_id", assignmentId).maybeSingle();
  if (priorErr) {
    // A masked failure here would fall through as "no prior submission" and could attempt to
    // re-INSERT over an already-graded row — must not be silently treated as "nothing exists yet".
    await logOutcome(admin, false, userId, { reason: "prior_lookup_failed", assignment_id: assignmentId, error: priorErr.message });
    return json({ error: "internal_error" }, 500);
  }

  const lockedGraded = !!prior && prior.score != null && !prior.score_is_stale;
  if (lockedGraded && !resubmitConfirmed) {
    await logOutcome(admin, false, userId, { reason: "already_graded", assignment_id: assignmentId, submission_id: prior!.id }, prior!.id);
    return json({ error: "already_graded", submission_id: prior!.id, score: prior!.score }, 409);
  }

  const mediaItem = { kind: "photo", url: imagePath };
  const nowIso = new Date().toISOString();
  let submissionId: string;
  let attemptNumber: number;
  let status: "submitted" | "resubmitted";

  if (prior) {
    status = "resubmitted";
    const r = await applyResubmission(userClient, admin, userId, assignmentId, prior.id, submittedText, imagePath, mediaItem, nowIso);
    if ("errorResponse" in r) return r.errorResponse;
    submissionId = r.submissionId;
    attemptNumber = r.attemptNumber;
  } else {
    // Fresh row: mirrors the bot's own upsert shape (index.ts:5895-5921) minus the
    // Telegram-specific columns, which stay NULL for a miniapp-sourced row (the teacher grading
    // screen already renders submitted_image_url via a signed URL for non-Telegram submissions —
    // index.ts:4057-4063 "Legacy web-source submission").
    //
    // XP-WARN fix: plain INSERT, not upsert. A same-instant double-tap where both requests read
    // `prior = null` used to race an upsert — the loser's UPDATE-on-conflict would force-write
    // attempt_number=1 / previous_score=null / score_is_stale=false over a row the winner may have
    // already turned into an in-progress resubmission of an already-graded assignment (the guard
    // trigger only protects `score` itself, not that other bookkeeping). A plain INSERT instead
    // fails with 23505 on the loser, which is handled below by re-reading the row and funneling
    // through the SAME resubmission path used everywhere else in this file — one path, not a race.
    const { data: inserted, error: insErr } = await admin.from("homework_submissions").insert({
      user_id: userId,
      assignment_id: assignmentId,
      submitted_text: submittedText,
      submitted_image_url: imagePath,
      media: [mediaItem],
      source: "miniapp",
      submitted_at: nowIso,
      attempt_number: 1,
      previous_score: null,
      score: null,
      score_feedback: null,
      scored_by: null,
      scored_at: null,
      score_is_stale: false,
      is_late: false,
    }).select("id, attempt_number").maybeSingle();

    if (insErr && (insErr as any).code === "23505") {
      const { data: raced, error: racedErr } = await admin.from("homework_submissions")
        .select("id").eq("user_id", userId).eq("assignment_id", assignmentId).maybeSingle();
      if (racedErr || !raced?.id) {
        await logOutcome(admin, false, userId, { reason: "race_reread_failed", assignment_id: assignmentId, error: racedErr?.message });
        return json({ error: "internal_error" }, 500);
      }
      status = "resubmitted";
      const r = await applyResubmission(userClient, admin, userId, assignmentId, raced.id, submittedText, imagePath, mediaItem, nowIso);
      if ("errorResponse" in r) return r.errorResponse;
      submissionId = r.submissionId;
      attemptNumber = r.attemptNumber;
    } else if (insErr || !inserted?.id) {
      await logOutcome(admin, false, userId, { reason: "write_failed", assignment_id: assignmentId, error: insErr?.message });
      return json({ error: "internal_error" }, 500);
    } else {
      status = "submitted";
      submissionId = inserted.id;
      attemptNumber = inserted.attempt_number ?? 1;
    }
  }

  // --- 6. Teacher notification: enqueue only, never send from here (see enqueueTeacherDm doc). ---
  try {
    const groupId = await resolveGroupId(admin, userId);
    await enqueueTeacherDm(admin, {
      studentId: userId,
      groupId,
      moduleId: (target as any).module_id,
      moduleNumber: (target as any).module_number,
      stepNumber: (target as any).step_number,
      assignmentId,
      assignmentTitle: (target as any).title || "",
      submissionId,
      attemptNumber,
    });
  } catch (e) {
    // Never fail the submission itself over the notification leg — mirrors
    // notifyTeachersOfSubmission's own top-level try/catch (index.ts:6151-6153). Class-A fix:
    // every write inside resolveGroupId/enqueueTeacherDm now throws on error instead of silently
    // continuing with undefined data, so this catch is reliably reached on a real failure instead
    // of the function reporting a clean 200 with no queue row and no trace.
    await logOutcome(admin, false, userId, { reason: "notify_enqueue_failed", assignment_id: assignmentId, submission_id: submissionId, error: String((e as any)?.message ?? e) }, submissionId);
  }

  // --- 7. Success health signal (source='miniapp' on the row is also a queryable marker). ---
  await logOutcome(admin, true, userId, { assignment_id: assignmentId, status, attempt_number: attemptNumber }, submissionId);

  return json({ submission_id: submissionId, status, attempt_number: attemptNumber });
});
