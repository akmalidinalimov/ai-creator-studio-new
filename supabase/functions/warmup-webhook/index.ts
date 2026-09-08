// warmup-webhook — Telegram ingestion for the warm-up bot. HTTP wrapper only; the work is in
// ingest.ts so it can be tested without binding a port.
//
// ONE JOB: get the update into warmup.events and answer Telegram, fast. No plugin runs here, no
// send, no pack requirement. Telegram redelivers anything it does not get a prompt answer to, so
// work done in this handler turns into duplicate updates and eventually a throttled webhook.
// Everything downstream happens in warmup-dispatch.
//
// This is a SECOND bot. It never touches telegram-bot-webhook, never shares its token, and writes
// only to the warmup schema.
//
// THE KILL SWITCH DOES NOT APPLY HERE, deliberately. platform_settings.warmup stops the bot
// TALKING (checked in warmup-dispatch and warmup-drainer), not listening. If ingestion stopped
// too, every reaction and comment during the outage would be lost for good — Telegram stops
// redelivering — and turning the switch back on would reveal a hole in the ledger nobody can
// backfill. Recording is cheap; silence is the reversible part.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, json } from "../_shared/edge.ts";
import { loadActivePack } from "../_warmup/pack.ts";
import { ingestUpdate } from "./ingest.ts";
import type { CampaignPack } from "../_warmup/types.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// Telegram echoes this on every delivery. The endpoint runs with verify_jwt=false, so this header
// is the only thing separating a real delivery from anyone who guesses the URL.
const WEBHOOK_SECRET = Deno.env.get("WARMUP_WEBHOOK_SECRET") || "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  if (!WEBHOOK_SECRET) {
    // Refuse to run wide open: an unauthenticated ingest endpoint would let anyone forge
    // participants, reactions and therefore points.
    console.error("warmup-webhook: WARMUP_WEBHOOK_SECRET is not set — refusing all updates");
    return json({ error: "webhook_secret_not_configured" }, 503);
  }
  if (req.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
    return json({ error: "forbidden" }, 403);
  }

  let update: Record<string, unknown>;
  try {
    update = await req.json();
  } catch {
    return json({ ok: true, note: "unparseable_body_ignored" });
  }

  // Best-effort: the pack only refines classification (question tag, task hashtags, command
  // aliases, code words). Without it the pack-independent subset still lands, so an update is
  // never lost because content has not been uploaded yet.
  let pack: CampaignPack | null = null;
  try {
    pack = await loadActivePack(admin);
  } catch (e) {
    console.warn("warmup-webhook: no pack, normalising pack-independent subset only",
                 String((e as Error)?.message ?? e));
  }

  const result = await ingestUpdate(admin, pack, update);

  if (result.error) {
    // Answer with a failure so Telegram redelivers. The insert is idempotent, so a retry is safe,
    // and losing the update is worse than a retry.
    console.error("warmup-webhook: events insert failed", result.error, { updateId: update.update_id });
    return json({ ok: false, error: "ingest_failed" }, 500);
  }

  return json({ ok: true, ingested: result.ingested, deduped: result.deduped });
});
