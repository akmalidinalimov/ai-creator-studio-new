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

    if (!Array.isArray(students) || students.length === 0) {
      return new Response(JSON.stringify({ error: "students[] required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const results: Array<{ email: string; status: string; password?: string; userId?: string; error?: string; action_link?: string | null }> = [];
    for (const s of students) {
      let email = (s.email || "").trim().toLowerCase();
      // Normalize telegram_user_id early so we can synthesize an email if needed
      let tgIdNum: number | undefined;
      if (s.telegram_user_id !== undefined && s.telegram_user_id !== null && String(s.telegram_user_id) !== "") {
        const n = typeof s.telegram_user_id === "string" ? Number(s.telegram_user_id) : s.telegram_user_id;
        if (Number.isFinite(n) && Number.isInteger(n) && (n as number) > 0) tgIdNum = n as number;
      }
      // If no email but we have a telegram id, synthesize a placeholder so auth.admin.createUser accepts it.
      // Login will happen via the Telegram bot which matches profiles by telegram_id.
      if (!email && tgIdNum) {
        email = `tg-${tgIdNum}@telegram.local`;
      }
      if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
        results.push({ email: s.email || "", status: "invalid_email" });
        continue;
      }
      // Password is always optional; generate one if not provided. Magic link / Telegram bot are the real login paths.
      const passwordProvided = !!(s.password && s.password.length >= 6);
      const password = passwordProvided ? s.password! : genPassword();
      const { data: created, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { name: s.name || email.split("@")[0], last_name: s.last_name || null },
      });
      if (error) {
        results.push({ email, status: "error", error: error.message });
        continue;
      }
      const userId = created.user!.id;
      const profilePatch: Record<string, any> = { name: s.name || email.split("@")[0] };
      if (s.last_name !== undefined) profilePatch.last_name = s.last_name || null;
      if (s.telegram_username) profilePatch.telegram_username = s.telegram_username.replace(/^@/, "");
      if (tgIdNum !== undefined) {
        // Pre-check uniqueness to give a clean error
        const { data: dup } = await admin.from("profiles").select("id").eq("telegram_id", tgIdNum).neq("id", userId).maybeSingle();
        if (dup) {
          results.push({ email, status: "error", error: `telegram_id ${tgIdNum} already in use` });
          await admin.auth.admin.deleteUser(userId).catch(() => {});
          continue;
        }
        profilePatch.telegram_id = tgIdNum;
      }
      const { error: profErr } = await admin.from("profiles").update(profilePatch).eq("id", userId);
      if (profErr) {
        results.push({ email, status: "error", error: profErr.message });
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
      });
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

    return new Response(JSON.stringify({ ok: true, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
