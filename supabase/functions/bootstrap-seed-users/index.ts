// Idempotent: creates admin@aicreators.io and student@aicreators.io if missing.
// Promotes the admin to role=admin. Safe to call any time.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SEED = [
  { email: "admin@aicreators.io", password: "admin123", name: "Admin", role: "admin" as const },
  { email: "student@aicreators.io", password: "student123", name: "Student", role: "student" as const },
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(url, serviceKey);

    const results: Array<{ email: string; status: string; userId?: string }> = [];

    for (const seed of SEED) {
      // Check if user exists
      const { data: list } = await admin.auth.admin.listUsers();
      let user = list?.users?.find((u) => u.email === seed.email);

      if (!user) {
        const { data: created, error } = await admin.auth.admin.createUser({
          email: seed.email,
          password: seed.password,
          email_confirm: true,
          user_metadata: { name: seed.name },
        });
        if (error) {
          results.push({ email: seed.email, status: `error: ${error.message}` });
          continue;
        }
        user = created.user!;
        results.push({ email: seed.email, status: "created", userId: user.id });
      } else {
        results.push({ email: seed.email, status: "exists", userId: user.id });
      }

      // Ensure profile exists (the trigger should handle it but be safe)
      await admin.from("profiles").upsert(
        { id: user.id, email: seed.email, name: seed.name },
        { onConflict: "id" },
      );

      // Ensure role
      if (seed.role === "admin") {
        await admin.from("user_roles").upsert(
          { user_id: user.id, role: "admin" },
          { onConflict: "user_id,role" },
        );
      }

      // Ensure enrolled in default course
      const { data: course } = await admin
        .from("courses")
        .select("id")
        .eq("is_default_for_signup", true)
        .maybeSingle();
      if (course) {
        await admin.from("enrollments").upsert(
          { user_id: user.id, course_id: course.id },
          { onConflict: "user_id,course_id" },
        );
      }

      // Ensure streak row
      await admin.from("streaks").upsert({ user_id: user.id }, { onConflict: "user_id" });
    }

    return new Response(JSON.stringify({ ok: true, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("seed error", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
