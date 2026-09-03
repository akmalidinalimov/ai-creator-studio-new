// bitrix-lead-sync — internal (pg_cron) BACKSTOP that re-forwards landing leads the instant submit-lead push
// missed (Bitrix outage / transient error), so a captured lead is never stuck out of the CRM. It is the
// "reconciler re-derives from the source-of-truth table" leg behind the instant path in submit-lead.
// verify_jwt=false + x-internal-secret gated (only pg_cron may call it). Dormant when BITRIX_WEBHOOK_URL is
// unset. Idempotent: only ever touches leads where bitrix_synced=false, and stamps under a still-false guard.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, json, logHealth } from "../_shared/edge.ts";
import { verifyInternalSecret } from "../_shared/internal-secret.ts";
import { addBitrixLead } from "../_shared/bitrix.ts";

const LOOKBACK_DAYS = 14; // heal recent leads; older ones are handled manually (see the migration's retro-mark)
const BATCH = 50;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  if (!(await verifyInternalSecret(req, admin))) return json({ error: "forbidden" }, 403);

  const webhook = Deno.env.get("BITRIX_WEBHOOK_URL");
  if (!webhook) return json({ ok: true, dormant: true }); // not configured yet — nothing to do

  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString();
  // Settle window: never touch a lead younger than 5 min, so the drainer can't race the instant submit-lead
  // forward into a duplicate Bitrix lead. A genuinely-failed forward is simply retried a few minutes later.
  const settle = new Date(Date.now() - 5 * 60_000).toISOString();

  const { data: rows, error } = await admin
    .from("leads")
    .select("id, name, phone, source")
    .eq("bitrix_synced", false)
    .gte("created_at", cutoff)
    .lt("created_at", settle)
    .order("created_at", { ascending: true })
    .limit(BATCH);
  if (error) return json({ error: "query_failed", desc: error.message }, 500);

  let synced = 0, failed = 0, skipped = 0;
  for (const l of (rows || [])) {
    const b = await addBitrixLead(webhook, { name: l.name, phone: l.phone, source: l.source });
    if (b.ok) {
      // Stamp only if still unsynced — a concurrent instant-forward may have just synced it (guards against a
      // double stamp; the rare "Bitrix add succeeded but stamp lost" case can leave a duplicate, Bitrix-dedupable).
      const { data: upd } = await admin.from("leads")
        .update({ bitrix_synced: true, bitrix_lead_id: b.id, bitrix_synced_at: new Date().toISOString(), bitrix_error: null })
        .eq("id", l.id).eq("bitrix_synced", false).select("id").maybeSingle();
      if (upd) {
        synced++;
        await logHealth(admin, "bitrix_lead_synced", { source: l.source, bitrix_lead_id: b.id, reconciled: true },
          { source: "bitrix-lead-sync", targetResourceType: "lead", targetResourceId: l.id });
      } else {
        skipped++; // another path won it
      }
    } else {
      failed++;
      await admin.from("leads").update({ bitrix_error: `${b.status}:${b.error}` }).eq("id", l.id);
      await logHealth(admin, "bitrix_lead_failed", { source: l.source, status: b.status, error: b.error, terminal: b.terminal, reconciled: true },
        { source: "bitrix-lead-sync", targetResourceType: "lead", targetResourceId: l.id });
    }
  }

  return json({ ok: true, candidates: (rows || []).length, synced, failed, skipped });
});
