// TeacherBroadcast — `/tg/teacher/broadcast`, the Xabar (broadcast) screen (Phase 3, Task 2).
//
// Renders INSIDE `TeacherShell` (App.tsx owns the shell + bottom nav + staff guard), so this file is
// page CONTENT only — no `max-w-2xl`/extra px (the shell already applies those). A teacher/co-teacher
// picks one of their groups (`useSelectedGroup`, Phase 2, junction-aware `teacher_groups(uid)`),
// composes a ≤300-char message, and sends. The single coral primary ("Yuborish") calls the
// `teacher-broadcast-group` edge fn (Task 1), which fans out an individual Telegram DM to every
// student in the group with a `telegram_id` — NOT a post into the group chat.
//
// ERROR CONTRACT: on success the fn returns HTTP 200 with `{ok:true, sent, failed, total,
// skipped_no_telegram}` in `data`. On a business/error state it returns a NON-2xx status, so
// supabase-js puts the response body in `error.context` (a Response), NOT `data` — read the JSON
// body off `error.context.json()` to get the `error` code. Same pattern as
// src/components/homework/HomeworkSubmit.tsx:207-215 (submit-homework's already_graded handling).
// Unknown/unreadable codes (incl. the fn's own "unknown" 500) collapse to a generic retry copy —
// a raw 500 body must never reach the teacher.
//
// STATES (all required, mirrors TeacherGroups/TeacherHome): loading `Skeleton`; `navigator.onLine`
// -aware error + retry (from `useSelectedGroup`'s own `error`/`reload`); no-groups `EmptyState`
// ("Sizda guruh yo'q"); sending spinner on the single primary; inline success/error result panel
// (plain wrapping text, NOT `StatusChip` — that pill is `whitespace-nowrap` and these messages run
// long enough to force horizontal scroll on a narrow viewport).
import { useState } from "react";
import { Loader2, Send } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useSelectedGroup } from "@/hooks/useSelectedGroup";
import { Card, SectionHeader, Button, EmptyState, Skeleton } from "@/components/ui-kit";

const MAX_LEN = 300; // mirrors the fn's MAX_MESSAGE_LEN — client-side cap so message_too_long never fires.

const offlineNow = () => typeof navigator !== "undefined" && !navigator.onLine;

type SendResult =
  | { kind: "idle" }
  | { kind: "success"; sent: number; failed: number; total: number; skippedNoTelegram: number }
  | { kind: "error"; message: string };

// Maps the fn's error codes (index.ts header, teacher-broadcast-group) to the exact uz copy from the
// task brief. `unauthorized`/`message_too_long`/anything unrecognized (incl. "unknown") all collapse
// to the same generic retry line — a raw 500 body must never reach the teacher.
function errorMessageFor(code: string): string {
  switch (code) {
    case "rate_limited":
      return "Soatiga 1 marta xabar yuborish mumkin — birozdan keyin qayta urining";
    case "no_recipients":
      return "Bu guruhda Telegram'li o'quvchi yo'q";
    case "forbidden":
      return "Ruxsat yo'q";
    default:
      return "Xatolik — qayta urining";
  }
}

export default function TeacherBroadcast() {
  const { groups, groupId, setGroupId, loading, error, reload } = useSelectedGroup();

  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SendResult>({ kind: "idle" });

  const trimmed = message.trim();
  const offline = offlineNow();

  const handleSend = async () => {
    if (!groupId || !trimmed || sending) return;
    if (offlineNow()) {
      setResult({ kind: "error", message: "Internet yo'q. Ulanishni tekshiring va qayta urinib ko'ring." });
      return;
    }
    setSending(true);
    setResult({ kind: "idle" });
    try {
      // Only {group_id, message} ever leaves the client — the bot token is the fn's own concern
      // (never in this request or its response).
      const { data, error: fnErr } = await supabase.functions.invoke("teacher-broadcast-group", {
        body: { group_id: groupId, message: trimmed },
      });
      if (fnErr) {
        // On an HTTP error, supabase-js puts the response body in error.context, not `data` — read
        // the code from there (HomeworkSubmit.tsx:207-215 is the reference pattern).
        let code = "";
        try {
          const j = await (fnErr as any).context?.json?.();
          code = j?.error || "";
        } catch {
          // body unreadable — falls through to the generic error message below
        }
        console.error("[TeacherBroadcast] send failed", code || fnErr);
        setResult({ kind: "error", message: errorMessageFor(code) });
        return;
      }
      const d = data as { ok: boolean; sent: number; failed: number; total: number; skipped_no_telegram: number };
      setResult({
        kind: "success",
        sent: d.sent,
        failed: d.failed,
        total: d.total,
        skippedNoTelegram: d.skipped_no_telegram,
      });
      setMessage("");
    } catch (e) {
      // supabase-js can THROW on a network failure (exactly when offline slips past the guard above).
      console.error("[TeacherBroadcast] send threw", e);
      setResult({ kind: "error", message: "Xatolik — qayta urining" });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="min-w-0 space-y-1">
        <h1 className="text-2xl font-extrabold tracking-tight text-foreground">Xabar yuborish</h1>
        <p className="truncate text-sm font-semibold text-muted-foreground">
          Guruhdagi barcha o'quvchilarga shaxsiy xabar yuboriladi
        </p>
      </div>

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-11 w-full rounded-lg" />
          <Skeleton className="h-40 w-full rounded-lg" />
          <Skeleton className="h-11 w-full rounded-lg" />
        </div>
      ) : error ? (
        <EmptyState
          icon={offline ? "📡" : "⚠️"}
          title={offline ? "Internet yo'q" : "Xatolik"}
          body={
            offline
              ? "Ulanishni tekshiring va qayta urinib ko'ring."
              : "Guruhlarni yuklab bo'lmadi. Birozdan so'ng qayta urinib ko'ring."
          }
          cta={
            <Button variant="secondary" size="sm" onClick={reload}>
              Qayta urinish
            </Button>
          }
        />
      ) : groups.length === 0 ? (
        <EmptyState
          icon="🏫"
          title="Sizda guruh yo'q"
          body="Sizga hali guruh biriktirilmagan. Guruh biriktirilganda shu yerda ko'rinadi."
        />
      ) : (
        <Card className="space-y-4">
          {/* Group picker — a single group shows its name (no picker); 2+ get a native select that
              drives the shared `setGroupId` (so the pick follows the teacher to Stats/Grading). */}
          <div className="min-w-0 space-y-1.5">
            <SectionHeader title="Guruh" />
            {groups.length === 1 ? (
              <div className="truncate rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-[15px] font-extrabold text-foreground">
                {groups[0].name}
              </div>
            ) : (
              <select
                value={groupId ?? ""}
                onChange={(e) => setGroupId(e.target.value)}
                disabled={sending}
                className="w-full min-w-0 rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm font-bold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              >
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Message — hard-capped textarea with a live counter. */}
          <div className="min-w-0 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[14.5px] font-extrabold tracking-tight text-foreground">Xabar</span>
              <span className="flex-none tabular-nums text-xs font-semibold text-muted-foreground">
                {message.length}/{MAX_LEN}
              </span>
            </div>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={MAX_LEN}
              rows={6}
              placeholder="Xabaringizni yozing…"
              disabled={sending}
              className="w-full min-w-0 resize-none rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            />
          </div>

          {result.kind === "success" && (
            <div className="min-w-0 space-y-1 rounded-lg border border-good/30 bg-good/10 px-3 py-2.5">
              <p className="break-words text-sm font-extrabold text-good-2">
                {`Xabar ${result.sent} ta o'quvchiga yuborildi`}
                {result.failed > 0 ? `, ${result.failed} ta yetib bormadi` : ""}
              </p>
              {result.skippedNoTelegram > 0 && (
                <p className="break-words text-xs font-semibold text-muted-foreground">
                  {result.skippedNoTelegram} ta o'quvchi Telegram'ni ulamagan
                </p>
              )}
            </div>
          )}

          {result.kind === "error" && (
            <div className="min-w-0 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5">
              <p className="break-words text-sm font-extrabold text-danger-2">{result.message}</p>
            </div>
          )}

          {/* The ONE coral primary on this screen. */}
          <Button variant="primary" block disabled={!groupId || !trimmed || sending} onClick={handleSend}>
            {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            Yuborish
          </Button>
        </Card>
      )}
    </div>
  );
}
