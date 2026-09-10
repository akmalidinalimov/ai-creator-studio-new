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
import { sendTelegram } from "../_shared/telegram-send.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE_TTL_MS = 15 * 60_000; // mirrors the grading flow's own conversation TTL

const escHtml = (s = "") => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

type Locale = "uz" | "ru" | "en";
function normLocale(code?: string | null): Locale {
  const l = (code || "").toLowerCase().slice(0, 2);
  if (l === "ru") return "ru";
  if (l === "en") return "en";
  return "uz";
}
// Mirrors telegram-bot-webhook's gvAsk copy so the teacher sees one consistent prompt.
const ASK: Record<Locale, (student: string, title: string) => string> = {
  uz: (s, t) => `🎤 <b>${s}</b> — ${t}\n\nOvozli izohingizni shu yerga yuboring (yoki /cancel):`,
  ru: (s, t) => `🎤 <b>${s}</b> — ${t}\n\nОтправьте сюда голосовой комментарий (или /cancel):`,
  en: (s, t) => `🎤 <b>${s}</b> — ${t}\n\nSend your voice feedback here (or /cancel):`,
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

    const { data: a } = await admin.from("homework_assignments").select("title").eq("id", sub.assignment_id).maybeSingle();
    const studentName = [stu?.name, stu?.last_name].filter(Boolean).join(" ") || "—";
    const locale = normLocale(me?.preferred_locale);

    // --- Park the conversation state the webhook's grade_voice handler consumes — WITHOUT clobbering a flow
    // she is in the middle of in the bot (the webhook's standing rule: never clobber awaiting_name /
    // confirm_name / an in-bot grading session). bot_conversation_state is ONE row per telegram_id, so:
    //   1) a plain INSERT wins when she has no state at all;
    //   2) otherwise an ATOMIC conditional UPDATE takes the row only if it is a previous grade_voice request
    //      (re-pointing to the newest card is intended), a non-flow cache row, or already expired.
    // Anything else is a live flow → 409 `busy`, and the grading screen asks her to finish or /cancel it. ---
    const nowIso = new Date().toISOString();
    const parked = {
      state: "grade_voice",
      context: { submission_id: submissionId },
      updated_at: nowIso,
      expires_at: new Date(Date.now() + STATE_TTL_MS).toISOString(),
    };
    const { error: insErr } = await admin.from("bot_conversation_state").insert({ telegram_id: teacherTg, ...parked });
    if (insErr) {
      if ((insErr as any).code !== "23505") throw insErr;
      // Timestamp is double-quoted: `.` and `:` are reserved characters inside a PostgREST or() filter.
      const { data: took, error: upErr } = await admin.from("bot_conversation_state")
        .update(parked)
        .eq("telegram_id", teacherTg)
        .or(`state.eq.grade_voice,state.eq.nm_cache,expires_at.lt."${nowIso}"`)
        .select("telegram_id")
        .maybeSingle();
      if (upErr) throw upErr;
      if (!took) {
        await logHealth(admin, "teacher_voice_request_busy", { submission_id: submissionId }, { source: "teacher-voice-request", actorUserId: uid, targetResourceId: submissionId });
        return json({ error: "busy" }, 409);
      }
    }

    // --- Prompt them in the bot chat. If this can't be delivered the flow is dead, so surface it. ---
    const out = await sendTelegram(
      BOT_TOKEN,
      "sendMessage",
      { chat_id: teacherTg, text: ASK[locale](escHtml(studentName), escHtml(a?.title || "")), parse_mode: "HTML" },
      { admin, purpose: "teacher_voice_prompt", recipientId: teacherTg },
    );
    if (!out.ok) {
      // Roll the state back — leaving it parked would silently swallow the teacher's NEXT unrelated message.
      await admin.from("bot_conversation_state").delete().eq("telegram_id", teacherTg).eq("state", "grade_voice");
      return json({ error: "prompt_failed", recipient: out.recipient }, 502);
    }

    await logHealth(admin, "teacher_voice_requested", { submission_id: submissionId }, { source: "teacher-voice-request", actorUserId: uid, targetUserId: sub.user_id, targetResourceType: "homework_submission", targetResourceId: submissionId });
    return json({ ok: true });
  } catch (e) {
    await logHealth(admin, "teacher_voice_request_failed", { submission_id: submissionId, error: String((e as any)?.message ?? e) }, { source: "teacher-voice-request", actorUserId: uid });
    return json({ error: "internal_error" }, 500);
  }
});
