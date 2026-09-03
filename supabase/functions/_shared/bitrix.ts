// Shared Bitrix24 CRM lead push. One place so submit-lead (the instant path) and bitrix-lead-sync (the
// drainer/retry) build the identical crm.lead.add call. Dormant BY CONSTRUCTION: callers read the webhook
// URL from the BITRIX_WEBHOOK_URL env secret and skip entirely when it's unset — the lead still lives in our
// leads table and admins are still DM'd, so nothing is ever lost while Bitrix is unconfigured or down.
//
// The webhook URL is an inbound-webhook base like https://<portal>.bitrix24.ru/rest/1/<code>/ (with or
// without a trailing slash). It is a secret (grants CRM write) — keep it in the env/Vault, never in code.

export interface BitrixResult {
  ok: boolean;
  id?: string; // Bitrix lead id on success
  status: number; // HTTP status (0 = network error / thrown)
  error?: string; // error_description / error / http_<status>
  terminal: boolean; // bad webhook / no scope / auth — retrying won't help
}

// "https://x.bitrix24.ru/rest/1/CODE" (± trailing slash) → ".../crm.lead.add.json"
function methodUrl(base: string, method: string): string {
  return `${base.trim().replace(/\/+$/, "")}/${method}.json`;
}

export async function addBitrixLead(
  webhookUrl: string,
  lead: { name: string; phone: string; source?: string; comments?: string },
): Promise<BitrixResult> {
  const fields: Record<string, unknown> = {
    TITLE: `Landing lead: ${lead.name}`.slice(0, 250),
    NAME: lead.name,
    PHONE: [{ VALUE: lead.phone, VALUE_TYPE: "WORK" }],
    SOURCE_ID: "WEB",
    SOURCE_DESCRIPTION: (lead.source ? `aicreator.academy (${lead.source})` : "aicreator.academy").slice(0, 250),
    OPENED: "Y",
  };
  if (lead.comments) fields.COMMENTS = lead.comments.slice(0, 2000);

  let status = 0;
  try {
    const res = await fetch(methodUrl(webhookUrl, "crm.lead.add"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields, params: { REGISTER_SONET_EVENT: "Y" } }),
      signal: AbortSignal.timeout(5000), // don't let a slow/hanging Bitrix stall the landing submit or the drainer loop
    });
    status = res.status;
    const data = await res.json().catch(() => ({} as Record<string, unknown>));
    if (res.ok && data && (data as { result?: unknown }).result) {
      return { ok: true, id: String((data as { result: unknown }).result), status, terminal: false };
    }
    // Bitrix returns HTTP 200 with {error, error_description} on a logical error, or a 4xx for a dead/no-scope
    // webhook. `terminal` flags auth/scope/dead-webhook so the health signal reads "fix the webhook" vs
    // "transient" — it is INFORMATIONAL; the drainer keeps retrying either way, so once a bad webhook is
    // corrected the backlog heals (a permanently dead webhook just keeps the watchdog alarming, as intended).
    // Only Bitrix's own {error,error_description} is surfaced — never the request URL (which holds the secret).
    const err = (data as { error?: string; error_description?: string });
    const error = err?.error_description || err?.error || `http_${status}`;
    const terminal = status === 401 || status === 403 || status === 404
      || /INVALID_CREDENTIALS|insufficient_scope|ACCESS_DENIED|NO_AUTH_FOUND|invalid_token|PORTAL_DELETED/i.test(String(err?.error || ""));
    return { ok: false, status, error: String(error).slice(0, 300), terminal };
  } catch (e) {
    // SECURITY: a thrown fetch error (DNS/TLS/timeout/connection-refused) embeds the full request URL — which
    // contains the secret webhook code — in its message. NEVER surface that into leads.bitrix_error /
    // admin_actions: reduce to the error CLASS only. status stays 0 (already means "network/timeout").
    const kind = (e as Error)?.name === "TimeoutError" ? "timeout" : "network_error";
    return { ok: false, status, error: kind, terminal: false };
  }
}
