// staff-intake: passwordless sales-intake form (the /intake?code=... link handed to
// sales staff). Gated by a shared access code (x-intake-code, checked against
// INTAKE_ACCESS_CODE with a constant-time compare) exactly like sheet-sync's
// x-sheet-secret — NO user session. Serves the course/tier/group dropdowns
// (action:"options") and adds ONE student (course + tier + group) via the proven
// admin-create-students engine, then sets tier + phone and audit-logs (no staff actor, except an admin who
// overrides the cross-course move guard from their own signed-in session — see the move guard below).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { likeEscape } from "../_shared/username.ts";
import { logHealth } from "../_shared/edge.ts";
import {
  adminIdFromBearer,
  decideCourseMove,
  isCrossCourse,
  loadCourseMoveFacts,
  moveAuditDetails,
  REFUSED_STATUS,
} from "../_shared/course-move-guard.ts";
import { intakeMoveOutcome } from "./move.ts";

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
        // Open (published) courses first; closed ones stay listed so sales can pre-enroll a cohort
        // before launch — the form marks them, because their modules stay locked until published.
        admin.from("courses").select("id, title, published").order("published", { ascending: false }).order("title"),
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
    // Challenge 6.0: the Instagram handle is how a verified post is matched back to a student.
    // Optional — a missing handle only means that student can't earn Instagram points yet.
    const instagram = norm(body?.instagram_username);
    // Account type: 'paid' (full access) or 'provisional' (trial — homework/points/stats but
    // NO lessons). Defaults to 'paid' so an unset/legacy request never accidentally locks a payer.
    const account_type = norm(body?.account_type) === "provisional" ? "provisional" : "paid";
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

    // Move guard. If this student already exists in a DIFFERENT group, never move them silently.
    //  - Same course (e.g. 5.0 PRE -> 5.0 VIP): return "exists_in_other_group" so the salesperson confirms;
    //    confirm_move=true then moves them, as before.
    //  - Another course (e.g. 5.0 -> Challenge 6.0): REFUSED, even with confirm_move (PR-3a). Their waiting
    //    homework would follow them to the new course's teachers and the old teacher would lose it. Only a
    //    verified admin, signed in on this browser, may override (admin_override=true), and only with 0 waiting
    //    homework in the old course. Every refusal is written to admin_actions; the engine records the override.
    // Runs on EVERY submit (it used to be skipped on confirm_move), so a crafted confirm cannot skip it, and
    // admin-create-students re-checks at the write anyway.
    const adminOverride = body?.admin_override === true;
    let overrideAdminId: string | null = null;
    const unameNorm = username.replace(/^@/, "").toLowerCase();
    const { data: cands } = await admin
      .from("profiles").select("id, group_id, telegram_username")
      .ilike("telegram_username", `%${likeEscape(unameNorm)}`).limit(10);
    const existing = (cands || []).find(
      (p: any) => String(p.telegram_username ?? "").replace(/^@/, "").toLowerCase() === unameNorm,
    );
    if (existing?.group_id) {
      const { data: tgrp } = await admin
        .from("groups").select("id").eq("course_id", course_id).ilike("name", group_name).limit(1);
      const targetGroupId = (tgrp || [])[0]?.id ?? null;
      if (existing.group_id !== targetGroupId) {
        const facts = await loadCourseMoveFacts(admin, {
          userId: existing.id, fromGroupId: existing.group_id, toGroupId: targetGroupId, toCourseId: course_id,
        });
        // Whose session is this? Asked only for a move between courses (can_override / the override itself).
        const callerAdminId = isCrossCourse(facts) ? await adminIdFromBearer(admin, req.headers.get("Authorization")) : null;
        const verdict = decideCourseMove(facts, { requested: adminOverride, adminId: callerAdminId });
        const outcome = intakeMoveOutcome(facts, verdict, { confirmMove, callerAdminId, userId: existing.id });
        if (outcome.action === "respond") {
          if (outcome.refused) {
            await logHealth(admin, "cross_course_move_refused", moveAuditDetails(facts, {
              reason: outcome.refused, confirm_move: confirmMove, override_requested: adminOverride,
              caller: callerAdminId ? "admin_session" : "intake_code",
            }), {
              actorUserId: callerAdminId, targetUserId: existing.id,
              targetResourceType: "profile", targetResourceId: existing.id, source: "staff-intake",
            });
          }
          return json(outcome.body);
        }
        overrideAdminId = outcome.overrideAdminId;
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
        // The engine re-verifies this admin id and the 0-waiting rule at the write, then audits the override.
        ...(overrideAdminId ? { allow_cross_course_move: true, override_admin_id: overrideAdminId } : {}),
      }),
    });
    const out = await resp.json().catch(() => ({}));
    const res0 = (out?.results || [])[0] || {};
    const status = res0.status || (resp.ok ? "unknown" : "error");
    const userId = res0.userId as string | undefined;
    if (!userId) {
      // A refusal from the engine (e.g. the move guard firing at the write) keeps its details for the form.
      const extra = status === REFUSED_STATUS ? { reason: res0.reason ?? null, ...(res0.move || {}), can_override: false } : {};
      return json({ status, message: res0.error || `HTTP ${resp.status}`, ...extra }, resp.ok ? 200 : 502);
    }

    // Tier + account type + optional phone (idempotent) + audit with the real staff actor.
    await admin.rpc("set_enrollment_tier_system", { _user_id: userId, _course_id: course_id, _tier_id: tier_id });
    // Set account_type explicitly from the salesperson's choice: a partial-payer lands
    // 'provisional' (VIP/group + tier still assigned, so upgrading later just flips this flag and
    // lessons unlock). Re-submitting the same person as 'paid' after full payment upgrades them.
    const profileUpdate: Record<string, unknown> = { account_type };
    if (phone) profileUpdate.phone = phone;
    await admin.from("profiles").update(profileUpdate).eq("id", userId);
    // Written SEPARATELY and best-effort on purpose. Edge functions deploy BEFORE migrations in the
    // same run, so for a few seconds this code can be live while `instagram_username` does not exist
    // yet. Folding it into the update above would fail the whole write and cost the student their
    // tier and account type. The DB trigger normalizes "@name", spaces and profile URLs.
    if (instagram) {
      try {
        await admin.from("profiles").update({ instagram_username: instagram }).eq("id", userId);
      } catch (_e) { /* handle is a bonus, never block an enrolment */ }
    }
    await admin.from("admin_actions").insert({
      actor_user_id: overrideAdminId ?? actorId, action: "staff_intake", target_user_id: userId,
      details: { course_id, tier_id, account_type, status, ...(overrideAdminId ? { cross_course_override: true } : {}) },
    });

    return json({ status, userId, account_type, ...(overrideAdminId ? { cross_course_override: true } : {}) });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
