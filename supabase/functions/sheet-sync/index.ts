// sheet-sync: receives student-intake rows from the sales Google Sheet (via Apps Script) and
// creates them on the platform (course + tier + group), idempotently. External caller, so it is
// authenticated by a DEDICATED shared secret (SHEET_SYNC_SECRET) — NOT the internal Vault secret.
// It does NOT re-implement the import: it calls the existing admin-create-students engine with the
// internal secret, then sets the tier and (optional) phone. No existing student is ever touched.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-sheet-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// Constant-time compare (length leak only).
function ctEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const USERNAME_RE = /^@?[A-Za-z0-9_]{4,32}$/;
const norm = (s: unknown) => String(s ?? "").trim();
// "Full" / "Full access" → no tier (full access). Otherwise look up the named tier in the course.
const isFullTier = (t: string) => /^full(\s*access)?$/i.test(t.trim());

type Row = {
  row?: number; name?: string; last_name?: string; telegram_username?: string;
  course?: string; tier?: string; group_name?: string; phone?: string; email?: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const SECRET = Deno.env.get("SHEET_SYNC_SECRET") || "";
  const provided = req.headers.get("x-sheet-secret") || "";
  if (!SECRET || !provided || !ctEq(provided, SECRET)) return json({ error: "forbidden" }, 403);

  // Size guard.
  const raw = await req.text();
  if (raw.length > 256 * 1024) return json({ error: "payload_too_large" }, 413);
  let body: any;
  try { body = JSON.parse(raw); } catch { return json({ error: "bad_json" }, 400); }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // OPTIONS mode: the intake form fetches courses + each course's tiers + existing groups
  // (secret-gated, like the rest) so it can render dropdowns.
  if (body && body.options) {
    const [{ data: oc }, { data: ot }, { data: og }] = await Promise.all([
      admin.from("courses").select("id, title").order("title"),
      admin.from("course_tiers").select("course_id, name, position").order("position"),
      admin.from("groups").select("course_id, name").order("name"),
    ]);
    const out = ((oc || []) as any[]).map((c) => ({
      title: c.title,
      tiers: ((ot || []) as any[]).filter((t) => t.course_id === c.id).map((t) => t.name),
      groups: ((og || []) as any[]).filter((g) => g.course_id === c.id).map((g) => g.name),
    }));
    return json({ courses: out });
  }

  const rows = Array.isArray(body?.rows) ? (body.rows as Row[]) : [];
  if (!rows.length) return json({ results: [] });
  if (rows.length > 200) return json({ error: "too_many_rows", max: 200 }, 413);

  // Internal secret for the server-to-server call into admin-create-students.
  let internalSecret = "";
  try {
    const { data } = await admin.rpc("internal_fn_secret");
    internalSecret = String(data || "");
  } catch (_e) { /* handled below */ }
  if (!internalSecret) return json({ error: "internal_secret_unavailable" }, 500);

  // Lookups once per request.
  const [{ data: courses }, { data: tiers }] = await Promise.all([
    admin.from("courses").select("id, title"),
    admin.from("course_tiers").select("id, course_id, name"),
  ]);
  const courseList = (courses || []) as { id: string; title: string }[];
  const tierList = (tiers || []) as { id: string; course_id: string; name: string }[];

  const resolveCourse = (val: string): string | null => {
    const v = val.trim().toLowerCase();
    const exact = courseList.filter((c) => (c.title || "").toLowerCase() === v);
    if (exact.length === 1) return exact[0].id;
    const partial = courseList.filter((c) => (c.title || "").toLowerCase().includes(v));
    return partial.length === 1 ? partial[0].id : null;
  };

  const results: { row?: number; status: string; message?: string }[] = [];

  for (const r of rows) {
    const rowNum = r.row;
    const name = norm(r.name);
    const username = norm(r.telegram_username);
    const courseVal = norm(r.course);
    const tierVal = norm(r.tier);
    const groupName = norm(r.group_name);
    const lastName = norm(r.last_name);
    const phone = norm(r.phone);
    const email = norm(r.email);

    // Mandatory fields.
    if (!name || !username || !courseVal || !tierVal || !groupName) {
      results.push({ row: rowNum, status: "missing_field", message: "First name, @username, course, tier and group are required" });
      continue;
    }
    if (!USERNAME_RE.test(username)) {
      results.push({ row: rowNum, status: "bad_username", message: "Telegram username looks invalid" });
      continue;
    }
    const course_id = resolveCourse(courseVal);
    if (!course_id) { results.push({ row: rowNum, status: "unknown_course", message: `Course "${courseVal}" not found` }); continue; }

    let tier_id: string | null = null;
    if (!isFullTier(tierVal)) {
      const match = tierList.filter((t) => t.course_id === course_id && (t.name || "").toLowerCase() === tierVal.toLowerCase());
      if (match.length !== 1) { results.push({ row: rowNum, status: "unknown_tier", message: `Tier "${tierVal}" not found for this course` }); continue; }
      tier_id = match[0].id;
    }

    try {
      // 1) Create / match the student via the existing import engine (course + group).
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/admin-create-students`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // x-internal-secret authenticates us as a SYSTEM caller inside the function;
          // the service-role bearer + apikey satisfy the gateway (admin-create-students is verify_jwt=true).
          "x-internal-secret": internalSecret,
          "Authorization": `Bearer ${SERVICE_KEY}`,
          "apikey": SERVICE_KEY,
        },
        body: JSON.stringify({
          students: [{
            name, last_name: lastName || undefined, email: email || undefined,
            telegram_username: username, role: "student", group_name: groupName,
          }],
          courseIds: [course_id],
          target_course_id: course_id,
          csv_import: true,
        }),
      });
      const out = await resp.json().catch(() => ({}));
      const res0 = (out?.results || [])[0] || {};
      const status = res0.status || (resp.ok ? "unknown" : "error");
      const userId = res0.userId as string | undefined;

      if (!userId) {
        results.push({ row: rowNum, status, message: res0.error || `HTTP ${resp.status}` });
        continue;
      }

      // 2) Tier + optional phone (idempotent).
      await admin.rpc("set_enrollment_tier_system", { _user_id: userId, _course_id: course_id, _tier_id: tier_id });
      if (phone) await admin.from("profiles").update({ phone }).eq("id", userId);

      // 3) Audit (no PII in the row — just ids + status).
      await admin.from("admin_actions").insert({
        actor_user_id: null,
        action: "sheet_import",
        target_user_id: userId,
        details: { course_id, tier_id, status },
      });

      results.push({ row: rowNum, status, message: status === "created" ? "" : (res0.error || "") });
    } catch (e) {
      results.push({ row: rowNum, status: "error", message: String((e as any)?.message || e).slice(0, 200) });
    }
  }

  return json({ results });
});
