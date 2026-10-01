// TeacherBroadcast — `/tg/teacher/broadcast`, the Xabar (broadcast) screen (Phase 3, Task 2).
//
// Renders INSIDE `TeacherShell` (App.tsx owns the shell + bottom nav + staff guard), so this file is
// page CONTENT only — no `max-w-2xl`/extra px (the shell already applies those). A teacher/co-teacher
// picks one of their groups (`useSelectedGroup`, Phase 2, junction-aware `teacher_groups(uid)`),
// composes a ≤300-char message, and sends. The `teacher-broadcast-group` edge fn (Task 1) fans out an
// individual Telegram DM to every student in the group with a `telegram_id` — NOT a post into the group chat.
//
// CONFIRM BEFORE SENDING (teacher audit 2026-09-30, TUI-3): the group select starts on the group remembered
// from OTHER teacher screens (Stats, Groups, …), and a broadcast cannot be recalled — the fn stamps the
// 1-per-hour rate row BEFORE it sends, so a message to the wrong cohort also blocks the correction for an hour.
// "Yuborish" therefore opens a confirmation panel that names the group, its COURSE and the exact recipient
// count, and only "Ha, yuborish" sends. The count comes from `staff_group_members(_group_id)` — the same row
// set the fn sends to (profiles.group_id = group, telegram_id set) — so "37 ta o'quvchi" is what will happen.
// While the panel is open the group and message are locked, and the send uses the SNAPSHOT the teacher
// confirmed, never live state. A failed count still lets her send (the fn is the source of truth) but says so
// and beacons it (graceful is not silent).
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
// ("Sizda guruh yo'q"); confirm panel (counting / count failed / zero recipients); sending spinner on the
// single primary; inline success/error result panel (plain wrapping text, NOT `StatusChip` — that pill is
// `whitespace-nowrap` and these messages run long enough to force horizontal scroll on a narrow viewport).
import { useRef, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useSelectedGroup } from "@/hooks/useSelectedGroup";
import { reportClientError } from "@/lib/beacon";
import { groupWithCourse } from "@/lib/groupLabel";
import { Card, SectionHeader, Button, EmptyState, Skeleton } from "@/components/ui-kit";

const MAX_LEN = 300; // mirrors the fn's MAX_MESSAGE_LEN — client-side cap so message_too_long never fires.

const offlineNow = () => typeof navigator !== "undefined" && !navigator.onLine;

type SendResult =
  | { kind: "idle" }
  | { kind: "success"; groupName: string; sent: number; failed: number; total: number; skippedNoTelegram: number }
  | { kind: "error"; message: string };

// What the teacher is asked to confirm — a snapshot, so what she confirmed is exactly what is sent.
type Confirm = {
  groupId: string;
  groupName: string;
  courseName: string | null;
  message: string;
  /** Students who will get the DM (telegram_id set). null while counting or when the count failed. */
  recipients: number | null;
  /** Students in the group without Telegram (the fn skips them). */
  noTelegram: number | null;
  counting: boolean;
  countFailed: boolean;
  /** teacher_groups' active-student count — only a fallback hint when the exact count failed. */
  approxStudents: number;
};

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
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  // Guards the async recipient count: a count that returns after the panel was closed/reopened is dropped.
  const countReq = useRef(0);

  const trimmed = message.trim();
  const offline = offlineNow();
  const selected = groups.find((g) => g.id === groupId) ?? null;
  const locked = sending || confirm != null;

  // Step 1 — "Yuborish": open the confirmation panel and count the real recipients.
  const openConfirm = async () => {
    if (!groupId || !selected || !trimmed || sending) return;
    if (offlineNow()) {
      setResult({ kind: "error", message: "Internet yo'q. Ulanishni tekshiring va qayta urinib ko'ring." });
      return;
    }
    const req = ++countReq.current;
    setResult({ kind: "idle" });
    setConfirm({
      groupId,
      groupName: selected.name,
      courseName: selected.courseName,
      message: trimmed,
      recipients: null,
      noTelegram: null,
      counting: true,
      countFailed: false,
      approxStudents: selected.totalStudents,
    });
    try {
      const { data, error: rpcErr } = await supabase.rpc("staff_group_members", { _group_id: groupId });
      if (rpcErr) throw rpcErr;
      if (req !== countReq.current) return;
      const rows = data ?? [];
      const recipients = rows.filter((r) => r.telegram_id).length;
      setConfirm((c) => (c && c.groupId === groupId ? { ...c, recipients, noTelegram: rows.length - recipients, counting: false } : c));
    } catch (e) {
      if (req !== countReq.current) return;
      reportClientError({
        type: "other",
        message: "teacher_broadcast_count_failed",
        extra: { code: (e as { code?: string; message?: string })?.code ?? (e as { message?: string })?.message ?? null },
      });
      setConfirm((c) => (c && c.groupId === groupId ? { ...c, counting: false, countFailed: true } : c));
    }
  };

  const cancelConfirm = () => {
    countReq.current++;
    setConfirm(null);
  };

  // Step 2 — "Ha, yuborish": send exactly the confirmed snapshot.
  const handleSend = async () => {
    const c = confirm;
    if (!c || c.counting || c.recipients === 0 || sending) return;
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
        body: { group_id: c.groupId, message: c.message },
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
        groupName: c.groupName,
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
      setConfirm(null);
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
              drives the shared `setGroupId`. Every option names the COURSE too ("<group> · <course>"),
              so a 5.0 group and a Challenge 6.0 group can never look alike. */}
          <div className="min-w-0 space-y-1.5">
            <SectionHeader title="Guruh" />
            {groups.length === 1 ? (
              <div className="truncate rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-[15px] font-extrabold text-foreground">
                {groupWithCourse(groups[0].name, groups[0].courseName)}
              </div>
            ) : (
              <select
                aria-label="Guruh"
                value={groupId ?? ""}
                onChange={(e) => setGroupId(e.target.value)}
                disabled={locked}
                className="w-full min-w-0 rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm font-bold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              >
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {groupWithCourse(g.name, g.courseName)}
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
              aria-label="Xabar"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={MAX_LEN}
              rows={6}
              placeholder="Xabaringizni yozing…"
              disabled={locked}
              className="w-full min-w-0 resize-none rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            />
          </div>

          {result.kind === "success" && (
            <div className="min-w-0 space-y-1 rounded-lg border border-good/30 bg-good/10 px-3 py-2.5">
              <p className="break-words text-sm font-extrabold text-good-2">
                {`«${result.groupName}» guruhidagi ${result.sent} ta o'quvchiga xabar yuborildi`}
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

          {confirm ? (
            <div
              role="alertdialog"
              aria-labelledby="bcast-confirm-title"
              className="min-w-0 space-y-3 rounded-lg border border-cta/40 bg-cta/5 px-3 py-3"
            >
              <p id="bcast-confirm-title" className="text-[15px] font-extrabold tracking-tight text-foreground">
                Xabarni yuborishni tasdiqlang
              </p>
              <dl className="min-w-0 space-y-1.5 text-sm">
                <div className="flex min-w-0 gap-2">
                  <dt className="w-20 flex-none font-semibold text-muted-foreground">Guruh</dt>
                  <dd className="min-w-0 break-words font-extrabold text-foreground">{confirm.groupName}</dd>
                </div>
                <div className="flex min-w-0 gap-2">
                  <dt className="w-20 flex-none font-semibold text-muted-foreground">Kurs</dt>
                  <dd className="min-w-0 break-words font-extrabold text-foreground">{confirm.courseName || "—"}</dd>
                </div>
                <div className="flex min-w-0 gap-2">
                  <dt className="w-20 flex-none font-semibold text-muted-foreground">Kimga</dt>
                  <dd className="min-w-0 break-words font-extrabold text-foreground">
                    {confirm.counting ? (
                      <span className="inline-flex items-center gap-1.5 font-semibold text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" /> hisoblanmoqda…
                      </span>
                    ) : confirm.countFailed ? (
                      <span className="font-semibold text-muted-foreground">
                        {`aniqlab bo'lmadi (guruhda ~${confirm.approxStudents} ta o'quvchi)`}
                      </span>
                    ) : confirm.recipients === 0 ? (
                      <span className="text-danger-2">Bu guruhda Telegram'li o'quvchi yo'q</span>
                    ) : (
                      `${confirm.recipients} ta o'quvchi (Telegram orqali)`
                    )}
                  </dd>
                </div>
              </dl>
              {!confirm.counting && (confirm.noTelegram ?? 0) > 0 && (
                <p className="break-words text-xs font-semibold text-muted-foreground">
                  {`${confirm.noTelegram} ta o'quvchi Telegram'ni ulamagan — ularga xabar bormaydi`}
                </p>
              )}
              <p className="break-words text-xs font-semibold text-muted-foreground">
                Yuborilgan xabarni qaytarib bo'lmaydi. Keyingi xabarni 1 soatdan keyin yuborish mumkin.
              </p>
              <div className="flex gap-2">
                <Button variant="ghost" block onClick={cancelConfirm} disabled={sending}>
                  Bekor qilish
                </Button>
                <Button
                  variant="primary"
                  block
                  onClick={handleSend}
                  disabled={sending || confirm.counting || confirm.recipients === 0}
                >
                  {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                  Ha, yuborish
                </Button>
              </div>
            </div>
          ) : (
            /* The ONE coral primary on this screen — opens the confirmation, never sends by itself. */
            <Button variant="primary" block disabled={!groupId || !trimmed || sending} onClick={openConfirm}>
              <Send className="size-4" />
              Yuborish
            </Button>
          )}
        </Card>
      )}
    </div>
  );
}
