// staff-intake: passwordless sales-intake form (the /intake?code=... link handed to
// sales staff). Gated by a shared access code (x-intake-code, checked against
// INTAKE_ACCESS_CODE with a constant-time compare) exactly like sheet-sync's
// x-sheet-secret — NO user session. Serves the course/tier/group dropdowns
// (action:"options") and adds ONE student (course + tier + group) via the proven
// admin-create-students engine, then sets tier + phone and audit-logs (no staff actor).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-intake-code, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const USERNAME_RE = /^@?[A-Za-z0-9_]{4,32}$/;
const norm = (s: unknown) => String(s ?? "").trim();

// Constant-time string compare (avoid leaking the code via timing).
const ctEq = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Auth: the shared access code from the /intake link. Defaults to the legacy
    // code so existing links keep working; set INTAKE_ACCESS_CODE to rotate.
    const CODE = Deno.env.get("INTAKE_ACCESS_CODE") || "aicreators2026";
    const provided = req.headers.get("x-intake-code") || "";
    if (!provided || !ctEq(provided, CODE)) return json({ error: "forbidden" }, 403);

    const body = await req.json().catch(() => null);

    // Dropdown options for the form (no login → served here, code-gated).
    if (body?.action === "options") {
      const [{ data: courses }, { data: tiers }, { data: groups }] = await Promise.all([
        admin.from("courses").select("id, title").order("title"),
        admin.from("course_tiers").select("id, course_id, name, position").order("position"),
        admin.from("groups").select("course_id, name").order("name"),
      ]);
      return json({ courses: courses || [], tiers: tiers || [], groups: groups || [] });
    }
    const actorId: string | null = null; // passwordless link — no staff actor
    const name = norm(body?.name);
    const last_name = norm(body?.last_name);
    const username = norm(body?.telegram_username);
    const course_id = norm(body?.course_id);
    const tier_id = body?.tier_id ? norm(body?.tier_id) : null;
    const group_name = norm(body?.group_name);
    const phone = norm(body?.phone);
    const email = norm(body?.email);
    const confirmMove = body?.confirm_move === true;

    if (!name || !username || !course_id || !group_name) {
      return json({ error: "missing_field", message: "name, telegram_username, course_id and group_name are required" }, 400);
    }
    if (!USERNAME_RE.test(username)) return json({ error: "bad_username", message: "Telegram username looks invalid" }, 400);

    // course must exist; tier (if given) must belong to it.
    const { data: course } = await admin.from("courses").select("id").eq("id", course_id).maybeSingle();
    if (!course) return json({ error: "unknown_course" }, 400);
    if (tier_id) {
      const { data: tier } = await admin.from("course_tiers").select("id").eq("id", tier_id).eq("course_id", course_id).maybeSingle();
      if (!tier) return json({ error: "unknown_tier" }, 400);
    }

    // Move guard: if this student already exists in a DIFFERENT group, don't move
    // them silently — return "exists_in_other_group" so the salesperson can confirm.
    // Skipped when confirm_move=true (they've chosen the target group).
    if (!confirmMove) {
      const unameNorm = username.replace(/^@/, "").toLowerCase();
      const { data: cands } = await admin
        .from("profiles").select("id, group_id, telegram_username")
        .ilike("telegram_username", `%${unameNorm}%`).limit(10);
      const existing = (cands || []).find(
        (p: any) => String(p.telegram_username ?? "").replace(/^@/, "").toLowerCase() === unameNorm,
      );
      if (existing?.group_id) {
        const { data: tgrp } = await admin
          .from("groups").select("id").eq("course_id", course_id).ilike("name", group_name).limit(1);
        const targetGroupId = (tgrp || [])[0]?.id ?? null;
        if (existing.group_id !== targetGroupId) {
          const { data: curg } = await admin.from("groups").select("name").eq("id", existing.group_id).maybeSingle();
          return json({ status: "exists_in_other_group", userId: existing.id, current_group: curg?.name ?? null });
        }
      }
    }

    // Internal secret for the server-to-server call into admin-create-students.
    let internalSecret = "";
    try { const { data } = await admin.rpc("internal_fn_secret"); internalSecret = String(data || ""); } catch (_e) { /* handled below */ }
    if (!internalSecret) return json({ error: "internal_secret_unavailable" }, 500);

    const resp = await fetch(`${SUPABASE_URL}/functions/v1/admin-create-students`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": internalSecret,
        "Authorization": `Bearer ${SERVICE_KEY}`,
        "apikey": SERVICE_KEY,
      },
      body: JSON.stringify({
        students: [{ name, last_name: last_name || undefined, email: email || undefined, telegram_username: username, role: "student", group_name }],
        courseIds: [course_id],
        target_course_id: course_id,
        csv_import: true,
      }),
    });
    const out = await resp.json().catch(() => ({}));
    const res0 = (out?.results || [])[0] || {};
    const status = res0.status || (resp.ok ? "unknown" : "error");
    const userId = res0.userId as string | undefined;
    if (!userId) return json({ status, message: res0.error || `HTTP ${resp.status}` }, resp.ok ? 200 : 502);

    // Tier + optional phone (idempotent) + audit with the real staff actor.
    await admin.rpc("set_enrollment_tier_system", { _user_id: userId, _course_id: course_id, _tier_id: tier_id });
    if (phone) await admin.from("profiles").update({ phone }).eq("id", userId);
    await admin.from("admin_actions").insert({
      actor_user_id: actorId, action: "staff_intake", target_user_id: userId,
      details: { course_id, tier_id, status },
    });

    return json({ status, userId });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
