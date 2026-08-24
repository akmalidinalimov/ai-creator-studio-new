// Domain-reputation monitor (2026-07-21). The counterpart to the firewall-block problem: you can't
// detect a Fortinet/AV block from the server (the blocked request never arrives), but you CAN detect
// the LEADING CAUSE — the domain getting (re-)flagged as malicious/phishing by a reputation feed —
// days before students hit a wall. Checks Google Safe Browsing (authoritative; drives Chrome/Android)
// + VirusTotal (aggregator), records each result to domain_reputation_checks, and DMs admins on a
// REGRESSION with the dispute pre-staged. De-duped via app_settings so a standing flag doesn't spam.
//   • Safe Browsing (serious — real browser blocks): alert on transition-to-flagged AND re-alert while
//     still flagged; recovery when cleared.
//   • VirusTotal (noisy aggregator): alert when the malicious count RISES (a new vendor), AND
//     re-remind ~daily while it stays ≥3 vendors (a standing flag that blocks students on firewall/AV
//     networks — the gap that let an 8-vendor flag sit silent for days); recovery when it hits zero.
//   • First run (no prior state) just seeds the baseline — never alerts (else day-one's existing ~11
//     VT flags would read as a false "+11 regression").
// Cron-invoked (x-internal-secret). Dormant until SAFE_BROWSING_API_KEY and/or VIRUSTOTAL_API_KEY
// exist (both free tiers) — same "dormant until secret" contract as the ops pipeline.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { sendTelegram } from "../_shared/telegram-send.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

const DOMAIN = "aicreator.academy";
const URLS = [`https://${DOMAIN}`, `https://www.${DOMAIN}`];
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";

async function tg(admin: any, chatId: number, text: string) {
  if (!BOT_TOKEN) return;
  await sendTelegram(
    BOT_TOKEN,
    "sendMessage",
    { chat_id: chatId, text, disable_web_page_preview: true },
    { admin, purpose: "reputation_alert", recipientId: chatId },
  );
}

// Google Safe Browsing v4 — the one that actually blocks Chrome/Android. Empty matches = clean.
// NOTE: the key rides in the query string, so a thrown error's message could contain it — we never
// persist the raw message (only a generic 'fetch_failed') to avoid a secret-at-rest.
async function checkSafeBrowsing(key: string): Promise<{ ok: boolean; flagged: boolean; detail: unknown }> {
  try {
    const r = await fetch(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client: { clientId: "aicreators", clientVersion: "1.0" },
        threatInfo: {
          threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"],
          platformTypes: ["ANY_PLATFORM"],
          threatEntryTypes: ["URL"],
          threatEntries: URLS.map((u) => ({ url: u })),
        },
      }),
    });
    if (!r.ok) return { ok: false, flagged: false, detail: { http: r.status } };
    const j = await r.json().catch(() => ({}));
    const matches = Array.isArray(j?.matches) ? j.matches : [];
    return { ok: true, flagged: matches.length > 0, detail: { matches: matches.map((m: any) => m.threatType) } };
  } catch (e) {
    console.error("safe_browsing fetch failed", e instanceof Error ? e.message : e);
    return { ok: false, flagged: false, detail: { error: "fetch_failed" } };
  }
}

// VirusTotal v3 domain report — last_analysis_stats.malicious(+suspicious) is the count we track.
async function checkVirusTotal(key: string): Promise<{ ok: boolean; malicious: number; detail: unknown }> {
  try {
    const r = await fetch(`https://www.virustotal.com/api/v3/domains/${DOMAIN}`, { headers: { "x-apikey": key } });
    if (!r.ok) return { ok: false, malicious: 0, detail: { http: r.status } };
    const j = await r.json().catch(() => ({}));
    const stats = j?.data?.attributes?.last_analysis_stats || {};
    return {
      ok: true,
      malicious: Number(stats.malicious || 0) + Number(stats.suspicious || 0),
      detail: { malicious: stats.malicious ?? null, suspicious: stats.suspicious ?? null, harmless: stats.harmless ?? null },
    };
  } catch (e) {
    console.error("virustotal fetch failed", e instanceof Error ? e.message : e);
    return { ok: false, malicious: 0, detail: { error: "fetch_failed" } };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.headers.get("x-internal-secret") !== Deno.env.get("INTERNAL_FN_SECRET")) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const SB_KEY = Deno.env.get("SAFE_BROWSING_API_KEY") || "";
  const VT_KEY = Deno.env.get("VIRUSTOTAL_API_KEY") || "";
  if (!SB_KEY && !VT_KEY) {
    return new Response(JSON.stringify({ ok: true, dormant: true, note: "no reputation API key set" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const sb = SB_KEY ? await checkSafeBrowsing(SB_KEY) : null;
  const vt = VT_KEY ? await checkVirusTotal(VT_KEY) : null;

  // Record every check (DB-visible health signal, per the incident doctrine) — including ok=false so
  // a broken monitor is at least visible in the table (and surfaced by the digest).
  const rows: any[] = [];
  if (sb) rows.push({ source: "safe_browsing", flagged: sb.flagged, malicious_count: sb.flagged ? 1 : 0, ok: sb.ok, detail: sb.detail });
  if (vt) rows.push({ source: "virustotal", flagged: vt.malicious > 0, malicious_count: vt.malicious, ok: vt.ok, detail: vt.detail });
  if (rows.length) { try { await admin.from("domain_reputation_checks").insert(rows); } catch { /* ignore */ } }

  // Prior state. First run (no row yet) only seeds the baseline — never alerts.
  const { data: st } = await admin.from("app_settings").select("value").eq("key", "reputation_state").maybeSingle();
  const firstRun = !st?.value;
  const prev = (st?.value as any) || { sb_flagged: false, vt_malicious: 0, last_alert: 0 };
  const now = Date.now();
  const SB_REALERT_MS = 3600_000;        // Safe Browsing: re-alert hourly while flagged (serious).
  const VT_REALERT_MS = 20 * 3600_000;   // VirusTotal: re-remind ~daily while a standing flag persists.
  const VT_STANDING_THRESHOLD = 3;       // A standing count this high blocks students on firewall/AV
                                         // networks (the 8-vendor flag that sat silent for days).
  const sbLastAlert = prev.sb_last_alert ?? prev.last_alert ?? 0; // migrate from the old single field
  const vtLastAlert = prev.vt_last_alert ?? 0;

  const alerts: string[] = [];
  const recoveries: string[] = [];
  let sbAlerted = false, vtAlerted = false;
  if (sb?.ok) {
    // Serious + persistent: alert on transition-to-flagged, and re-alert hourly while still flagged.
    if (sb.flagged && (!prev.sb_flagged || now - sbLastAlert > SB_REALERT_MS)) {
      alerts.push(`🚨 Google Safe Browsing endi ${DOMAIN} ni XAVFLI deb belgiladi (${(sb.detail as any)?.matches?.join(", ") || "threat"}). Bu Chrome/Android'da bloklanishga olib keladi — zudlik bilan e'tiroz bildiring: https://safebrowsing.google.com/safebrowsing/report_error/`);
      sbAlerted = true;
    } else if (!sb.flagged && prev.sb_flagged) {
      recoveries.push(`✅ Google Safe Browsing ${DOMAIN} ni tozaladi.`);
    }
  }
  if (vt?.ok) {
    const prevVt = prev.vt_malicious || 0;
    if (vt.malicious > prevVt) {
      // RISE: a genuinely new vendor flagged — alert immediately.
      alerts.push(`⚠️ VirusTotal'da yangi belgilashlar: ${vt.malicious} ta vendor ${DOMAIN} ni xavfli deb belgiladi (avval ${prevVt}). Yangi firewall bloklari ehtimoli — VirusTotal'ni tekshiring.`);
      vtAlerted = true;
    } else if (vt.malicious >= VT_STANDING_THRESHOLD && now - vtLastAlert > VT_REALERT_MS) {
      // STANDING: a persistent, student-blocking flag re-reminds ~daily until disputed/cleared. This
      // closes the gap that let an 8-vendor flag sit silent for days while students couldn't load the site.
      alerts.push(`⚠️ VirusTotal hali ham ${vt.malicious} ta vendor ${DOMAIN} ni xavfli deb belgilagan — talabalar tarmoqlarida (firewall/AV) sayt bloklanishi mumkin. E'tirozni davom ettiring: https://www.virustotal.com/gui/domain/${DOMAIN}`);
      vtAlerted = true;
    } else if (prevVt > 0 && vt.malicious === 0) {
      recoveries.push(`✅ VirusTotal ${DOMAIN} uchun toza.`);
    }
  }

  const shouldAlert = !firstRun && alerts.length > 0;
  const shouldRecover = !firstRun && !shouldAlert && recoveries.length > 0;

  if (shouldAlert || shouldRecover) {
    const { data: admins } = await admin
      .from("profiles").select("telegram_id, user_roles!inner(role)")
      .not("telegram_id", "is", null)
      .in("user_roles.role", ["admin", "superadmin"]);
    const msg = shouldAlert ? alerts.join("\n\n") : recoveries.join("\n");
    for (const a of (admins || []) as any[]) {
      if (a.telegram_id) await tg(admin, Number(a.telegram_id), msg);
    }
  }

  await admin.from("app_settings").upsert({
    key: "reputation_state",
    value: {
      sb_flagged: sb?.ok ? sb.flagged : (prev.sb_flagged || false),
      vt_malicious: vt?.ok ? vt.malicious : (prev.vt_malicious || 0),
      // Per-source alert clocks so SB (hourly) and VT (daily) cadences don't reset each other.
      sb_last_alert: (shouldAlert && sbAlerted) ? now : sbLastAlert,
      vt_last_alert: (shouldAlert && vtAlerted) ? now : vtLastAlert,
      last_alert: shouldAlert ? now : (prev.last_alert || 0), // legacy field, kept for compatibility
      checked_at: new Date().toISOString(),
    },
  }, { onConflict: "key" });

  return new Response(JSON.stringify({
    ok: true, seeded_baseline: firstRun,
    safe_browsing: sb ? { ok: sb.ok, flagged: sb.flagged } : "no key",
    virustotal: vt ? { ok: vt.ok, malicious: vt.malicious } : "no key",
    alerted: shouldAlert, recovered: shouldRecover,
  }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
