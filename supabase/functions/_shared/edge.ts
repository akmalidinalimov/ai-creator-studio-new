// Shared edge-function scaffold: CORS, JSON responses, and DB-visible health logging.
//
// Every function inherits the incident-doctrine default ("a real failure is DB-visible, never
// console-only") instead of copy-pasting it — corsHeaders is currently duplicated in ~58 functions,
// json() in ~19, and logHealth in 3 (hw-image-url / hw-audio-url / notify-grade-voice each have a
// near-identical local copy). New functions should import these; existing ones migrate opportunistically.

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** JSON response with CORS. `extraHeaders` lets a caller add e.g. a marker header. */
export function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extraHeaders },
  });
}

/**
 * Best-effort, non-blocking DB-visible health signal (incident-doctrine step 5): a real failure lands
 * in `admin_actions` so the watchdog/digest layer can see it before the next complaint. Never throws,
 * never blocks the real response, and must never carry a secret (the caller controls `details`).
 * `admin` is a service-role Supabase client.
 */
export async function logHealth(
  admin: any,
  action: string,
  details: Record<string, unknown>,
  opts?: {
    actorUserId?: string | null;
    source?: string;
    targetUserId?: string | null;
    targetResourceType?: string | null;
    targetResourceId?: string | null;
  },
): Promise<void> {
  try {
    const { error } = await admin.from("admin_actions").insert({
      actor_user_id: opts?.actorUserId ?? null,
      action,
      target_user_id: opts?.targetUserId ?? null,
      target_resource_type: opts?.targetResourceType ?? null,
      target_resource_id: opts?.targetResourceId ?? null,
      details: { ...details, source: opts?.source ?? "edge" },
    });
    if (error) console.error(`logHealth insert failed (${action})`, error.message);
  } catch (e) {
    console.error(`logHealth threw (${action})`, String(e));
  }
}
