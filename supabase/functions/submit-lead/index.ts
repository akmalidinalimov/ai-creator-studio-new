// submit-lead: public lead capture for the challenge landing ("/" Split Hero).
// verify_jwt=false — the landing is anonymous (called via the /sb same-origin proxy so it lands even
// when the client can't reach supabase.co directly). Persists the lead (service role) and DMs admins
// via the shared sendTelegram (any non-delivery is DB-visible by construction). Always returns friendly
// JSON and never leaks internals. Honeypot + validation + caps + flood/dedupe guard the anon endpoint.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, json, logHealth } from "../_shared/edge.ts";
import { sendTelegram } from "../_shared/telegram-send.ts";
import { addBitrixLead } from "../_shared/bitrix.ts";

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

    // Atomic per-phone dedupe via the PARTIAL unique index uq_leads_dedupe (dedupe_key = phone + ~10-min
    // bucket; the index is `WHERE dedupe_key IS NOT NULL`). PostgREST's upsert `onConflict` CANNOT name a
    // partial index — Postgres raises "there is no unique or exclusion constraint matching the ON CONFLICT
    // specification", which 500'd EVERY submit since the leads feature shipped (2026-08-28) and is why the
    // landing form showed "Yuborishda xatolik" and `leads` stayed empty. Insert directly and treat a 23505
    // unique-violation as an already-captured no-op — the codebase's partial-index dedupe pattern
    // (cf. uq_dm_submission_teacher_msg: insert + 23505-skip, never upsert-onConflict).
    const dedupe_key = `${phone}:${Math.floor(Date.now() / 600_000)}`;
    const { data: rows, error: insErr } = await admin.from("leads")
      .insert({ name, phone, source, user_agent, ip, dedupe_key })
      .select("id");
    if (insErr) {
      if ((insErr as { code?: string }).code === "23505") return json({ ok: true }); // duplicate within the bucket — already captured
      await logHealth(admin, "lead_insert_failed", { source, error: insErr.message }, { source: "submit-lead" });
      return json({ ok: false, error: "save" }, 500);
    }
    const lead = rows && rows[0];
    if (!lead) return json({ ok: true }); // no row returned — treat as already captured

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

    // Forward to Bitrix24 CRM — best-effort, AFTER the lead is safely persisted and admins are DM'd, so a
    // Bitrix outage never loses or blocks a lead. Dormant until BITRIX_WEBHOOK_URL is set (goes live with no
    // code change). A failure leaves bitrix_synced=false → the bitrix-lead-sync drainer re-forwards it, and
    // the failure is DB-visible (bitrix_lead_failed + bitrix_error) so the watchdog can alert on a backlog.
    try {
      const webhook = Deno.env.get("BITRIX_WEBHOOK_URL");
      if (webhook) {
        const b = await addBitrixLead(webhook, { name, phone, source });
        if (b.ok) {
          await admin.from("leads").update({
            bitrix_synced: true, bitrix_lead_id: b.id, bitrix_synced_at: new Date().toISOString(), bitrix_error: null,
          }).eq("id", lead.id);
          await logHealth(admin, "bitrix_lead_synced", { source, bitrix_lead_id: b.id },
            { source: "submit-lead", targetResourceType: "lead", targetResourceId: lead.id });
        } else {
          await admin.from("leads").update({ bitrix_error: `${b.status}:${b.error}` }).eq("id", lead.id);
          await logHealth(admin, "bitrix_lead_failed", { source, status: b.status, error: b.error, terminal: b.terminal },
            { source: "submit-lead", targetResourceType: "lead", targetResourceId: lead.id });
        }
      }
    } catch (e) {
      console.error("submit-lead bitrix", e);
    }

    return json({ ok: true });
  } catch (e) {
    console.error("submit-lead", e);
    return json({ ok: false }, 500);
  }
});
