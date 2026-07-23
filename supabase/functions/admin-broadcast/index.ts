// admin-broadcast: an admin composes a broadcast; this creates the broadcasts row and fans out one
// pending broadcast_deliveries row per targeted student. The broadcast-drainer sends them. Gated to
// admin/superadmin (JWT) + the platform_settings.broadcast.enabled kill-switch. mode='test' targets
// only the caller; mode='all' targets enrolled+active+Telegram-linked students of the course.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

// Quiet-hours deferral: mode='all' sends starting next 08:00 Tashkent (03:00 UTC) if it's currently
// 22:00–08:00 Tashkent, so nobody is DM'd at night. Tashkent = UTC+5 (no DST).
function scheduledStart(): string {
  const now = new Date();
  const tHour = (now.getUTCHours() + 5) % 24;
  if (tHour >= 8 && tHour < 22) return now.toISOString();
  const target = new Date(now);
  target.setUTCMinutes(0, 0, 0);
  target.setUTCHours(3); // 08:00 Tashkent
  if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
  return target.toISOString();
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Caller must be an admin/superadmin.
  const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  const { data: who } = await admin.auth.getUser(jwt);
  const uid = who?.user?.id;
  if (!uid) return json({ error: "unauthorized" }, 401);
  const { data: roles } = await admin.from("user_roles").select("role").eq("user_id", uid).in("role", ["admin", "superadmin"]);
  if (!roles?.length) return json({ error: "forbidden" }, 403);

  // Kill-switch.
  const { data: ks } = await admin.from("platform_settings").select("value").eq("key", "broadcast").maybeSingle();
  if (!(ks?.value as any)?.enabled) return json({ error: "broadcast_disabled" }, 403);

  const body = await req.json().catch(() => ({}));
  const course_id = String(body?.course_id || "");
  const mode = body?.mode === "all" ? "all" : "test";
  const image_path = body?.image_path ? String(body.image_path) : null;
  const body_uz = String(body?.body_uz || "").trim();
  const body_ru = body?.body_ru ? String(body.body_ru) : null;
  const body_en = body?.body_en ? String(body.body_en) : null;
  const button_label = body?.button_label ? String(body.button_label).slice(0, 64) : null;
  const button_url = body?.button_url ? String(body.button_url).slice(0, 512) : null;

  if (!course_id) return json({ error: "course_id required" }, 400);
  if (!body_uz) return json({ error: "body_uz required" }, 400);
  // Telegram limits: caption ≤1024 with an image, text ≤4096 without.
  const limit = image_path ? 1024 : 4096;
  for (const [k, v] of [["uz", body_uz], ["ru", body_ru], ["en", body_en]] as const) {
    if (v && v.length > limit) return json({ error: `body_${k} exceeds ${limit} chars` }, 400);
  }
  if ((button_label && !button_url) || (button_url && !button_label)) return json({ error: "button needs both label and url" }, 400);

  // Idempotency: refuse a second live send to the same course (guards double-click / client retry
  // from DM'ing every student twice). Only one mode='all' broadcast may be 'sending' per course.
  if (mode === "all") {
    const { count } = await admin.from("broadcasts")
      .select("id", { count: "exact", head: true })
      .eq("course_id", course_id).eq("mode", "all").eq("status", "sending");
    if ((count || 0) > 0) return json({ error: "broadcast_in_progress" }, 409);
  }

  // Create the broadcast row.
  const { data: bc, error: bErr } = await admin.from("broadcasts").insert({
    course_id, created_by: uid, image_path, body_uz, body_ru, body_en,
    button_label, button_url, mode, status: "sending", started_at: new Date().toISOString(),
  }).select("id").single();
  if (bErr || !bc) return json({ error: bErr?.message || "insert_failed" }, 500);
  const broadcast_id = bc.id;

  // Resolve targets.
  let targets: { id: string; telegram_id: string }[] = [];
  if (mode === "test") {
    const { data: me } = await admin.from("profiles").select("id, telegram_id").eq("id", uid).maybeSingle();
    if (me?.telegram_id) targets = [{ id: me.id, telegram_id: me.telegram_id }];
  } else {
    const { data: enr } = await admin.from("enrollments").select("user_id").eq("course_id", course_id);
    const userIds = Array.from(new Set((enr || []).map((r: any) => r.user_id)));
    if (userIds.length) {
      const { data: profs } = await admin.from("profiles")
        .select("id, telegram_id")
        .in("id", userIds)
        .not("telegram_id", "is", null)
        .eq("status", "active")
        .is("archived_at", null);
      targets = (profs || []).map((p: any) => ({ id: p.id, telegram_id: p.telegram_id }));
    }
  }

  // Nothing to send (admin has no linked Telegram for a test, or no reachable students) — close the
  // broadcast immediately so it doesn't sit 'sending' forever, and tell the caller why.
  if (!targets.length) {
    await admin.from("broadcasts").update({ status: "done", finished_at: new Date().toISOString() }).eq("id", broadcast_id);
    return json({ broadcast_id, total: 0, note: mode === "test" ? "no_telegram_linked" : "no_reachable_students" });
  }

  const scheduled_for = mode === "all" ? scheduledStart() : new Date().toISOString();
  const deliveries = targets.map((t) => ({ broadcast_id, user_id: t.id, telegram_id: t.telegram_id, scheduled_for }));
  for (let i = 0; i < deliveries.length; i += 500) {
    await admin.from("broadcast_deliveries").insert(deliveries.slice(i, i + 500));
  }
  await admin.from("broadcasts").update({ total: targets.length }).eq("id", broadcast_id);

  try {
    await admin.from("admin_actions").insert({
      actor_user_id: uid, action: "broadcast_created",
      details: { broadcast_id, course_id, mode, total: targets.length, has_image: !!image_path, scheduled_for },
    });
  } catch { /* best-effort */ }

  return json({ broadcast_id, total: targets.length, scheduled_for });
});
