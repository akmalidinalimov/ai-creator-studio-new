// teacher-voice-request — bridge the Mini App's blocked microphone to Telegram's own recorder.
//
// PROBLEM: Telegram's in-app webview does NOT grant Mini Apps microphone access, so the teacher grading
// screen's in-app VoiceRecorder is unusable on most devices. It already degrades to "write text or send the
// voice from the bot" — but gave the teacher no way to actually get there, so voice feedback was a dead end.
//
// THIS IS THAT WAY: the Mini App calls this endpoint for a submission; we PARK a `grade_voice` conversation
// state for the teacher and DM them a prompt in the bot chat. The teacher records with Telegram's NATIVE
// recorder (always works, no permissions), and telegram-bot-webhook's `grade_voice` handler attaches the
// note to the submission and delivers it to the student — reusing the in-bot voice pipeline that already
// works end to end. No second delivery mechanism, no new storage.
//
// Deliberately pushes a message instead of returning a t.me deep link: the client then needs no bot username
// (which it has no legitimate source for), and the prompt is already waiting when the teacher lands in chat.
//
// Auth: teacher/admin session JWT (verify_jwt=true) + junction-aware RBAC (is_group_teacher ∪ admin) —
// identical to hw-image-url, so a teacher can only ever do this for a student in their own group.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, json, logHealth } from "../_shared/edge.ts";
import { sendTelegramResult } from "../_shared/telegram-send.ts";
import { loadHwLabel } from "../_shared/hw-label-load.ts";
import { parkVoiceRequest, stampVoicePromptIo, withdrawVoiceRequest } from "../_shared/voice-requests.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const escHtml = (s = "") => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

type Locale = "uz" | "ru" | "en";
function normLocale(code?: string | null): Locale {
  const l = (code || "").toLowerCase().slice(0, 2);
  if (l === "ru") return "ru";
  if (l === "en") return "en";
  return "uz";
}
// The ONLY copy of this prompt. The webhook's grade_voice step owns the follow-ups (gvNeedVoice / gvSaved /
// gvExpired) — keep the wording consistent if either side changes. `label` is the shared hw-label
// ("5.0 · 1-GURUH PRE · M2 V1 — <title>"): the Challenge tasks are copies of the 5.0 tasks, so the title alone
// could not tell the teacher which course's card she is voicing (audit BOT-8 / FB-3). `pending` = requests now
// waiting, this one included; `reply` = a recording must REPLY to its student's prompt to be taken without a
// question — true with more than one pending, and also when this is the only one left of several (the bot's
// sticky "several were pending" mark, _shared/voice-requests.ts) — so the prompt says so.
const ASK: Record<Locale, (student: string, label: string, pending: number, reply: boolean) => string> = {
  uz: (s, l, n, r) => `🎤 <b>${s}</b>\n📌 ${l}\n\n` + (n > 1
    ? `Sizda <b>${n} ta</b> ovozli so'rov kutilmoqda — ovozni aynan <b>shu xabarga javob (reply)</b> qilib yuboring, shunda u shu talabaga boradi (yoki /cancel).`
    : r
    ? `Ovozni aynan <b>shu xabarga javob (reply)</b> qilib yuboring, shunda u shu talabaga boradi (yoki /cancel).`
    : `Ovozli izohingizni shu yerga yuboring (yoki /cancel):`),
  ru: (s, l, n, r) => `🎤 <b>${s}</b>\n📌 ${l}\n\n` + (n > 1
    ? `Ожидает запросов: <b>${n}</b> — отправьте голосовое <b>ответом (reply) на это сообщение</b>, тогда оно уйдёт этому студенту (или /cancel).`
    : r
    ? `Отправьте голосовое <b>ответом (reply) на это сообщение</b>, тогда оно уйдёт этому студенту (или /cancel).`
    : `Отправьте сюда голосовой комментарий (или /cancel):`),
  en: (s, l, n, r) => `🎤 <b>${s}</b>\n📌 ${l}\n\n` + (n > 1
    ? `You have <b>${n}</b> pending requests — send the voice note <b>as a reply to this message</b> so it reaches this student (or /cancel).`
    : r
    ? `Send the voice note <b>as a reply to this message</b> so it reaches this student (or /cancel).`
    : `Send your voice feedback here (or /cancel):`),
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";

  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!jwt) return json({ error: "unauthorized" }, 401);
  const { data: userData, error: authErr } = await admin.auth.getUser(jwt);
  if (authErr || !userData?.user) return json({ error: "unauthorized" }, 401);
  const uid = userData.user.id;

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const submissionId = String(body?.submission_id || "").trim();
  if (!UUID_RE.test(submissionId)) return json({ error: "invalid_submission_id" }, 400);
  if (!BOT_TOKEN) {
    await logHealth(admin, "teacher_voice_request_failed", { reason: "bot_token_missing", submission_id: submissionId }, { source: "teacher-voice-request", actorUserId: uid });
    return json({ error: "internal_error" }, 500);
  }

  try {
    const { data: sub, error: subErr } = await admin.from("homework_submissions")
      .select("id, user_id, assignment_id").eq("id", submissionId).maybeSingle();
    if (subErr) throw subErr;
    if (!sub) return json({ error: "not_found" }, 404);

    // --- RBAC: teacher of the student's group (junction-aware) OR platform admin. ---
    const { data: stu, error: stuErr } = await admin.from("profiles")
      .select("group_id, name, last_name").eq("id", sub.user_id).maybeSingle();
    if (stuErr) throw stuErr;
    let allowed = false;
    if (stu?.group_id) {
      const { data: isTeacher, error: itErr } = await admin.rpc("is_group_teacher", { _group_id: stu.group_id, _uid: uid });
      if (itErr) throw itErr;
      allowed = isTeacher === true;
    }
    if (!allowed) {
      const { data: roles, error: rErr } = await admin.from("user_roles")
        .select("role").eq("user_id", uid).in("role", ["admin", "superadmin"]);
      if (rErr) throw rErr;
      allowed = !!roles?.length;
    }
    if (!allowed) return json({ error: "forbidden" }, 403);

    // --- The teacher must be reachable in the bot (they drive the whole flow there). ---
    const { data: me, error: meErr } = await admin.from("profiles")
      .select("telegram_id, preferred_locale").eq("id", uid).maybeSingle();
    if (meErr) throw meErr;
    const teacherTg = me?.telegram_id ? Number(me.telegram_id) : null;
    if (!teacherTg) {
      // Expected reach case (not a fault): the teacher never linked/started the bot.
      await logHealth(admin, "teacher_voice_request_no_telegram", { submission_id: submissionId }, { source: "teacher-voice-request", actorUserId: uid, targetResourceId: submissionId });
      return json({ error: "no_telegram" }, 409);
    }

    // Course from the task, group from the student's group (the one the RBAC above checked). A failed read only
    // shortens the label (recorded once a day as hw_label_lookup_failed).
    const lbl = await loadHwLabel(admin, sub.assignment_id, stu?.group_id ?? null, "teacher-voice-request");
    const label = lbl.label || lbl.info?.title || "—";
    const studentName = [stu?.name, stu?.last_name].filter(Boolean).join(" ") || "—";
    const locale = normLocale(me?.preferred_locale);

    // --- Park ONE MORE request, keyed by this submission — never re-point one already pending. ---
    // Until 2026-09-30 a second tap moved the teacher's single pending request to the newer card, so her first
    // recording went to the SECOND student at once, and the other recording was lost (audit FB-4). Now each
    // card keeps its own entry (_shared/voice-requests.ts; the same card again refreshes its entry), and the
    // webhook matches a recording to the prompt it replies to, or asks with per-student buttons.
    // bot_conversation_state is ONE row per telegram_id: the set lives in its context, written by compare-and-
    // swap. A live non-voice flow (in-bot grading, name capture, …) is still never clobbered → 409 `busy`.
    const park = await parkVoiceRequest(admin, teacherTg, {
      submission_id: submissionId, label: lbl.label || null, student: studentName === "—" ? null : studentName,
    });
    if (!park.ok) {
      // Four compare-and-swap rounds lost in a row (several taps at once), or the row could not be read.
      if (park.reason === "db_error") throw new Error(park.error || "voice_state_write_failed");
      await logHealth(admin, "teacher_voice_request_busy", { submission_id: submissionId, reason: "contended" }, { source: "teacher-voice-request", actorUserId: uid, targetResourceId: submissionId });
      return json({ error: "busy" }, 409);
    }
    const parked = park.result;
    if (parked.kind === "busy") {
      await logHealth(admin, "teacher_voice_request_busy", { submission_id: submissionId, reason: "flow", state: parked.state }, { source: "teacher-voice-request", actorUserId: uid, targetResourceId: submissionId });
      return json({ error: "busy" }, 409);
    }
    if (parked.kind === "too_many") {
      await logHealth(admin, "teacher_voice_request_busy", { submission_id: submissionId, reason: "too_many", pending: parked.pending }, { source: "teacher-voice-request", actorUserId: uid, targetResourceId: submissionId });
      return json({ error: "too_many", pending: parked.pending }, 409);
    }

    // --- Prompt them in the bot chat. If this can't be delivered the flow is dead, so surface it. ---
    const { outcome: out, result: sent } = await sendTelegramResult(
      BOT_TOKEN,
      "sendMessage",
      { chat_id: teacherTg, text: ASK[locale](escHtml(studentName), escHtml(label), parked.pending, parked.replyNeeded), parse_mode: "HTML" },
      { admin, purpose: "teacher_voice_prompt", recipientId: teacherTg },
    );
    if (!out.ok) {
      // Withdraw the request this prompt announced — a request she never saw must not capture a recording.
      // A REFRESHED request keeps its earlier prompt(s), so it stays.
      if (parked.outcome === "added") await withdrawVoiceRequest(admin, teacherTg, parked.req.rid);
      return json({ error: "prompt_failed", recipient: out.recipient }, 502);
    }
    // Remember the prompt's message_id on its request: a recording that REPLIES to this prompt goes to this
    // student. If the stamp is lost (a race won four times) the request still works through the buttons.
    const mid = Number(sent?.message_id);
    if (Number.isInteger(mid) && mid > 0) {
      const st = await stampVoicePromptIo(admin, teacherTg, parked.req.rid, mid);
      if (!st.ok) {
        await logHealth(admin, "teacher_voice_prompt_unstamped", { submission_id: submissionId, reason: st.reason }, { source: "teacher-voice-request", actorUserId: uid, targetResourceId: submissionId });
      }
    }

    await logHealth(admin, "teacher_voice_requested", { submission_id: submissionId, pending: parked.pending, refreshed: parked.outcome === "refreshed" }, { source: "teacher-voice-request", actorUserId: uid, targetUserId: sub.user_id, targetResourceType: "homework_submission", targetResourceId: submissionId });
    return json({ ok: true, pending: parked.pending });
  } catch (e) {
    await logHealth(admin, "teacher_voice_request_failed", { submission_id: submissionId, error: String((e as any)?.message ?? e) }, { source: "teacher-voice-request", actorUserId: uid });
    return json({ error: "internal_error" }, 500);
  }
});
