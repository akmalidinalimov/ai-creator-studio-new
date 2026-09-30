// The allows_write_to_pm stamp (Challenge 6.0 Daily Tasks PR-7, spec C15 / G28).
//
// Telegram signs `allows_write_to_pm: true` into a Mini App user's initData when the bot may message them. The daily
// tasks engine counts a student as DM-eligible when they have a private webhook_inbox row OR
// profiles.telegram_write_access_at is set (challenge_task_dm_eligible), and ~70% of students never pressed Start,
// so the Mini App sign-in is where most of them become reachable.
//
// Written with the service role from the HMAC-verified initData (never from the client's word). The PR-0 profiles
// guard refuses this column to a student's own write; the service role is privileged. Stamped once (the first time),
// never cleared here. Best-effort for the sign-in, but a failed write is DB-visible, never console-only.
import { logHealth } from "../_shared/edge.ts";

export type StampResult = "stamped" | "already" | "failed";

// deno-lint-ignore no-explicit-any
export async function stampWriteAccess(admin: any, profileId: string, now: Date = new Date()): Promise<StampResult> {
  try {
    const { data, error } = await admin.from("profiles")
      .update({ telegram_write_access_at: now.toISOString() })
      .eq("id", profileId)
      .is("telegram_write_access_at", null)
      .select("id");
    if (error) {
      await logHealth(admin, "miniapp_write_access_stamp_failed", { profile_id: profileId, code: error.code ?? null, error: String(error.message ?? "").slice(0, 200) },
        { source: "tg-miniapp-auth", targetUserId: profileId });
      return "failed";
    }
    return Array.isArray(data) && data.length > 0 ? "stamped" : "already";
  } catch (e) {
    await logHealth(admin, "miniapp_write_access_stamp_failed", { profile_id: profileId, error: String(e).slice(0, 200) },
      { source: "tg-miniapp-auth", targetUserId: profileId });
    return "failed";
  }
}
