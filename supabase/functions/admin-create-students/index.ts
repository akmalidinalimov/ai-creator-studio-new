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
  role?: "student" | "teacher" | "admin";
  group_name?: string;
  account_type?: "provisional" | "paid";
};

function genPassword(): string {
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%";
  let out = "";
  for (let i = 0; i < 18; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// Constant-time string compare for secret headers (length check leaks only length).
function ctEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function logAdminAction(admin: any, actor_user_id: string | null, action: string, opts: {
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

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Auth: EITHER an internal system caller (valid x-internal-secret, e.g. sheet-sync) — actorId=null —
    // OR an admin user JWT (the web admin UI). The import logic below is identical for both.
    let actorId: string | null = null;
    let isSystem = false;
    let isSuperadmin = false;
    const internalSecretHeader = req.headers.get("x-internal-secret");
    if (internalSecretHeader) {
      try {
        const { data: sec } = await admin.rpc("internal_fn_secret");
        if (sec && ctEq(internalSecretHeader, String(sec))) isSystem = true;
      } catch (_e) { /* fall through to 403 */ }
      if (!isSystem) {
        return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }
    if (!isSystem) {
      const authHeader = req.headers.get("Authorization") || "";
      const userClient = createClient(SUPABASE_URL, PUB_KEY, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: who } = await userClient.auth.getUser(authHeader.replace("Bearer ", ""));
      if (!who?.user) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const { data: roleRow } = await admin
        .from("user_roles")
        .select("role")
        .eq("user_id", who.user.id)
        .eq("role", "admin")
        .maybeSingle();
      if (!roleRow) {
        return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      // Privilege-escalation guard (M12): only a superadmin may create/promote admins.
      const { data: saRow } = await admin
        .from("user_roles")
        .select("role")
        .eq("user_id", who.user.id)
        .eq("role", "superadmin")
        .maybeSingle();
      isSuperadmin = !!saRow;
      actorId = who.user.id;
    }

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
    const targetCourseId: string | null = body.target_course_id || null;

    // Resolve fallback default group once (used when row has no group_name and no target_group_id)
    let defaultGroupId: string | null = null;
    {
      const { data: dg } = await admin.from("groups").select("id").eq("is_default", true).maybeSingle();
      defaultGroupId = (dg as any)?.id || null;
    }

    // The course that name-resolved / auto-created groups belong to. Explicit target_course_id wins,
    // then the single courseId of this import, then the platform default-for-signup course. This is
    // what keeps a 5.0 "Group A" distinct from a 4.0 "Group A" instead of silently reusing the old one.
    let groupCourseId: string | null = targetCourseId || courseId || null;
    if (!groupCourseId) {
      const { data: dc } = await admin.from("courses").select("id").eq("is_default_for_signup", true).maybeSingle();
      groupCourseId = (dc as any)?.id || null;
    }

    if (!Array.isArray(students) || students.length === 0) {
      return new Response(JSON.stringify({ error: "students[] required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Resolve / auto-create groups by name (case-insensitive). Cache to avoid duplicate work.
    // v3.14.14: track which groups we auto-created so we can audit-log them and surface them
    // in the toast as "(yangi guruh yaratildi)".
    const groupCache = new Map<string, string>(); // lowerName -> id
    const groupNameById = new Map<string, string>(); // id -> canonical name
    const autoCreatedGroups: Array<{ id: string; name: string }> = [];
    const resolveGroupId = async (rawName?: string): Promise<string | null> => {
      const nm = (rawName || "").trim();
      if (!nm) return null;
      const key = nm.toLowerCase();
      if (groupCache.has(key)) return groupCache.get(key)!;
      // Look up the group BY NAME WITHIN THE TARGET COURSE so 4.0 "Group A" and 5.0 "Group A" are distinct.
      let lookup = admin.from("groups").select("id,name").ilike("name", nm);
      if (groupCourseId) lookup = lookup.eq("course_id", groupCourseId);
      const { data: existing } = await lookup.maybeSingle();
      if (existing?.id) {
        groupCache.set(key, existing.id);
        groupNameById.set(existing.id, (existing as any).name || nm);
        return existing.id;
      }
      const { data: ins, error: insErr } = await admin.from("groups")
        .insert({ name: nm, course_id: groupCourseId, teacher_id: null })
        .select("id,name").single();
      if (insErr || !ins) { console.error("group create failed", nm, insErr); return null; }
      groupCache.set(key, ins.id);
      groupNameById.set(ins.id, (ins as any).name || nm);
      autoCreatedGroups.push({ id: ins.id, name: (ins as any).name || nm });
      try {
        await admin.from("admin_actions").insert({
          actor_user_id: actorId,
          action: "auto_created_group",
          target_resource_type: "group",
          target_resource_id: ins.id,
          details: { name: nm, source: "csv_import", import_request_id: requestId },
        });
      } catch (e) { console.error("audit auto_created_group failed", e); }
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
      const inputEmail = (s.email || "").trim().toLowerCase();
      let email = inputEmail;
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
      // Account type: apply ONLY when explicitly provided (paid|provisional). Left undefined for
      // CSV/sheet imports (which never send it), so an import can never silently change — or downgrade —
      // an existing student's access. New users without it fall back to the column default ('paid').
      const acctType: "provisional" | "paid" | undefined =
        s.account_type === "provisional" || s.account_type === "paid" ? s.account_type : undefined;
      let synthesizedEmail = "";
      // Synthesize a deterministic placeholder in priority order: telegram_id → telegram_username → hashed name.
      // Never use the raw name in the email because names are not unique and collide in Auth.
      if (tgIdNum) {
        synthesizedEmail = `tg-${tgIdNum}@telegram.local`;
      } else if (tgUserSafe) {
        synthesizedEmail = `tg-${tgUserSafe}@telegram.local`;
      } else {
        // v3.14.12: anon fallback MUST be unique. Include random suffix so two anonymous
        // rows with identical name/last_name never collide on the Auth email.
        const rand = crypto.getRandomValues(new Uint8Array(6));
        const randHex = Array.from(rand).map((b) => b.toString(16).padStart(2, "0")).join("");
        const seed = `${(s.name || "").trim()}|${(s.last_name || "").trim()}|${tgUserNorm}|${s.telegram_user_id ?? ""}|${randHex}`;
        const h = await shortHash(seed);
        synthesizedEmail = `tg-anon-${h}${randHex.slice(0, 4)}@telegram.local`;
      }
      if (!email) email = synthesizedEmail;
      // Compute the identifier_used label early for audit logs
      const identifier_used = (s.email || "").trim()
        || (tgIdNum ? `tg_id:${tgIdNum}` : "")
        || (tgUserNorm ? `@${tgUserNorm}` : "")
        || (s.name ? `name:${s.name}` : "")
        || "(empty)";

      // Privilege-escalation guard (M12): only a superadmin may create or promote an
      // admin. Plain admins and system callers (sheet-sync /intake) cannot mint admins.
      if (s.role === "admin" && !isSuperadmin) {
        const err = "Only a superadmin can create or promote an admin.";
        results.push({ email, status: "forbidden", error: err, row_index, identifier_used });
        auditLog(row_index, identifier_used, "forbidden_admin_creation", err);
        continue;
      }

      if (!email || !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)) {
        const err = "could not synthesize a valid email (need email, telegram_user_id, or ASCII telegram_username)";
        results.push({ email: s.email || "", status: "invalid_email", error: err, row_index, identifier_used });
        auditLog(row_index, identifier_used, "failed", err);
        continue;
      }
      // Password is always optional; generate one if not provided. Magic link / Telegram bot are the real login paths.
      const passwordProvided = !!(s.password && s.password.length >= 6);
      const password = passwordProvided ? s.password! : genPassword();
      // Display name preserved AS-IS from CSV. No INITCAP, no tg- prefix, no fallback to email-local.
      // Only when csv.name is empty AND csv.telegram_username is present do we fall back to the
      // raw username (without @) as a display label. Never put "tg-" in front of a person's name.
      const csvName = (s.name || "").trim();
      const csvLastName = s.last_name === undefined ? undefined : (s.last_name || "").trim();
      const displayName = csvName || (tgUserNorm ? tgUserNorm : "");
      // Resolve target group: explicit row group_name → target_group_id → default.
      // v3.14.14: for master CSV imports (csv_import w/o target_group_id), DO NOT fall back to
      // the platform default group when group_name is empty — those rows go to "Guruhsiz".
      let resolvedGroupId: string | null = null;
      const rowHasGroupName = !!(s.group_name && s.group_name.trim());
      if (rowHasGroupName) resolvedGroupId = await resolveGroupId(s.group_name);
      if (!resolvedGroupId && targetGroupId) resolvedGroupId = targetGroupId;
      if (!resolvedGroupId && defaultGroupId && !(isCsvImport && !targetGroupId)) resolvedGroupId = defaultGroupId;

      // CSV telegram_username — preserve case, but ALWAYS strip leading "@" before storing.
      // The UI prepends "@" at render time; storing "@username" makes it render as "@@username".
      const csvTgUsernameRaw = (s.telegram_username || "").trim().replace(/^@+/, "");

      // Dedupe priority: telegram_id → telegram_username → (name + last_name pair, case-insensitive).
      // Email is optional metadata and intentionally NOT used for matching.
      let existingId: string | null = null;
      let existingGroupId: string | null = null;
      let existingTgUsername: string | null = null;
      // v3.14.35: also fetch existing email so we can match by email collision early.
      // Email-based match comes last (after tg_id, tg_username, name+last_name).
      if (tgIdNum) {
        const { data: e1 } = await admin.from("profiles").select("id, group_id, telegram_username").eq("telegram_id", tgIdNum).maybeSingle();
        if (e1) { existingId = (e1 as any).id; existingGroupId = (e1 as any).group_id || null; existingTgUsername = (e1 as any).telegram_username ?? null; }
      }
      if (!existingId && tgUserNorm) {
        const { data: e2 } = await admin.from("profiles").select("id, group_id, telegram_username").or(`telegram_username.eq.${tgUserNorm},telegram_username.eq.@${tgUserNorm}`).maybeSingle();
        if (e2) { existingId = (e2 as any).id; existingGroupId = (e2 as any).group_id || null; existingTgUsername = (e2 as any).telegram_username ?? null; }
      }
      // Soft re-import dedupe by (lower(name), lower(last_name)) — ONLY when CSV row has
      // NEITHER telegram_user_id NOR telegram_username. Otherwise different real people sharing
      // a generic name (e.g. "O'quvchi") would collapse into one profile. (v3.14.11)
      if (!existingId && !tgIdNum && !tgUserNorm && csvName && csvLastName) {
        const { data: e3 } = await admin
          .from("profiles")
          .select("id, group_id, telegram_username")
          .ilike("name", csvName)
          .ilike("last_name", csvLastName)
          .limit(2);
        if (e3 && e3.length === 1) {
          existingId = (e3[0] as any).id;
          existingGroupId = (e3[0] as any).group_id || null;
          existingTgUsername = (e3[0] as any).telegram_username ?? null;
        }
      }
      if (existingId) {
        // v3.14.35: enforce role exclusivity & duplicate-in-group BEFORE any mutation.
        const { data: existingRoles } = await admin.from("user_roles").select("role").eq("user_id", existingId);
        const roleSet = new Set<string>((existingRoles || []).map((r: any) => r.role));
        const isExistingTeacher = roleSet.has("teacher");
        const incomingRole = s.role || "student";

        if (incomingRole === "student" && isExistingTeacher) {
          const err = "Bu foydalanuvchi tizimda o'qituvchi sifatida ro'yxatdan o'tgan. Talaba qilib qo'shib bo'lmaydi.";
          results.push({ email, status: "role_conflict", error: err, userId: existingId, row_index, identifier_used });
          auditLog(row_index, identifier_used, "role_conflict_teacher_to_student");
          continue;
        }
        if (incomingRole === "teacher" && (roleSet.has("student") || (existingGroupId && !roleSet.has("teacher") && !roleSet.has("admin")))) {
          const err = "Bu foydalanuvchi tizimda talaba sifatida mavjud. O'qituvchi qilib qo'shib bo'lmaydi.";
          results.push({ email, status: "role_conflict", error: err, userId: existingId, row_index, identifier_used });
          auditLog(row_index, identifier_used, "role_conflict_student_to_teacher");
          continue;
        }

        const alreadyInTargetGroup = !!resolvedGroupId && existingGroupId === resolvedGroupId && incomingRole === "student";
        if (alreadyInTargetGroup) {
          // Group unchanged — but STILL honor an explicit account-type change, so re-submitting a
          // student as 'paid' (or 'provisional') upgrades/downgrades them without needing a group move.
          if (acctType) {
            const { error: acctErr } = await admin.from("profiles").update({ account_type: acctType }).eq("id", existingId);
            if (!acctErr) {
              results.push({ email, status: "updated", userId: existingId, row_index, identifier_used });
              auditLog(row_index, identifier_used, "account_type_updated_same_group");
              continue;
            }
          }
          const err = "Bu foydalanuvchi allaqachon shu guruhda.";
          results.push({ email, status: "already_in_group", error: err, userId: existingId, row_index, identifier_used });
          auditLog(row_index, identifier_used, "already_in_group");
          continue;
        }

        const isStaff = incomingRole === "teacher" || incomingRole === "admin";
        const patch: Record<string, any> = {};
        if (acctType) patch.account_type = acctType; // explicit admin/sales choice; upgrades or sets trial
        if (resolvedGroupId && !isStaff) patch.group_id = resolvedGroupId;
        if (csvTgUsernameRaw) {
          const dbNorm = (existingTgUsername || "").trim().replace(/^@/, "").toLowerCase();
          const csvNormCmp = csvTgUsernameRaw.replace(/^@/, "").toLowerCase();
          if (dbNorm !== csvNormCmp) patch.telegram_username = csvTgUsernameRaw;
        }
        if (tgIdNum !== undefined) patch.telegram_id = tgIdNum;
        if (Object.keys(patch).length) {
          const { error: updateErr } = await admin.from("profiles").update(patch).eq("id", existingId);
          if (updateErr) {
            results.push({ email, status: "error", error: updateErr.message, row_index, identifier_used });
            auditLog(row_index, identifier_used, "failed", updateErr.message);
            continue;
          }
        }
        if (incomingRole === "teacher") {
          const { error: rErr } = await admin.from("user_roles").upsert({ user_id: existingId, role: "teacher" } as any, { onConflict: "user_id,role" });
          if (rErr) {
            results.push({ email, status: "role_conflict", error: rErr.message, userId: existingId, row_index, identifier_used });
            auditLog(row_index, identifier_used, "role_conflict_db", rErr.message);
            continue;
          }
          // Only claim a group that has NO teacher yet — never clobber a teacher already assigned
          // on the platform. .is("teacher_id", null) makes this a no-op when a teacher is set, so a
          // sheet import can never revert a manual teacher change. To reassign, change it on the
          // platform (the admin UI) — that sticks. Applies to all 3 teacher-assign paths below.
          if (resolvedGroupId) await admin.from("groups").update({ teacher_id: existingId }).eq("id", resolvedGroupId).is("teacher_id", null);
        } else if (incomingRole === "admin") {
          await admin.from("user_roles").upsert({ user_id: existingId, role: "admin" } as any, { onConflict: "user_id,role" });
        }
        results.push({ email, status: "updated", userId: existingId, row_index, identifier_used });
        auditLog(row_index, identifier_used, "matched");
        continue;
      }

      const { data: created, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { name: displayName || null, last_name: csvLastName || null },
      });
      if (error) {
        // Email collision: an existing auth user already owns this placeholder email.
        // v3.14.12: this means it's the same person — adopt the existing user instead of failing.
        if (/already.*registered|already.*exists|email.*registered/i.test(error.message)) {
          // Look up the existing auth user by email via paginated listUsers (admin API has no direct getByEmail in v2).
          let foundId: string | null = null;
          for (let page = 1; page <= 20 && !foundId; page++) {
            const { data: list } = await admin.auth.admin.listUsers({ page, perPage: 200 });
            const hit = list?.users?.find((u: any) => (u.email || "").toLowerCase() === email.toLowerCase());
            if (hit) foundId = hit.id;
            if (!list?.users || list.users.length < 200) break;
          }
          if (foundId) {
            const profilePatch: Record<string, any> = { name: displayName || null };
            if (acctType) profilePatch.account_type = acctType;
            if (csvLastName !== undefined) profilePatch.last_name = csvLastName || null;
            if (csvTgUsernameRaw) profilePatch.telegram_username = csvTgUsernameRaw;
            if (tgIdNum !== undefined) profilePatch.telegram_id = tgIdNum;
            if (resolvedGroupId && s.role !== "teacher" && s.role !== "admin") profilePatch.group_id = resolvedGroupId;
            await admin.from("profiles").update(profilePatch).eq("id", foundId);
            if (s.role === "teacher") {
              await admin.from("user_roles").upsert({ user_id: foundId, role: "teacher" } as any, { onConflict: "user_id,role" });
              if (resolvedGroupId) await admin.from("groups").update({ teacher_id: foundId }).eq("id", resolvedGroupId).is("teacher_id", null); // never clobber an existing teacher
            } else if (s.role === "admin") {
              await admin.from("user_roles").upsert({ user_id: foundId, role: "admin" } as any, { onConflict: "user_id,role" });
            }
            for (const cid of courseIds) {
              await admin.from("enrollments").upsert({ user_id: foundId, course_id: cid }, { onConflict: "user_id,course_id" });
            }
            results.push({ email, status: "updated", userId: foundId, row_index, identifier_used });
            auditLog(row_index, identifier_used, "matched_via_email_collision");
            continue;
          }
        }
        const friendly = /validate email|invalid format/i.test(error.message)
          ? `invalid_placeholder_email (${email}) — auth rejected synthesized email`
          : error.message;
        results.push({ email, status: "error", error: friendly, row_index, identifier_used });
        auditLog(row_index, identifier_used, "failed", friendly);
        continue;
      }
      const userId = created.user!.id;
      const profilePatch: Record<string, any> = { name: displayName || null };
      if (acctType) profilePatch.account_type = acctType; // new user: else column default 'paid'
      if (csvLastName !== undefined) profilePatch.last_name = csvLastName || null;
      if (csvTgUsernameRaw) profilePatch.telegram_username = csvTgUsernameRaw;
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
      // Teachers are NOT added as group members; instead set groups.teacher_id below.
      if (resolvedGroupId && s.role !== "teacher" && s.role !== "admin") profilePatch.group_id = resolvedGroupId;
      const { error: profErr } = await admin.from("profiles").update(profilePatch).eq("id", userId);
      if (profErr) {
        results.push({ email, status: "error", error: profErr.message, row_index, identifier_used });
        auditLog(row_index, identifier_used, "failed", profErr.message);
        await admin.auth.admin.deleteUser(userId).catch(() => {});
        continue;
      }

      if (s.role === "admin") {
        await admin.from("user_roles").insert({ user_id: userId, role: "admin" });
      } else if (s.role === "teacher") {
        await admin.from("user_roles").insert({ user_id: userId, role: "teacher" });
        if (resolvedGroupId) {
          await admin.from("groups").update({ teacher_id: userId }).eq("id", resolvedGroupId).is("teacher_id", null); // never clobber an existing teacher
        }
      }

      for (const cid of courseIds) {
        await admin.from("enrollments").upsert(
          { user_id: userId, course_id: cid },
          { onConflict: "user_id,course_id" },
        );
      }

      // handle_new_user auto-enrolls every NEW auth user in the default-for-signup course.
      // If this import targets OTHER courses (e.g. a 5.0-only Premium student), drop that default
      // enrollment so the student isn't handed free full access to the default course. Only when
      // the default isn't explicitly among courseIds (an admin can still add someone to both).
      if (courseIds.length > 0) {
        const { data: defCourse } = await admin.from("courses").select("id").eq("is_default_for_signup", true).maybeSingle();
        const defId = (defCourse as any)?.id;
        if (defId && !courseIds.includes(defId)) {
          await admin.from("enrollments").delete().eq("user_id", userId).eq("course_id", defId);
        }
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

    return new Response(JSON.stringify({ ok: true, results, request_id: requestId, csv_rows, group_count_after, delta, auto_created_groups: autoCreatedGroups }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
