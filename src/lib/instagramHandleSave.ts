/**
 * Save profiles.instagram_username with the read-back that makes a silent loss impossible (spec G28, Daily Tasks
 * PR-7): the same rules the Settings page applies since #230, as one function the Kunlik vazifalar page reuses.
 *
 *   1. parse first (parseInstagramHandle — the client twin of the DB's instagram_handle_parse); refuse before writing;
 *   2. write ONLY the handle, through mutate() (a 0-row / RLS-filtered write is not_saved, never "saved"), and read
 *      the stored value back in the same request;
 *   3. the DB may still keep the OLD value (normalize trigger refusal) → `not_stored`, never success;
 *   4. another profile has it (unique index, 23505) → `taken`; a guard rule speaking Uzbek (P0001 — e.g. the handle is
 *      locked after an accepted Instagram task, profiles_column_guard v2) → `locked` with the DB's own message.
 * An admin preview is the expected `impersonation_readonly` no-op.
 */
import { looseFrom } from "@/lib/looseTable";
import { mutate } from "@/lib/mutate";
import { isInstagramHandleTaken, parseInstagramHandle, type InstagramRejectReason } from "@/lib/instagramHandle";

export type HandleSaveResult =
  | { ok: true; handle: string; changed: boolean }
  | { ok: false; kind: "invalid"; reason: InstagramRejectReason }
  | { ok: false; kind: "taken" | "not_stored" | "locked" | "error" | "impersonation_readonly"; message?: string; code?: string | null };

export async function saveInstagramHandle(userId: string, input: string, saved: string): Promise<HandleSaveResult> {
  const parsed = parseInstagramHandle(input);
  if (!parsed.ok) return { ok: false, kind: "invalid", reason: parsed.reason };
  const wanted = parsed.handle ?? "";
  if (wanted === saved) return { ok: true, handle: wanted, changed: false };

  const r = await mutate<{ id: string; instagram_username: string | null }>(
    // The generated types lag the column (it is read untyped everywhere, see Settings.tsx).
    () => looseFrom("profiles").update({ instagram_username: parsed.handle }).eq("id", userId),
    "id,instagram_username",
  );
  if (!r.ok) {
    if (r.reason === "impersonation_readonly") return { ok: false, kind: "impersonation_readonly" };
    if (isInstagramHandleTaken(r)) return { ok: false, kind: "taken", code: r.code ?? null };
    if (r.code === "P0001" && r.message) return { ok: false, kind: "locked", message: r.message, code: r.code };
    return { ok: false, kind: r.reason === "not_saved" ? "not_stored" : "error", message: r.message, code: r.code ?? null };
  }
  const stored = String(r.row.instagram_username ?? "");
  if (stored !== wanted) return { ok: false, kind: "not_stored" };
  return { ok: true, handle: stored, changed: true };
}
