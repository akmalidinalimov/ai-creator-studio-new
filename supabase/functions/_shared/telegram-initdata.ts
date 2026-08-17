// Validate a Telegram Mini App `initData` string server-side.
//
// Algorithm (Telegram standard, audited identical to tg-group-board's proven copy):
//   secret = HMAC_SHA256(key="WebAppData", msg=bot_token)
//   hash   = HMAC_SHA256(key=secret,       msg=data_check_string)
// where data_check_string = the params MINUS ONLY `hash`, sorted by key, joined "k=v" with "\n".
// IMPORTANT: `signature` (Telegram's Ed25519 field, 2025+) STAYS in the data-check-string for the
// bot-token HMAC. Only the *third-party* Ed25519 verification excludes both hash AND signature; the
// bot-token `hash` is computed over "all received fields" except `hash`. Deleting `signature` here
// makes the HMAC hash fewer fields than Telegram did → guaranteed mismatch on every modern client.
// Enforces a freshness window on `auth_date` (default 1h; the mint endpoint passes 600s = 10 min).
//
// Returns the SIGNED user (id/username/first_name — trustworthy, part of the checked payload) and the
// `start_param` deep-link value. NEVER trust the raw string on the client; only this server check counts.

export interface TgInitUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TgInitResult {
  ok: boolean;
  user?: TgInitUser;
  startParam?: string;
  authDate?: number;
  /** Set when ok=false and the signature was valid but the payload was stale — lets callers return "expired". */
  expired?: boolean;
}

/** Constant-time string compare (avoids leaking the correct hash via response timing). */
function ctEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function validateInitData(
  initData: string,
  botToken: string,
  maxAgeSec = 3600,
): Promise<TgInitResult> {
  if (!initData || !botToken) return { ok: false };
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false };
  params.delete("hash"); // only `hash` is removed; `signature` (if present) STAYS in the data-check-string.

  const dcs = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const enc = new TextEncoder();
  const wk = await crypto.subtle.importKey("raw", enc.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secret = new Uint8Array(await crypto.subtle.sign("HMAC", wk, enc.encode(botToken)));
  const sk = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", sk, enc.encode(dcs)));
  const hex = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  if (!ctEq(hex, hash)) return { ok: false };

  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate) return { ok: false };
  if (Date.now() / 1000 - authDate > maxAgeSec) return { ok: false, expired: true };

  try {
    const user = JSON.parse(params.get("user") || "{}");
    if (!user?.id) return { ok: false };
    return {
      ok: true,
      authDate,
      startParam: params.get("start_param") || undefined,
      user: {
        id: Number(user.id),
        username: user.username || undefined,
        first_name: user.first_name || undefined,
        last_name: user.last_name || undefined,
      },
    };
  } catch {
    return { ok: false };
  }
}
