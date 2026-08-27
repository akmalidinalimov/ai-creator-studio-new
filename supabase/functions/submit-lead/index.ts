// submit-lead: public lead capture for the challenge landing ("/" Split Hero).
// verify_jwt=false — the landing is anonymous (called via the /sb same-origin proxy so it lands even
// when the client can't reach supabase.co directly). Persists the lead (service role) and DMs admins
// via the shared sendTelegram (any non-delivery is DB-visible by construction). Always returns friendly
// JSON and never leaks internals. Honeypot + validation + caps + flood/dedupe guard the anon endpoint.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, json, logHealth } from "../_shared/edge.ts";
import { sendTelegram } from "../_shared/telegram-send.ts";

const cap = (s: unknown, n: number): string => {
  const t = s === null || s === undefined ? "" : String(s);
  return t.length > n ? t.slice(0, n) : t;
};
const digitCount = (s: string) => (s.match(/\d/g) || []).length;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false }, 405);
  if (Number(req.headers.get("content-length") || 0) > 10_000) return json({ ok: true }); // oversized → ignore

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const body = await req.json().catch(() => ({}));

    // Honeypot: a real user never fills this hidden field. Silently accept so bots don't learn.
    if (cap(body?.company, 100).trim() !== "") return json({ ok: true });

    const name = cap(body?.name, 120).trim();
    const phone = cap(body?.phone, 40).trim();
    const source = cap(body?.source, 40).trim() || "landing";
    if (!name || !phone || digitCount(phone) < 7) return json({ ok: false, error: "invalid" }, 400);

    const ip = (req.headers.get("cf-connecting-ip")
      || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "").slice(0, 100);
    const user_agent = cap(req.headers.get("user-agent"), 300);

    // Global flood shield (fail-open — a rate-check error must never drop a real lead).
    try {
      const { count: recent } = await admin.from("leads").select("id", { count: "exact", head: true })
        .gt("created_at", new Date(Date.now() - 60_000).toISOString());
      if ((recent || 0) > 120) return json({ ok: true });
    } catch (e) {
      console.error("submit-lead floodcheck", e);
    }

    // Atomic per-phone dedupe: a unique index on dedupe_key (phone + ~10-min bucket) makes a
    // double-tap / retry a no-op at the DB level (upsert → ON CONFLICT DO NOTHING), so it can't
    // create a second row or a second admin DM. The read-then-insert race is closed in the DB.
    const dedupe_key = `${phone}:${Math.floor(Date.now() / 600_000)}`;
    const { data: rows, error: insErr } = await admin.from("leads")
      .upsert({ name, phone, source, user_agent, ip, dedupe_key }, { onConflict: "dedupe_key", ignoreDuplicates: true })
      .select("id");
    if (insErr) {
      await logHealth(admin, "lead_insert_failed", { source, error: insErr.message }, { source: "submit-lead" });
      return json({ ok: false, error: "save" }, 500);
    }
    const lead = rows && rows[0];
    if (!lead) return json({ ok: true }); // deduped (same phone within the bucket) — already captured

    // Notify admins (best-effort). sendTelegram records any non-delivery to admin_actions; a fn crash
    // before this leaves notified=false, which the leads_watchdog catches. Plain text (no parse_mode)
    // so a name/phone can never break formatting or inject markup.
    let notified = 0;
    try {
      const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
      if (token) {
        const { data: roles } = await admin.from("user_roles").select("user_id").in("role", ["admin", "superadmin"]);
        const ids = (roles || []).map((r: { user_id: string }) => r.user_id);
        if (ids.length) {
          const { data: profs } = await admin.from("profiles").select("telegram_id").in("id", ids).not("telegram_id", "is", null);
          const chatIds = Array.from(new Set((profs || []).map((p: { telegram_id: number | string }) => p.telegram_id).filter(Boolean)));
          const text = `🆕 Yangi lead (challenge)\nIsm: ${name}\nTelefon: ${phone}\nManba: ${source}`;
          for (const chat_id of chatIds) {
            const out = await sendTelegram(token, "sendMessage", { chat_id, text }, {
              admin, purpose: "lead_notify", recipientId: chat_id as string | number,
            });
            if (out.ok) notified++;
          }
        }
      }
    } catch (e) {
      console.error("submit-lead notify", e);
    }

    if (notified > 0) {
      await admin.from("leads").update({ notified: true }).eq("id", lead.id);
    }
    await logHealth(admin, "lead_captured", { source, notified },
      { source: "submit-lead", targetResourceType: "lead", targetResourceId: lead.id });

    return json({ ok: true });
  } catch (e) {
    console.error("submit-lead", e);
    return json({ ok: false }, 500);
  }
});
