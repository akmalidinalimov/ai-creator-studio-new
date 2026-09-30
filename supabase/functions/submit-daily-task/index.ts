// submit-daily-task — the Mini App's «Kunlik vazifalar» (Challenge 6.0 Daily Tasks PR-7). The logic, its contract with
// the SQL engine and the capture view are documented in ./core.ts; this file is only the HTTP + client wiring.
//
//   POST application/json { mode: "prepare", task_id?: number }
//        → { ok, reason, detail, task, submission, open_tasks, topic_url, text, limits }   (read-only)
//   POST multipart/form-data  task_id, request_id, text?, files[] (0..10)
//        → 200 { ok, result: <challenge_task_payload>, posted, failed } | 202 { ok, pending } | 4xx/5xx { error, … }
//
// Auth: the caller's Supabase session JWT (the Mini App gets it from tg-miniapp-auth). No config.toml entry, so the
// platform default verify_jwt=true applies (spec F8) — the gateway refuses a request without a valid JWT, and this
// function resolves the user from it again (never trusting a user id in the body). Engine calls use the service
// role (the Mini App RPCs are service_role-only); every one passes the resolved user id.
//
// INERT until platform_settings.challenge_tasks.enabled AND .miniapp are true: prepare_miniapp answers
// 'disabled' / 'miniapp_off' and nothing is posted.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { json, corsHeaders, logHealth, logHealthOnce } from "../_shared/edge.ts";
import { sendMediaGroupMultipart, sendTelegramMultipartWithResult, sendTelegramWithResult } from "../_shared/telegram-send.ts";
import { type Deps, handlePrepare, handleSubmit, parseForm, type Profile } from "./core.ts";

const SOURCE = "submit-daily-task";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // The caller, from their JWT (never logged).
  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!jwt) return json({ error: "unauthorized" }, 401);
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: who, error: authErr } = await userClient.auth.getUser(jwt);
  if (authErr || !who?.user) return json({ error: "unauthorized" }, 401);
  const userId = who.user.id;

  const postOpts = (chatId: unknown) => ({
    admin,
    purpose: "challenge_task_miniapp_post",
    recipientId: typeof chatId === "number" || typeof chatId === "string" ? chatId : null,
    topicMissingAction: "challenge_task_topic_missing",
  });
  const deps: Deps = {
    admin,
    poster: {
      text: (fields) => sendTelegramWithResult(BOT_TOKEN, "sendMessage", fields, postOpts(fields.chat_id)),
      single: (method, fields, file) => sendTelegramMultipartWithResult(BOT_TOKEN, method, fields, [file], postOpts(fields.chat_id)),
      album: (fields, items) => sendMediaGroupMultipart(BOT_TOKEN, fields, items, postOpts(fields.chat_id)),
    },
    health: async (action, details, uid) => {
      await logHealth(admin, action, details, { source: SOURCE, targetUserId: uid });
    },
    healthOnce: async (action, key, details, uid) => {
      await logHealthOnce(admin, action, key, details, { source: SOURCE, targetUserId: uid });
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };

  const contentType = (req.headers.get("content-type") || "").toLowerCase();
  try {
    if (!contentType.includes("multipart/form-data")) {
      const body = await req.json().catch(() => null) as { mode?: unknown; task_id?: unknown } | null;
      if (!body || body.mode !== "prepare") return json({ error: "bad_request" }, 400);
      const tid = Number(body.task_id);
      const taskId = body.task_id == null ? null : (Number.isSafeInteger(tid) && tid > 0 ? tid : NaN);
      if (Number.isNaN(taskId)) return json({ error: "bad_task_id" }, 400);
      const r = await handlePrepare(deps, userId, taskId as number | null);
      return json(r.body, r.status);
    }

    if (!BOT_TOKEN) {
      await logHealth(admin, "challenge_task_miniapp_rpc_failed", { stage: "bot_token_missing" }, { source: SOURCE, targetUserId: userId });
      return json({ error: "unavailable" }, 503);
    }
    let form: FormData;
    try { form = await req.formData(); } catch { return json({ error: "bad_form" }, 400); }
    const input = parseForm(form);

    const { data: prof, error: profErr } = await admin.from("profiles")
      .select("name, last_name, telegram_username").eq("id", userId).maybeSingle();
    if (profErr) console.error("submit-daily-task: profile read failed (header falls back to a neutral name)", profErr.message);
    const r = await handleSubmit(deps, userId, input, (prof ?? null) as Profile | null);
    return json(r.body, r.status);
  } catch (e) {
    // Never a silent 500: the class of failure is DB-visible (no request content, no secrets).
    await logHealth(admin, "challenge_task_miniapp_rpc_failed", { stage: "unhandled", error: String((e as Error)?.message ?? e).slice(0, 300) },
      { source: SOURCE, targetUserId: userId });
    return json({ error: "internal_error" }, 500);
  }
});
