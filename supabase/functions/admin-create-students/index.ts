// Admin-only: create / delete users + send magic-link invites + audit logging.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type Student = {
  name?: string;
  last_name?: string;
  email: string;
  password?: string;
  telegram_username?: string;
  telegram_user_id?: number | string;
  role?: "student" | "admin";
  group_name?: string;
};

function genPassword(): string {
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%";
  let out = "";
  for (let i = 0; i < 18; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function logAdminAction(admin: any, actor_user_id: string, action: string, opts: {
  target_user_id?: string;
  target_resource_type?: string;
  target_resource_id?: string;
  details?: Record<string, unknown>;
} = {}) {
  try {
    await admin.from("admin_actions").insert({
      actor_user_id,
      action,
      target_user_id: opts.target_user_id ?? null,
      target_resource_type: opts.target_resource_type ?? null,
      target_resource_id: opts.target_resource_id ?? null,
      details: opts.details ?? {},
    });
  } catch (e) {
    console.error("admin_actions insert failed", e);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const PUB_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(SUPABASE_URL, PUB_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: who } = await userClient.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!who?.user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: roleRow } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", who.user.id)
      .eq("role", "admin")
      .maybeSingle();
    if (!roleRow) {
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const actorId = who.user.id;

    // DELETE: remove a user
    if (req.method === "DELETE") {
      const { userId } = await req.json();
      if (!userId) return new Response(JSON.stringify({ error: "userId required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      await logAdminAction(admin, actorId, "remove_user", { target_user_id: userId });
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const body = await req.json();
    const action: string | undefined = body.action;

    // Resend welcome / magic-link to existing user
    if (action === "resend_welcome") {
      const email: string = (body.email || "").trim().toLowerCase();
      const redirectTo: string = body.redirectTo || `${SUPABASE_URL}`;
      if (!email) return new Response(JSON.stringify({ error: "email required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      const { data: linkData, error } = await admin.auth.admin.generateLink({
        type: "magiclink",
        email,
        options: { redirectTo },
      });
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      await logAdminAction(admin, actorId, "resend_welcome_email", { details: { email } });
      return new Response(JSON.stringify({ ok: true, action_link: (linkData as any)?.properties?.action_link || null }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Clear soft-lockout for an email
    if (action === "clear_lockout") {
      const email: string = (body.email || "").trim().toLowerCase();
      if (!email) return new Response(JSON.stringify({ error: "email required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      const since = new Date(Date.now() - 30 * 60_000).toISOString();
      await admin.from("login_attempts").delete().eq("kind", "email").eq("key", email).gte("created_at", since);
      await logAdminAction(admin, actorId, "clear_lockout", { details: { email } });
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const students: Student[] = body.students;
    const courseId: string | undefined = body.courseId;
    const courseIds: string[] = Array.isArray(body.courseIds) ? body.courseIds : (courseId ? [courseId] : []);
    const sendInvite: boolean = !!body.send_invite;
    const redirectTo: string = body.redirectTo || `${SUPABASE_URL}/reset-password`;
    const isCsvImport: boolean = !!body.csv_import;
    const targetGroupId: string | null = body.target_group_id || null;

    // Resolve fallback default group once (used when row has no group_name and no target_group_id)
    let defaultGroupId: string | null = null;
    {
      const { data: dg } = await admin.from("groups").select("id").eq("is_default", true).maybeSingle();
      defaultGroupId = (dg as any)?.id || null;
    }

    if (!Array.isArray(students) || students.length === 0) {
      return new Response(JSON.stringify({ error: "students[] required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Resolve / auto-create groups by name (case-insensitive). Cache to avoid duplicate work.
    const groupCache = new Map<string, string>(); // lowerName -> id
    let defaultCourseForGroup: string | null = null;
    const resolveGroupId = async (rawName?: string): Promise<string | null> => {
      const nm = (rawName || "").trim();
      if (!nm) return null;
      const key = nm.toLowerCase();
      if (groupCache.has(key)) return groupCache.get(key)!;
      const { data: existing } = await admin.from("groups").select("id,name").ilike("name", nm).maybeSingle();
      if (existing?.id) { groupCache.set(key, existing.id); return existing.id; }
      if (defaultCourseForGroup === null) {
        const { data: cs } = await admin.from("courses").select("id").limit(2);
        defaultCourseForGroup = (cs && cs.length === 1) ? cs[0].id : "";
      }
      const { data: ins, error: insErr } = await admin.from("groups")
        .insert({ name: nm, course_id: defaultCourseForGroup || null, teacher_id: null })
        .select("id").single();
      if (insErr || !ins) { console.error("group create failed", nm, insErr); return null; }
      groupCache.set(key, ins.id);
      return ins.id;
    };

    const results: Array<{ email: string; status: string; password?: string; userId?: string; error?: string; action_link?: string | null; row_index?: number; identifier_used?: string }> = [];
    const requestId = (crypto as any).randomUUID ? (crypto as any).randomUUID() : `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const auditLog = (row_index: number, identifier_used: string, action: string, error?: string) => {
      console.log(JSON.stringify({ scope: "admin-create-students", request_id: requestId, row_index, identifier_used, action, ...(error ? { error } : {}) }));
    };
    // Sanitize an arbitrary string into an Auth-safe email local part: lowercase ASCII alphanumerics, dot, underscore, hyphen.
    const sanitizeForEmailLocal = (raw: string): string => {
      return (raw || "")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^\x00-\x7F]/g, "") // strip non-ASCII (Cyrillic, emoji, etc.)
        .replace(/[^a-z0-9._-]/g, "") // keep only safe local-part chars
        .replace(/^[._-]+|[._-]+$/g, "") // trim leading/trailing punctuation
        .slice(0, 32);
    };
    // Deterministic short hash for anonymous fallback placeholders.
    const shortHash = async (s: string): Promise<string> => {
      const buf = new TextEncoder().encode(s);
      const digest = await crypto.subtle.digest("SHA-256", buf);
      const bytes = Array.from(new Uint8Array(digest)).slice(0, 6);
      return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
    };

    for (let __i = 0; __i < students.length; __i++) {
      const s = students[__i];
      const row_index = __i + 1;
      let email = (s.email || "").trim().toLowerCase();
      // Normalize telegram_user_id early so we can synthesize an email if needed.
      // Tolerate quoted/whitespace/decorated values like " 12345 ", "'12345'", or "id:12345".
      let tgIdNum: number | undefined;
      if (s.telegram_user_id !== undefined && s.telegram_user_id !== null && String(s.telegram_user_id) !== "") {
        const raw = String(s.telegram_user_id).trim().replace(/^["']|["']$/g, "");
        const digits = raw.replace(/[^\d]/g, "");
        if (digits.length > 0 && digits.length <= 18) {
          const n = Number(digits);
          if (Number.isFinite(n) && Number.isInteger(n) && n > 0) tgIdNum = n;
        }
      }
      // Normalize telegram_username early so we can use it as a placeholder identifier
      const tgUserNorm = (s.telegram_username || "").trim().replace(/^@/, "").toLowerCase();
      const tgUserSafe = sanitizeForEmailLocal(tgUserNorm);
      let synthesizedEmail = "";
      let synthesizedFrom: "telegram_user_id" | "telegram_username" | "name_hash" | "" = "";
      // If no email but we have a telegram id or username, synthesize a placeholder so auth.admin.createUser accepts it.
      // Login will happen via the Telegram bot which matches profiles by telegram_id OR telegram_username.
      if (!email) {
        if (tgIdNum) {
          synthesizedEmail = `tg-${tgIdNum}@telegram.local`;
          synthesizedFrom = "telegram_user_id";
        } else if (tgUserSafe) {
          synthesizedEmail = `tg-${tgUserSafe}@telegram.local`;
          synthesizedFrom = "telegram_username";
        } else {
          // Last-resort deterministic placeholder so rows with only a non-ASCII name still import.
          // Use a hash, never the raw name, because names are not unique and collide in Auth.
          const seed = `${(s.name || "").trim()}|${(s.last_name || "").trim()}|${tgUserNorm}|${s.telegram_user_id ?? ""}`;
          if (seed.replace(/\|/g, "").length > 0) {
            const h = await shortHash(seed);
            synthesizedEmail = `tg-anon-${h}@telegram.local`;
            synthesizedFrom = "name_hash";
          }
        }
        email = synthesizedEmail;
      }
      // Compute the identifier_used label early for audit logs
      const identifier_used = (s.email || "").trim()
        || (tgIdNum ? `tg_id:${tgIdNum}` : "")
        || (tgUserNorm ? `@${tgUserNorm}` : "")
        || (s.name ? `name:${s.name}` : "")
        || "(empty)";

      if (!email || !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)) {
        const err = "could not synthesize a valid email (need email, telegram_user_id, or ASCII telegram_username)";
        results.push({ email: s.email || "", status: "invalid_email", error: err, row_index, identifier_used });
        auditLog(row_index, identifier_used, "failed", err);
        continue;
      }
      // Password is always optional; generate one if not provided. Magic link / Telegram bot are the real login paths.
      const passwordProvided = !!(s.password && s.password.length >= 6);
      const password = passwordProvided ? s.password! : genPassword();
      // Resolve target group: explicit row group_name → target_group_id → default
      let resolvedGroupId: string | null = null;
      if (s.group_name && s.group_name.trim()) resolvedGroupId = await resolveGroupId(s.group_name);
      if (!resolvedGroupId && targetGroupId) resolvedGroupId = targetGroupId;
      if (!resolvedGroupId && defaultGroupId) resolvedGroupId = defaultGroupId;

      // Smart dedupe: if a profile already exists by email, telegram_username, telegram_id, or synthesized placeholder,
      // update its group instead of creating a new auth user.
      let existingId: string | null = null;
      let existingGroupId: string | null = null;
      if (email) {
        const { data: e1 } = await admin.from("profiles").select("id, group_id").eq("email", email).maybeSingle();
        if (e1) { existingId = (e1 as any).id; existingGroupId = (e1 as any).group_id || null; }
      }
      if (!existingId && tgUserNorm) {
        const { data: e2 } = await admin.from("profiles").select("id, group_id").eq("telegram_username", tgUserNorm as any).maybeSingle();
        if (e2) { existingId = (e2 as any).id; existingGroupId = (e2 as any).group_id || null; }
      }
      if (!existingId && tgIdNum) {
        const { data: e3 } = await admin.from("profiles").select("id, group_id").eq("telegram_id", tgIdNum).maybeSingle();
        if (e3) { existingId = (e3 as any).id; existingGroupId = (e3 as any).group_id || null; }
      }
      if (existingId) {
        const alreadyInTargetGroup = !!resolvedGroupId && existingGroupId === resolvedGroupId;
        const patch: Record<string, any> = {};
        if (resolvedGroupId && !alreadyInTargetGroup) patch.group_id = resolvedGroupId;
        if (Object.keys(patch).length) await admin.from("profiles").update(patch).eq("id", existingId);
        const status = alreadyInTargetGroup ? "skipped_already_in_group" : "updated";
        results.push({ email, status, userId: existingId, row_index, identifier_used });
        auditLog(row_index, identifier_used, alreadyInTargetGroup ? "skipped_already_in_group" : "matched");
        continue;
      }

      const { data: created, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { name: s.name || email.split("@")[0], last_name: s.last_name || null },
      });
      if (error) {
        const friendly = /validate email|invalid format/i.test(error.message)
          ? `invalid_placeholder_email (${email}) — auth rejected synthesized email`
          : error.message;
        results.push({ email, status: "error", error: friendly, row_index, identifier_used });
        auditLog(row_index, identifier_used, "failed", friendly);
        continue;
      }
      const userId = created.user!.id;
      const profilePatch: Record<string, any> = { name: s.name || email.split("@")[0] };
      if (s.last_name !== undefined) profilePatch.last_name = s.last_name || null;
      if (s.telegram_username) profilePatch.telegram_username = s.telegram_username.replace(/^@/, "");
      if (tgIdNum !== undefined) {
        const { data: dup } = await admin.from("profiles").select("id").eq("telegram_id", tgIdNum).neq("id", userId).maybeSingle();
        if (dup) {
          const err = `telegram_id ${tgIdNum} already in use`;
          results.push({ email, status: "error", error: err, row_index, identifier_used });
          auditLog(row_index, identifier_used, "failed", err);
          await admin.auth.admin.deleteUser(userId).catch(() => {});
          continue;
        }
        profilePatch.telegram_id = tgIdNum;
      }
      if (resolvedGroupId) profilePatch.group_id = resolvedGroupId;
      const { error: profErr } = await admin.from("profiles").update(profilePatch).eq("id", userId);
      if (profErr) {
        results.push({ email, status: "error", error: profErr.message, row_index, identifier_used });
        auditLog(row_index, identifier_used, "failed", profErr.message);
        await admin.auth.admin.deleteUser(userId).catch(() => {});
        continue;
      }

      if (s.role === "admin") {
        await admin.from("user_roles").insert({ user_id: userId, role: "admin" });
      }

      for (const cid of courseIds) {
        await admin.from("enrollments").upsert(
          { user_id: userId, course_id: cid },
          { onConflict: "user_id,course_id" },
        );
      }

      // Magic-link invite if requested OR if no password was provided.
      // Skip for synthetic placeholder emails (Telegram-only users) — they log in via the bot.
      const isPlaceholderEmail = email.endsWith("@telegram.local");
      let action_link: string | null = null;
      if (!isPlaceholderEmail && (sendInvite || !passwordProvided)) {
        try {
          const { data: linkData } = await admin.auth.admin.generateLink({
            type: "magiclink",
            email,
            options: { redirectTo },
          });
          action_link = (linkData as any)?.properties?.action_link || null;
        } catch (e) {
          console.error("generateLink failed for", email, e);
        }
      }

      results.push({
        email,
        status: "created",
        userId,
        password: passwordProvided ? password : undefined,
        action_link,
        row_index,
        identifier_used,
      });
      auditLog(row_index, identifier_used, "created");
    }

    if (isCsvImport) {
      await logAdminAction(admin, actorId, "csv_import_users", {
        details: { total: students.length, created: results.filter((r) => r.status === "created").length },
      });
    } else {
      // Single create
      const created = results.find((r) => r.status === "created");
      if (created) {
        await logAdminAction(admin, actorId, "create_user", {
          target_user_id: created.userId,
          details: { email: created.email, role: students[0]?.role || "student" },
        });
      }
    }

    // Reconciliation: compare csv input rows vs DB state for the target group
    const csv_rows = students.length;
    let group_count_after: number | null = null;
    let delta = 0;
    if (targetGroupId) {
      const { count } = await admin.from("profiles").select("id", { count: "exact", head: true }).eq("group_id", targetGroupId);
      group_count_after = count ?? 0;
    }
    const successful = results.filter(r => r.status === "created" || r.status === "updated" || r.status === "skipped_already_in_group").length;
    delta = csv_rows - successful;
    console.log(JSON.stringify({ scope: "admin-create-students", request_id: requestId, action: "summary", csv_rows, group_count_after, results_total: results.length, created: results.filter(r => r.status === "created").length, updated: results.filter(r => r.status === "updated").length, skipped: results.filter(r => r.status === "skipped_already_in_group").length, errors: results.filter(r => r.status === "error" || r.status === "invalid_email").length }));

    return new Response(JSON.stringify({ ok: true, results, request_id: requestId, csv_rows, group_count_after, delta }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
