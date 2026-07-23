// Shared broadcast logic used by BOTH entry points — admin-broadcast (web, Supabase-JWT auth) and
// tg-broadcast (Telegram Mini App, initData auth). Each entry point does its own auth, resolves the
// acting admin's profile id, then calls createBroadcast(). One implementation → no divergence in the
// validation / double-send guard / fan-out / quiet-hours rules.

export interface CreateParams {
  course_id: string;
  image_path: string | null;
  body_uz: string;
  body_ru: string | null;
  body_en: string | null;
  button_label: string | null;
  button_url: string | null;
  mode: "test" | "all";
  actor_uid: string; // profile id of the acting admin (created_by + the test-send target)
}

// mode='all' sends starting next 08:00 Tashkent (03:00 UTC) if it's currently 22:00–08:00, so nobody
// is DM'd overnight. Tashkent = UTC+5 (no DST).
export function scheduledStart(): string {
  const now = new Date();
  const tHour = (now.getUTCHours() + 5) % 24;
  if (tHour >= 8 && tHour < 22) return now.toISOString();
  const target = new Date(now);
  target.setUTCMinutes(0, 0, 0);
  target.setUTCHours(3);
  if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
  return target.toISOString();
}

export async function killSwitchOn(admin: any): Promise<boolean> {
  const { data } = await admin.from("platform_settings").select("value").eq("key", "broadcast").maybeSingle();
  return !!(data?.value as any)?.enabled;
}

export async function coursesWithReach(admin: any): Promise<{ id: string; title: string; reachable: number }[]> {
  const { data: courses } = await admin.from("courses").select("id, title").order("created_at", { ascending: false });
  const out: { id: string; title: string; reachable: number }[] = [];
  for (const c of (courses || []) as any[]) {
    const { data: enr } = await admin.from("enrollments").select("user_id").eq("course_id", c.id);
    const ids = Array.from(new Set((enr || []).map((r: any) => r.user_id)));
    let reachable = 0;
    if (ids.length) {
      const { count } = await admin.from("profiles").select("id", { count: "exact", head: true })
        .in("id", ids).not("telegram_id", "is", null).eq("status", "active").is("archived_at", null);
      reachable = count || 0;
    }
    out.push({ id: c.id, title: c.title, reachable });
  }
  return out;
}

export async function broadcastStatus(admin: any, id: string): Promise<any> {
  const { data: b } = await admin.from("broadcasts").select("status,total,sent,failed,mode").eq("id", id).maybeSingle();
  if (!b) return { error: "not_found" };
  const { count } = await admin.from("broadcast_deliveries").select("id", { count: "exact", head: true })
    .eq("broadcast_id", id).eq("status", "pending");
  return { status: b.status, total: b.total, sent: b.sent, failed: b.failed, pending: count || 0, mode: b.mode };
}

// Creates a broadcast + fans out one pending delivery per target. Returns an HTTP {status, body}.
export async function createBroadcast(admin: any, p: CreateParams): Promise<{ status: number; body: any }> {
  if (!(await killSwitchOn(admin))) return { status: 403, body: { error: "broadcast_disabled" } };
  if (!p.course_id) return { status: 400, body: { error: "course_id required" } };
  if (!p.body_uz?.trim()) return { status: 400, body: { error: "body_uz required" } };
  const limit = p.image_path ? 1024 : 4096; // Telegram: caption ≤1024, text ≤4096
  for (const [k, v] of [["uz", p.body_uz], ["ru", p.body_ru], ["en", p.body_en]] as const) {
    if (v && v.length > limit) return { status: 400, body: { error: `body_${k} exceeds ${limit} chars` } };
  }
  if ((p.button_label && !p.button_url) || (p.button_url && !p.button_label)) {
    return { status: 400, body: { error: "button needs both label and url" } };
  }

  // Idempotency: at most one live mode='all' send per course.
  if (p.mode === "all") {
    const { count } = await admin.from("broadcasts").select("id", { count: "exact", head: true })
      .eq("course_id", p.course_id).eq("mode", "all").eq("status", "sending");
    if ((count || 0) > 0) return { status: 409, body: { error: "broadcast_in_progress" } };
  }

  const { data: bc, error } = await admin.from("broadcasts").insert({
    course_id: p.course_id, created_by: p.actor_uid, image_path: p.image_path, body_uz: p.body_uz.trim(),
    body_ru: p.body_ru, body_en: p.body_en, button_label: p.button_label, button_url: p.button_url,
    mode: p.mode, status: "sending", started_at: new Date().toISOString(),
  }).select("id").single();
  if (error || !bc) return { status: 500, body: { error: error?.message || "insert_failed" } };
  const broadcast_id = bc.id;

  let targets: { id: string; telegram_id: string }[] = [];
  if (p.mode === "test") {
    const { data: me } = await admin.from("profiles").select("id, telegram_id").eq("id", p.actor_uid).maybeSingle();
    if (me?.telegram_id) targets = [{ id: me.id, telegram_id: me.telegram_id }];
  } else {
    const { data: enr } = await admin.from("enrollments").select("user_id").eq("course_id", p.course_id);
    const ids = Array.from(new Set((enr || []).map((r: any) => r.user_id)));
    if (ids.length) {
      const { data: profs } = await admin.from("profiles").select("id, telegram_id")
        .in("id", ids).not("telegram_id", "is", null).eq("status", "active").is("archived_at", null);
      targets = (profs || []).map((x: any) => ({ id: x.id, telegram_id: x.telegram_id }));
    }
  }

  if (!targets.length) {
    await admin.from("broadcasts").update({ status: "done", finished_at: new Date().toISOString() }).eq("id", broadcast_id);
    return { status: 200, body: { broadcast_id, total: 0, note: p.mode === "test" ? "no_telegram_linked" : "no_reachable_students" } };
  }

  const scheduled_for = p.mode === "all" ? scheduledStart() : new Date().toISOString();
  const deliveries = targets.map((t) => ({ broadcast_id, user_id: t.id, telegram_id: t.telegram_id, scheduled_for }));
  let inserted = 0;
  for (let i = 0; i < deliveries.length; i += 500) {
    const chunk = deliveries.slice(i, i + 500);
    const { error: insErr } = await admin.from("broadcast_deliveries").insert(chunk);
    if (insErr) console.error("broadcast delivery insert failed", broadcast_id, insErr.message);
    else inserted += chunk.length;
  }
  // total reflects rows ACTUALLY queued, so the report is honest even if a batch insert failed.
  await admin.from("broadcasts").update({ total: inserted }).eq("id", broadcast_id);

  try {
    await admin.from("admin_actions").insert({
      actor_user_id: p.actor_uid, action: "broadcast_created",
      details: { broadcast_id, course_id: p.course_id, mode: p.mode, total: inserted, has_image: !!p.image_path, scheduled_for },
    });
  } catch { /* best-effort */ }

  return { status: 200, body: { broadcast_id, total: inserted, scheduled_for } };
}
