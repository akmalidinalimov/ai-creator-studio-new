// Uptime/health canary. Run by pg_cron every ~15 min. Checks the live frontend,
// a backend read, and recent cron health; on failure DMs all admins via Telegram.
// Alerts only on a healthy->down transition and re-alerts hourly while down
// (state stored in app_settings) so an outage doesn't spam.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { verifyInternalSecret } from "../_shared/internal-secret.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

const SITE = "https://aicreator.academy";
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";

async function tg(chatId: number, text: string) {
  if (!BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  }).catch(() => {});
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  // Rotation-safe: re-fetches internal_fn_secret() on mismatch (was a raw env-var compare → env/Vault drift risk).
  if (!(await verifyInternalSecret(req, admin))) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const url = Deno.env.get("SUPABASE_URL")!;
  const failures: string[] = [];

  // 1) Frontend is up and serving the app bundle.
  try {
    const r = await fetch(SITE + "/", { redirect: "follow" });
    const body = await r.text();
    if (!r.ok) failures.push(`frontend HTTP ${r.status}`);
    else if (!/assets\/index/.test(body)) failures.push("frontend served but app bundle missing");
  } catch (e) { failures.push(`frontend unreachable: ${e instanceof Error ? e.message : e}`); }

  // 2) Backend read path (anon) works.
  try {
    const r = await fetch(`${url}/rest/v1/courses?select=id&limit=1`, { headers: { apikey: anon, Authorization: `Bearer ${anon}` } });
    if (!r.ok) failures.push(`backend courses read HTTP ${r.status}`);
  } catch (e) { failures.push(`backend unreachable: ${e instanceof Error ? e.message : e}`); }

  // 3) Cron health — any job failing in the last 90 min.
  try {
    const { data } = await admin.rpc("recent_cron_failures");
    const n = Array.isArray(data) ? data.length : (data ?? 0);
    if (n && Number(n) > 0) failures.push(`${n} cron job failure(s) in last 90m`);
  } catch (_) { /* rpc optional */ }

  const ok = failures.length === 0;

  // De-dupe alerting via app_settings state.
  const { data: st } = await admin.from("app_settings").select("value").eq("key", "canary_state").maybeSingle();
  const prev = (st?.value as any) || { down: false, last_alert: 0 };
  const now = Date.now();
  let shouldAlert = false;
  if (!ok) {
    const firstDown = !prev.down;
    const staleHour = now - (prev.last_alert || 0) > 3600_000;
    shouldAlert = firstDown || staleHour;
  }
  const recovered = ok && prev.down;

  if (shouldAlert || recovered) {
    const { data: admins } = await admin
      .from("profiles").select("telegram_id, user_roles!inner(role)")
      .not("telegram_id", "is", null)
      .in("user_roles.role", ["admin", "superadmin"]);
    const msg = recovered
      ? `✅ aicreator.academy recovered — all checks passing.`
      : `🚨 aicreator.academy health check FAILED:\n• ${failures.join("\n• ")}`;
    for (const a of (admins || []) as any[]) {
      if (a.telegram_id) await tg(Number(a.telegram_id), msg);
    }
  }

  await admin.from("app_settings").upsert(
    { key: "canary_state", value: { down: !ok, last_alert: (shouldAlert ? now : (prev.last_alert || 0)), checked_at: new Date().toISOString(), failures } },
    { onConflict: "key" },
  );

  return new Response(JSON.stringify({ ok, failures }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
