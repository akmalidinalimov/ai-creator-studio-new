// Admin-only: create or delete users. Supports telegram_username, role, multiple course enrollments.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type Student = {
  name?: string;
  email: string;
  password?: string;
  telegram_username?: string;
  role?: "student" | "admin";
};

function genPassword(): string {
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 12; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
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

    // DELETE: remove a user
    if (req.method === "DELETE") {
      const { userId } = await req.json();
      if (!userId) return new Response(JSON.stringify({ error: "userId required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const body = await req.json();
    const students: Student[] = body.students;
    const courseId: string | undefined = body.courseId;
    const courseIds: string[] = Array.isArray(body.courseIds) ? body.courseIds : (courseId ? [courseId] : []);

    if (!Array.isArray(students) || students.length === 0) {
      return new Response(JSON.stringify({ error: "students[] required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const results: Array<{ email: string; status: string; password?: string; userId?: string; error?: string }> = [];
    for (const s of students) {
      const email = (s.email || "").trim().toLowerCase();
      if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
        results.push({ email: s.email, status: "invalid_email" });
        continue;
      }
      const password = (s.password && s.password.length >= 6) ? s.password : genPassword();
      const { data: created, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { name: s.name || email.split("@")[0] },
      });
      if (error) {
        results.push({ email, status: "error", error: error.message });
        continue;
      }
      const userId = created.user!.id;
      const profilePatch: Record<string, any> = { name: s.name || email.split("@")[0] };
      if (s.telegram_username) profilePatch.telegram_username = s.telegram_username.replace(/^@/, "");
      await admin.from("profiles").update(profilePatch).eq("id", userId);

      // Role: trigger creates 'student' by default. If admin requested, add admin row.
      if (s.role === "admin") {
        await admin.from("user_roles").insert({ user_id: userId, role: "admin" });
      }

      // Enrollments
      for (const cid of courseIds) {
        await admin.from("enrollments").upsert(
          { user_id: userId, course_id: cid },
          { onConflict: "user_id,course_id" },
        );
      }

      results.push({ email, status: "created", userId, password });
    }

    return new Response(JSON.stringify({ ok: true, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
