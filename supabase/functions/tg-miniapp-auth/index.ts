// tg-miniapp-auth — the Telegram Mini App auth bridge (PUBLIC, verify_jwt=false).
//
// POST { initData } → { session:{access_token,refresh_token}, target_path } | { error }
//
// Flow: validate initData HMAC (24h freshness) → resolve/link profile (resolve.ts) → mint a Supabase
// session (mint-session.ts) → return it. The frontend calls supabase.auth.setSession(...) and the whole
// existing app then works via RLS. Trust is 100% the server-side HMAC — this endpoint is unauthenticated
// by design. NEVER log initData.
//
// DEPLOY GOTCHA: the deploy pipeline only redeploys a function when a file in ITS OWN folder changes.
// This fn imports ../_shared/telegram-initdata.ts, which is bundled at deploy time — so a fix to that
// shared file does NOT reach prod until this index.ts is also touched. Keep that in mind before relying
// on a shared-validator change here.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { validateInitData } from "../_shared/telegram-initdata.ts";
import { isChatMember } from "../_shared/telegram-membership.ts";
import { mintSessionForUser } from "../_shared/mint-session.ts";
import { resolveProfile, type ResolveDeps, type StudentMatch } from "./resolve.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";

// Freshness window for initData's `auth_date`. The HMAC is the real authenticity proof; this only
// bounds replay of a captured payload. Telegram clients REUSE one launch initData for the whole
// lifetime of the open Mini App (auth_date = first launch, not per-request), so a tight window
// rejects legitimate reuse — a tester who reopens the app an hour later still sends the old
// auth_date. 24h is the industry-standard bound (was 600s, which caused false "expired" 401s).
const MAX_INITDATA_AGE_SEC = 86400;

/** PII-free reject diagnostic — logs the failure CLASS + field NAMES + auth_date age. NEVER values/initData. */
function logReject(initData: string, expired: boolean) {
  try {
    const p = new URLSearchParams(initData);
    const ad = Number(p.get("auth_date") || 0);
    console.log("tg-miniapp-auth reject " + JSON.stringify({
      reason: expired ? "expired" : "invalid",
      hasHash: p.has("hash"),
      hasSignature: p.has("signature"),
      keys: [...p.keys()].sort(),                       // field names only (user/auth_date/hash/…), not values
      ageSec: ad ? Math.round(Date.now() / 1000 - ad) : null,
      initLen: initData.length,
    }));
  } catch { /* best-effort */ }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// Best-effort per-instance guards (edge functions may run several warm instances; the HMAC is the real
// security boundary — these just blunt abuse/quota exhaustion).
const rl = new Map<string, number[]>();            // telegram_id -> recent attempt timestamps
const memberCache = new Map<string, { v: boolean | null; t: number }>();

function rateLimited(tgId: number): boolean {
  const now = Date.now();
  const key = String(tgId);
  const arr = (rl.get(key) || []).filter((t) => now - t < 60_000);
  arr.push(now);
  rl.set(key, arr);
  return arr.length > 10; // >10 attempts / minute / telegram_id
}

async function cachedIsMember(chatId: number, tgId: number): Promise<boolean | null> {
  const key = `${chatId}:${tgId}`;
  const c = memberCache.get(key);
  if (c && Date.now() - c.t < 60_000) return c.v;
  const v = await isChatMember(BOT_TOKEN, chatId, tgId);
  memberCache.set(key, { v, t: Date.now() });
  return v;
}

// Where the Mini App lands after auth. An explicit `start_param` deep-link always wins (student
// paths), so a teacher who followed e.g. a ?startapp=hw link still reaches homework. Only the
// DEFAULT (no/unknown start_param) is role-aware: staff land on the teacher Mini App, students on
// their dashboard (unchanged).
function targetPath(startParam: string | undefined, isStaff: boolean): string {
  switch (startParam) {
    case "hw":
    case "homework": return "/homework";
    case "leaderboard": return "/leaderboard";
    case "profile": return "/profile";
    default: return isStaff ? "/tg/teacher" : "/dashboard";
  }
}

function makeDeps(admin: SupabaseClient): ResolveDeps {
  return {
    findByTelegramId: async (tgId) => {
      const { data } = await admin.from("profiles").select("id, email").eq("telegram_id", tgId).maybeSingle();
      return data?.email ? { id: data.id as string, email: data.email as string } : null;
    },

    findStudentUsernameOnly: async (username) => {
      const { data: rows } = await admin.from("profiles")
        .select("id, email, group_id")
        .is("telegram_id", null)
        .ilike("telegram_username", username); // exact (no wildcards) = case-insensitive exact match
      if (!rows || rows.length === 0) return null;
      if (rows.length > 1) return { ambiguous: true };
      const s = rows[0] as { id: string; email: string; group_id: string | null };

      // STUDENT-only: staff (teacher/admin/superadmin) profiles are never auto-linked by username.
      const { data: roles } = await admin.from("user_roles").select("role").eq("user_id", s.id);
      const roleList = (roles || []).map((r: { role: string }) => r.role);
      const isStudent = roleList.includes("student");
      const isStaff = roleList.some((r) => r === "teacher" || r === "admin" || r === "superadmin");
      if (!isStudent || isStaff) return null;

      // Resolve the group's telegram chat id from the latest captured message in that group.
      let chatId: number | null = null;
      if (s.group_id) {
        const { data: gme } = await admin.from("group_message_events")
          .select("telegram_chat_id").eq("group_id", s.group_id)
          .order("sent_at", { ascending: false }).limit(1).maybeSingle();
        chatId = (gme?.telegram_chat_id as number) ?? null;
      }
      return { id: s.id, email: s.email, group_id: s.group_id, group_chat_id: chatId } as StudentMatch;
    },

    isMember: cachedIsMember,

    linkTelegramId: async (profileId, tgId, username) => {
      await admin.from("profiles").update({
        telegram_id: tgId,
        telegram_username: username || null,
        updated_at: new Date().toISOString(),
      }).eq("id", profileId).is("telegram_id", null);
      await admin.from("admin_actions").insert({
        actor_user_id: null,
        action: "username_link_via_miniapp",
        details: { profile_id: profileId, telegram_id: tgId, telegram_username: username || null, at: new Date().toISOString() },
      }).then(() => {}, () => {});
    },

    // First-time link → DM up to 3 admins a reversible alert (cso Finding 1). Best-effort.
    alertFirstLink: async (profileId, tgId, username) => {
      try {
        const { data: p } = await admin.from("profiles").select("name, last_name").eq("id", profileId).maybeSingle();
        const nm = [p?.name, p?.last_name].filter(Boolean).join(" ") || "Talaba";
        const { data: staff } = await admin.from("user_roles").select("user_id").in("role", ["admin", "superadmin"]);
        const ids = (staff || []).map((r: { user_id: string }) => r.user_id);
        if (!ids.length) return;
        const { data: admins } = await admin.from("profiles").select("telegram_id").in("id", ids).not("telegram_id", "is", null).limit(3);
        for (const a of (admins || [])) {
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: (a as { telegram_id: number }).telegram_id,
              text: `🔗 <b>${nm}</b> Mini App orqali hisobiga bog'landi (telegram_id ${tgId}${username ? " · @" + username : ""}).\nAgar bu u bo'lmasa — profiles.id <code>${profileId}</code> uchun telegram_id ni tozalang.`,
              parse_mode: "HTML",
            }),
          }).catch(() => {});
        }
      } catch { /* best-effort */ }
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (!BOT_TOKEN) return json({ error: "not_configured" }, 500);

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const initData = String((body as { initData?: unknown })?.initData || "");

  const v = await validateInitData(initData, BOT_TOKEN, MAX_INITDATA_AGE_SEC);
  if (!v.ok || !v.user) {
    logReject(initData, !!v.expired);
    return json({ error: v.expired ? "expired" : "invalid" }, 401);
  }
  if (rateLimited(v.user.id)) return json({ error: "rate_limited" }, 429);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const outcome = await resolveProfile(makeDeps(admin), { id: v.user.id, username: v.user.username });
  if (outcome.kind === "not_linked") return json({ error: "not_linked" }, 403);

  let session;
  try {
    session = await mintSessionForUser(admin, outcome.email);
  } catch (_e) {
    console.error("tg-miniapp-auth mint failed for profile", outcome.profileId); // never log initData
    return json({ error: "mint_failed" }, 500);
  }

  // Non-PII success trace: auth_date age proves whether the old 10-min window would have rejected this.
  console.log("tg-miniapp-auth ok " + JSON.stringify({
    ageSec: v.authDate ? Math.round(Date.now() / 1000 - v.authDate) : null,
    backfilled: outcome.backfilled,
  }));

  await admin.from("admin_actions").insert({
    actor_user_id: null,
    action: "miniapp_signin",
    details: { profile_id: outcome.profileId, backfilled: outcome.backfilled, at: new Date().toISOString() },
  }).then(() => {}, () => {});

  // Role-aware landing: teacher/admin/superadmin default to the teacher Mini App (/tg/teacher).
  // An explicit student start_param still wins inside targetPath(). Best-effort — a role read
  // failure falls back to the student default (never blocks sign-in).
  let isStaff = false;
  try {
    const { data: roleRows } = await admin.from("user_roles").select("role").eq("user_id", outcome.profileId);
    isStaff = (roleRows || []).some((r: { role: string }) => r.role === "teacher" || r.role === "admin" || r.role === "superadmin");
  } catch { /* fall back to student default */ }

  return json({ session, target_path: targetPath(v.startParam, isStaff) });
});
