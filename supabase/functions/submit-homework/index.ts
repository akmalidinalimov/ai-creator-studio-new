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
import { sendTelegramMultipart } from "../_shared/telegram-send.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BUCKET = "homework_images";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Telegram-topic upload path (2026-09-10 owner decision: homework media lives in TELEGRAM, not Supabase
// storage). These ceilings are Telegram's own BOT limits and cannot be raised — a bigger file is rejected
// up-front with a clear code so the client can offer the "post it in your topic yourself" fallback.
const MAX_ITEMS = 10;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // sendPhoto
const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // sendVideo (multipart upload by a bot)
const MAX_TOTAL_BYTES = 150 * 1024 * 1024; // aggregate per request — bounds what the edge runtime buffers

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
  // Feature 2 Stage B (whole-branch review): fan out to EVERY teacher of the group — primary
  // (groups.teacher_id) ∪ co-teachers (group_teachers) — mirroring the webhook's
  // notifyTeachersOfSubmission. This Mini App path has NO immediate send (the every-minute
  // notify-homework-submission cron drains the queue), so co-teachers previously only got the DM
  // after that reconciler delay; enqueuing a row per teacher here delivers promptly.
  const [{ data: g, error: gErr }, { data: gt, error: gtErr }] = await Promise.all([
    admin.from("groups").select("teacher_id").eq("id", groupId).maybeSingle(),
    admin.from("group_teachers").select("teacher_id").eq("group_id", groupId),
  ]);
  if (gErr) throw gErr; // a masked failure here would misclassify as "group has no teacher"
  if (gtErr) throw gtErr; // ditto — a masked junction read would silently drop the co-teachers
  const teacherIds = Array.from(new Set([
    ...(g?.teacher_id ? [g.teacher_id] : []),
    ...((gt || []) as any[]).map((r: any) => r.teacher_id),
  ]));
  if (!teacherIds.length) {
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
    .select("id, teacher_id, message_url").eq("submission_id", submissionId);
  if (recentErr) throw recentErr; // a masked failure here could either skip a legit dedupe or (worse) look like success
  // Per-teacher dedupe now runs inside the fan-out loop below — no global early return, since one
  // teacher already queued must NOT suppress a co-teacher's row. No .limit(): with N co-teachers a
  // submission legitimately has up to N rows per message_url; a small cap could truncate + leak a dup.

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
  // Fan out: one queue row per teacher (primary ∪ co-teachers), each with its own per-teacher dedupe.
  for (const teacherId of teacherIds) {
    // Per-teacher retry/double-tap dedupe: THIS teacher already has a row for THIS exact message_url.
    if ((recent || []).some((r: any) => r.teacher_id === teacherId && r.message_url === messageUrl)) continue;
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
    if (qErr) {
      // 23505 = a concurrent writer (the reconciler) already inserted this exact (submission_id,
      // teacher_id, message_url) row — benign race, skip it (same as Stage B). The uq index is
      // PARTIAL (WHERE message_url IS NOT NULL) so a targeted upsert can't infer it; .insert +
      // 23505-skip is the working equivalent.
      if ((qErr as any).code === "23505") continue;
      throw qErr; // any other error → fail loud, preserving this path's existing contract
    }
  }
  // No immediate send here on purpose — the every-minute notify-homework-submission cron drains
  // these rows. Sending here too would duplicate delivery.
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
  firstImagePath: string | null,
  mediaItems: Record<string, unknown>[],
  tgCols: Record<string, unknown>,
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
    submitted_image_url: firstImagePath,
    media: mediaItems,
    ...tgCols, // Telegram-topic path only: file/message coordinates so teacher tooling resolves it
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

// How long a claim is honoured before a later request may take it over (a crashed / timed-out request must
// not wedge the assignment forever). Long enough to cover a slow 50MB mobile upload.
const CLAIM_STALE_MS = 5 * 60_000;

/**
 * ATOMIC per-(student, assignment) claim, taken BEFORE anything is posted to Telegram.
 *
 * Posting into a shared class topic is irreversible, so two racing requests (double-tap, a client retry
 * after a slow upload, two open webviews) must never both reach Telegram. The claim table's PRIMARY KEY is
 * the serialization point: exactly one INSERT wins. We deliberately do NOT pre-insert a placeholder
 * homework_submissions row for this — that would fire the +15 XP INSERT trigger for a submission that might
 * never complete.
 *
 * Returns true if this request owns the claim. Fails OPEN (returns true) on an unexpected DB error: the
 * claim is a race guard, and a claim-table hiccup must not block every student from submitting — the
 * failure is made DB-visible instead.
 */
async function claimSubmit(admin: any, userId: string, assignmentId: string): Promise<boolean> {
  const { data: ins, error: insErr } = await admin
    .from("homework_submit_claims")
    .insert({ user_id: userId, assignment_id: assignmentId })
    .select("user_id")
    .maybeSingle();
  if (!insErr && ins) return true;
  if (insErr && (insErr as any).code !== "23505") {
    await logOutcome(admin, false, userId, { reason: "claim_error_fail_open", assignment_id: assignmentId, error: insErr.message });
    return true; // never block submission on the guard itself
  }
  // Someone holds it. Take over ONLY if their claim is stale (their request died mid-flight).
  const staleIso = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
  const { data: took } = await admin
    .from("homework_submit_claims")
    .update({ claimed_at: new Date().toISOString() })
    .eq("user_id", userId).eq("assignment_id", assignmentId).lt("claimed_at", staleIso)
    .select("user_id")
    .maybeSingle();
  return !!took;
}

/** Release the claim so a later legitimate resubmission isn't blocked. Best-effort: a leaked claim expires. */
async function releaseSubmit(admin: any, userId: string, assignmentId: string): Promise<void> {
  try {
    await admin.from("homework_submit_claims").delete().eq("user_id", userId).eq("assignment_id", assignmentId);
  } catch (e) { console.error("submit-homework releaseSubmit threw", String(e)); }
}

/**
 * Post the submitted files into the student's Telegram group HOMEWORK TOPIC as the bot, on the student's
 * behalf (Telegram has NO "post as user" API for a Mini App), and return everything needed to record the
 * submission EXACTLY like a bot-captured post: telegram_file_id / chat / thread / message coordinates plus a
 * media[] of {kind, file_id, msg_url}. That equivalence is the whole point — every existing teacher grading
 * surface already resolves those columns, so nothing teacher-side changes, and the submission links back to
 * the real group message.
 *
 * NOT re-captured as a duplicate: a bot never receives its own messages as updates, and the webhook's group
 * handler additionally ignores `msg.from.is_bot` (telegram-bot-webhook/index.ts:5126).
 *
 * MUST be called only AFTER all validation passes — posting is a visible side effect in a shared class
 * topic, so a request that would be rejected must never reach it.
 */
async function postHomeworkToTopic(
  admin: any,
  botToken: string,
  userId: string,
  assignmentId: string,
  files: File[],
  submittedText: string,
  target: any,
): Promise<{ mediaItems: Record<string, unknown>[]; tgCols: Record<string, unknown>; posted: number; failed: number } | { errorResponse: Response }> {
  const { data: prof, error: profErr } = await admin.from("profiles")
    .select("group_id, name, last_name, telegram_username").eq("id", userId).maybeSingle();
  if (profErr) {
    await logOutcome(admin, false, userId, { reason: "profile_lookup_failed", assignment_id: assignmentId, error: profErr.message });
    return { errorResponse: json({ error: "internal_error" }, 500) };
  }
  const groupId: string | null = prof?.group_id ?? null;
  if (!groupId) {
    await logOutcome(admin, false, userId, { reason: "no_group", assignment_id: assignmentId });
    return { errorResponse: json({ error: "no_group" }, 400) };
  }

  // Topic precedence MUST mirror the webhook's own resolver (resolveAssignmentForTopic path A/B) and the
  // my_homework_topic_url RPC: the module's dedicated topic when one is configured, else the group-level
  // topic. group_module_topics is empty today (all 3 groups use the group topic) but it is a LIVE admin
  // config surface (components/admin/GroupTopicsSection.tsx) — ignoring it would silently make Mini App
  // submission impossible for any group configured that way, with no fallback link either.
  const moduleId: string | null = (target as any)?.module_id ?? null;
  const [gmtRes, grpRes] = await Promise.all([
    moduleId
      ? admin.from("group_module_topics").select("telegram_topic_url")
          .eq("group_id", groupId).eq("module_id", moduleId).maybeSingle()
      : Promise.resolve({ data: null }),
    admin.from("groups").select("homework_topic_url, homework_topic_id").eq("id", groupId).maybeSingle(),
  ]);
  const perModuleUrl = String((gmtRes as any)?.data?.telegram_topic_url || "");
  const grp = (grpRes as any)?.data ?? null;
  const groupUrl = String(grp?.homework_topic_url || "");
  const topicUrl = perModuleUrl || groupUrl;

  // chat id lives in the t.me/c/<internal>/<thread> link (same parse the webhook's membership sweep uses).
  const m = /\/c\/(\d+)(?:\/(\d+))?/.exec(topicUrl);
  const chatInternal = m?.[1] ?? null;
  const threadFromUrl = m?.[2] ? Number(m[2]) : null;
  // homework_topic_id is the group-level thread — it must NOT be applied to a per-module topic url.
  const threadId = perModuleUrl ? threadFromUrl : (Number(grp?.homework_topic_id ?? 0) || threadFromUrl);
  // Require a THREAD, not just a chat: without one we would post into the group's General chat instead of
  // the homework topic. The admin form enforces the topic segment, but never trust that server-side.
  if (!chatInternal || !threadId) {
    await logOutcome(admin, false, userId, {
      reason: "topic_not_configured", assignment_id: assignmentId, group_id: groupId,
      has_per_module: !!perModuleUrl, has_group_topic: !!groupUrl,
    });
    return { errorResponse: json({ error: "topic_not_configured" }, 409) };
  }
  const chatId = Number(`-100${chatInternal}`);
  const linkBase = `https://t.me/c/${chatInternal}/${threadId}`;

  const uname = (prof?.telegram_username || "").toString().trim().replace(/^@/, "");
  const studentName = ([prof?.name, prof?.last_name].filter(Boolean).join(" ") || "—") + (uname ? ` (@${uname})` : "");
  const titleBits = [
    target?.module_number ? `${target.module_number}-modul` : null,
    target?.step_number ? `${target.step_number}-vazifa` : null,
    target?.title || null,
  ].filter(Boolean).join(" · ");
  // Caption rides the first item that actually POSTS (not literally index 0) — if item 0 failed, the
  // student's name/title/note would otherwise be missing from the only visible post in the topic.
  // No parse_mode anywhere here: the caption interpolates a student-supplied name/username/note, so it must
  // stay plain text — markup could otherwise break the send or inject formatting. Telegram caps captions at
  // 1024 chars; 1000 leaves margin.
  let caption = `📝 ${studentName}${titleBits ? `\n${titleBits}` : ""}`;
  if (submittedText) caption += `\n\n${submittedText}`;
  caption = caption.slice(0, 1000);

  const mediaItems: Record<string, unknown>[] = [];
  let firstMsgId: number | null = null;
  let firstFileId: string | null = null;
  let firstKind: string | null = null;
  let failed = 0;
  let captionUsed = false;

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const isVideo = (f.type || "").startsWith("video/");
    const fields: Record<string, string | number> = { chat_id: chatId, message_thread_id: threadId };
    if (!captionUsed) fields.caption = caption;
    if (isVideo) fields.supports_streaming = "true";

    const { outcome, result } = await sendTelegramMultipart(
      botToken,
      isVideo ? "sendVideo" : "sendPhoto",
      fields,
      { field: isVideo ? "video" : "photo", blob: f, filename: f.name || (isVideo ? "homework.mp4" : "homework.jpg") },
      { admin, purpose: "homework_topic_post", recipientId: chatId },
    );
    if (!outcome.ok || !result) { failed++; continue; }

    const msgId: number | null = typeof (result as any).message_id === "number" ? (result as any).message_id : null;
    // sendPhoto returns an array of sizes (largest last); sendVideo returns a single video object.
    const fileId: string | null = isVideo
      ? ((result as any)?.video?.file_id ?? null)
      : (Array.isArray((result as any)?.photo) && (result as any).photo.length
          ? (result as any).photo[(result as any).photo.length - 1].file_id
          : null);
    if (!fileId) { failed++; continue; }

    const msgUrl = msgId ? `${linkBase}/${msgId}` : null;
    mediaItems.push({ kind: isVideo ? "video" : "photo", file_id: fileId, ...(msgUrl ? { msg_url: msgUrl } : {}) });
    captionUsed = true; // only after a REAL success, so the caption isn't lost with a failed first item
    if (firstMsgId === null) { firstMsgId = msgId; firstFileId = fileId; firstKind = isVideo ? "video" : "photo"; }
  }

  if (!mediaItems.length) {
    // Nothing landed in the topic → do NOT create a submission that points at nothing.
    await logOutcome(admin, false, userId, { reason: "telegram_post_failed", assignment_id: assignmentId, files: files.length });
    return { errorResponse: json({ error: "telegram_post_failed" }, 502) };
  }
  if (failed) {
    await logOutcome(admin, false, userId, { reason: "telegram_post_partial", assignment_id: assignmentId, failed, posted: mediaItems.length });
  }

  return {
    posted: mediaItems.length,
    failed,
    mediaItems,
    tgCols: {
      telegram_chat_id: chatId,
      telegram_thread_id: threadId,
      telegram_message_id: firstMsgId,
      telegram_message_url: firstMsgId ? `${linkBase}/${firstMsgId}` : null,
      telegram_file_id: firstFileId,
      telegram_file_kind: firstKind,
    },
  };
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

  // --- 2. Body — TWO modes:
  //   (a) multipart/form-data → the Mini App sends the actual FILES (images AND video). We post them into
  //       the student's Telegram group homework topic and store NOTHING in Supabase (owner decision
  //       2026-09-10: homework media lives in Telegram — no storage cost, any teacher tooling already
  //       resolves Telegram-captured media).
  //   (b) application/json → legacy storage path (image_paths[] already uploaded to homework_images). Kept
  //       so an older / stale client bundle keeps working through rollout, and as a fallback.
  const contentType = (req.headers.get("content-type") || "").toLowerCase();
  const isMultipart = contentType.includes("multipart/form-data");

  let assignmentId = "";
  let submittedText = "";
  // Without an explicit resubmit confirmation, a graded-and-not-stale submission is left locked (409)
  // rather than silently overwritten by a stray retry — mirrors the picker's action==="replace" gate and
  // the website's explicit "🔁 Qayta topshirish" click.
  let resubmitConfirmed = false;
  let imagePaths: string[] = [];
  let files: File[] = [];

  if (isMultipart) {
    let form: FormData;
    try { form = await req.formData(); } catch { return json({ error: "bad_form" }, 400); }
    assignmentId = String(form.get("assignment_id") || "").trim();
    const t = form.get("submitted_text");
    submittedText = typeof t === "string" ? t.slice(0, 4000) : "";
    resubmitConfirmed = String(form.get("resubmit") || "") === "true";
    files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  } else {
    let body: any;
    try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
    assignmentId = String(body?.assignment_id || "").trim();
    const rawPaths: unknown[] = Array.isArray(body?.image_paths)
      ? body.image_paths
      : (body?.image_path != null ? [body.image_path] : []);
    imagePaths = rawPaths.map((p) => String(p ?? "").trim()).filter((p) => p.length > 0);
    submittedText = typeof body?.submitted_text === "string" ? body.submitted_text.slice(0, 4000) : "";
    resubmitConfirmed = body?.resubmit === true;
  }

  if (!UUID_RE.test(assignmentId)) {
    await logOutcome(admin, false, userId, { reason: "invalid_assignment_id" });
    return json({ error: "invalid_assignment_id" }, 400);
  }

  if (isMultipart) {
    if (!files.length) {
      await logOutcome(admin, false, userId, { reason: "media_required", assignment_id: assignmentId });
      return json({ error: "media_required" }, 400);
    }
    if (files.length > MAX_ITEMS) {
      await logOutcome(admin, false, userId, { reason: "too_many_files", assignment_id: assignmentId, count: files.length });
      return json({ error: "too_many_files", max: MAX_ITEMS }, 400);
    }
    // Reject oversize BEFORE posting anything: Telegram's bot ceilings are hard, and a partial album in a
    // shared class topic would be worse than a clean up-front error the client can explain.
    for (const f of files) {
      const isVideo = (f.type || "").startsWith("video/");
      const isImage = (f.type || "").startsWith("image/");
      if (!isVideo && !isImage) {
        await logOutcome(admin, false, userId, { reason: "unsupported_media", assignment_id: assignmentId, type: f.type || "unknown" });
        return json({ error: "unsupported_media" }, 400);
      }
      const cap = isVideo ? MAX_VIDEO_BYTES : MAX_PHOTO_BYTES;
      if (f.size > cap) {
        await logOutcome(admin, false, userId, { reason: "file_too_large", assignment_id: assignmentId, kind: isVideo ? "video" : "photo", size: f.size });
        return json({ error: "file_too_large", kind: isVideo ? "video" : "photo", max_bytes: cap }, 413);
      }
    }
    // Aggregate ceiling too: 10 near-limit videos would be ~500MB buffered by req.formData() and then
    // re-wrapped per item, which the edge runtime should never be asked to hold.
    const totalBytes = files.reduce((n, f) => n + f.size, 0);
    if (totalBytes > MAX_TOTAL_BYTES) {
      await logOutcome(admin, false, userId, { reason: "batch_too_large", assignment_id: assignmentId, total: totalBytes });
      return json({ error: "batch_too_large", max_bytes: MAX_TOTAL_BYTES }, 413);
    }
  } else {
    if (!imagePaths.length) {
      await logOutcome(admin, false, userId, { reason: "image_path_required", assignment_id: assignmentId });
      return json({ error: "image_path_required" }, 400);
    }
    if (imagePaths.length > MAX_ITEMS) {
      await logOutcome(admin, false, userId, { reason: "too_many_images", assignment_id: assignmentId, count: imagePaths.length });
      return json({ error: "too_many_images" }, 400);
    }
    // --- 3. every path must belong to the caller: "<uid>/<file>" (matches the storage RLS shape
    // from 20260502233427_*:104-106 — a student can only ever have uploaded under their own uid) AND
    // actually exist in the bucket (verify rather than trust the string — a signed-URL attempt is the
    // proven existence check already used for this bucket at index.ts:4060). ---
    for (const p of imagePaths) {
      if (!p.startsWith(`${userId}/`)) {
        await logOutcome(admin, false, userId, { reason: "image_path_not_own", assignment_id: assignmentId });
        return json({ error: "forbidden" }, 403);
      }
    }
    for (const p of imagePaths) {
      const { error: signErr } = await admin.storage.from(BUCKET).createSignedUrl(p, 60);
      if (signErr) {
        await logOutcome(admin, false, userId, { reason: "image_not_found", assignment_id: assignmentId });
        return json({ error: "image_not_found" }, 400);
      }
    }
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

  const nowIso = new Date().toISOString();

  // --- 5. Media acquisition. Deliberately AFTER every validation AND the already-graded guard above: the
  // Telegram path posts into a SHARED CLASS TOPIC, so a request that would be rejected must never reach it.
  let mediaItems: Record<string, unknown>[];
  let firstImagePath: string | null = null;
  let tgCols: Record<string, unknown> = {};

  let postedCount = 0;
  let failedCount = 0;

  if (isMultipart) {
    const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
    if (!botToken) {
      await logOutcome(admin, false, userId, { reason: "bot_token_missing", assignment_id: assignmentId });
      return json({ error: "internal_error" }, 500);
    }
    // ATOMIC claim before the irreversible group post — a concurrent request (double-tap / retry during a
    // slow upload / second webview) gets a clean 409 instead of posting the same media into the class topic
    // a second time. Released in `finally` so a later legitimate resubmission isn't blocked.
    if (!(await claimSubmit(admin, userId, assignmentId))) {
      await logOutcome(admin, false, userId, { reason: "submit_in_progress", assignment_id: assignmentId });
      return json({ error: "submit_in_progress" }, 409);
    }
    let posted;
    try {
      posted = await postHomeworkToTopic(admin, botToken, userId, assignmentId, files, submittedText, target);
    } finally {
      await releaseSubmit(admin, userId, assignmentId);
    }
    if ("errorResponse" in posted) return posted.errorResponse;
    mediaItems = posted.mediaItems;
    tgCols = posted.tgCols;
    postedCount = posted.posted;
    failedCount = posted.failed;
  } else {
    // media[] carries every uploaded photo in order; submitted_image_url keeps the FIRST as the legacy
    // scalar that older teacher-facing reads still use (the grading gallery renders the full media[]).
    mediaItems = imagePaths.map((p) => ({ kind: "photo", url: p }));
    firstImagePath = imagePaths[0];
  }

  let submissionId: string;
  let attemptNumber: number;
  let status: "submitted" | "resubmitted";

  if (prior) {
    status = "resubmitted";
    const r = await applyResubmission(userClient, admin, userId, assignmentId, prior.id, submittedText, firstImagePath, mediaItems, tgCols, nowIso);
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
      submitted_image_url: firstImagePath,
      media: mediaItems,
      ...tgCols, // Telegram-topic path only: file/message coordinates so teacher tooling resolves it
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
      const r = await applyResubmission(userClient, admin, userId, assignmentId, raced.id, submittedText, firstImagePath, mediaItems, tgCols, nowIso);
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

  // posted/failed let the client tell the student "N of M uploaded" instead of a plain success toast when
  // some files didn't make it into the topic (the failure is DB-visible via telegram_post_partial too).
  return json({
    submission_id: submissionId,
    status,
    attempt_number: attemptNumber,
    ...(isMultipart ? { posted: postedCount, failed: failedCount } : {}),
  });
});
