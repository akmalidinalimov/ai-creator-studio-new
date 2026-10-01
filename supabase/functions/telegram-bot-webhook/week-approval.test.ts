// Tests for the dtw: weekly approval buttons (Daily Tasks PR-9) against a fake Supabase client and a recording Bot API.
// Run: deno test supabase/functions/telegram-bot-webhook/week-approval.test.ts
// The same flow against the REAL SQL: _challenge/testing/daily-tasks-week-approval-check.ts.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { approveErrorToast, approveToast, createWeekApproval, TOAST, toApproveResult } from "./week-approval.ts";
import { BTN } from "../_shared/week-approval.ts";

type Call = { method: string; payload: Record<string, unknown> };

function world(opts: { admins?: string[]; approve?: unknown; approveError?: { code?: string; message?: string } | null; today?: string } = {}) {
  const admins = new Set(opts.admins ?? ["admin-1"]);
  const rpcs: Array<{ name: string; args: Record<string, unknown> }> = [];
  const inserts: Array<Record<string, unknown>> = [];
  let drafts = 2;
  const tasks = () => [
    { id: 1, date: "2026-10-05", type: "general", title: "Birinchi", status: drafts > 0 ? "draft" : "approved", points: 5, requires: [] },
    { id: 2, date: "2026-10-06", type: "instagram", title: "Ikkinchi", status: drafts > 1 ? "draft" : "approved", points: 8, requires: [] },
  ];
  const copies = [
    { id: 11, chat_id: 501, message_id: 9001, kind: "ask" },     // the tapped one
    { id: 12, chat_id: 502, message_id: 9002, kind: "ask" },     // the other admin
    { id: 13, chat_id: 502, message_id: 9100, kind: "remind" },
  ];
  const admin = {
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args });
      if (name === "challenge_task_week_view") {
        return Promise.resolve({
          data: { week_start: "2026-10-05", week_end: "2026-10-11", tasks: tasks(), missing: [], ...(opts.today ? { today: opts.today } : {}) },
          error: null,
        });
      }
      if (name === "challenge_tasks_approve_week") {
        if (opts.approveError) return Promise.resolve({ data: null, error: opts.approveError });
        const res = opts.approve ?? { ok: true, approved: drafts, already_approved: 2 - drafts, failed: [], actor_name: "Bahrom" };
        drafts = 0;
        return Promise.resolve({ data: res, error: null });
      }
      if (name === "challenge_task_week_edits_record") return Promise.resolve({ data: { ok: true }, error: null });
      return Promise.resolve({ data: null, error: { code: "PGRST202", message: "no " + name } });
    },
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "gte", "limit"]) b[m] = () => b;
      b.insert = (row: Record<string, unknown>) => { inserts.push({ table, ...row }); return Promise.resolve({ error: null }); };
      b.then = (ok: (r: unknown) => unknown) =>
        Promise.resolve({ data: table === "challenge_task_week_approval_messages" ? copies : [], error: null }).then(ok);
      return b;
    },
  };
  const calls: Call[] = [];
  const toasts: Array<string | undefined> = [];
  const wa = createWeekApproval({
    send: (method, payload) => {
      calls.push({ method, payload });
      return Promise.resolve({ outcome: { ok: true, status: 200, error: null, terminal: false, recipient: false, content: false, klass: "ok", retryAfterSec: null }, result: true });
    },
    answerCallback: (_id, text) => { toasts.push(text); return Promise.resolve(); },
    isAdmin: (_a, uid) => Promise.resolve(admins.has(uid)),
  });
  const cq = (data: string, from = 7001) => ({ id: "cq1", data, from: { id: from }, message: { message_id: 9001, chat: { id: 501 } } });
  return { admin, wa, rpcs, calls, toasts, inserts, cq };
}

Deno.test("dtw:a -> the confirm step in place; dtw:b -> back to the listing", async () => {
  const w = world();
  await w.wa.onCallback(w.admin, w.cq("dtw:a:20261005"), { clicker: { id: "admin-1" }, impersonating: false });
  assertEquals(w.calls.length, 1);
  assertEquals(w.calls[0].method, "editMessageText");
  assertEquals(w.calls[0].payload.message_id, 9001);
  assert(String(w.calls[0].payload.text).includes("2 ta vazifa tasdiqlansinmi?"));
  assertEquals((w.calls[0].payload.reply_markup as any).inline_keyboard[0].map((b: any) => b.callback_data), ["dtw:y:20261005", "dtw:b:20261005"]);
  await w.wa.onCallback(w.admin, w.cq("dtw:b:20261005"), { clicker: { id: "admin-1" }, impersonating: false });
  assertEquals((w.calls[1].payload.reply_markup as any).inline_keyboard[0][0].text, BTN.approve);
  assertEquals(w.rpcs.filter((r) => r.name === "challenge_tasks_approve_week").length, 0, "nothing approved without the confirm");
});

Deno.test("dtw:y -> the RPC with the REAL clicker as actor; tapped message + the other admins' copies become the result", async () => {
  const w = world();
  await w.wa.onCallback(w.admin, w.cq("dtw:y:20261005"), { clicker: { id: "admin-1", name: "Bahrom" }, impersonating: false });
  const ap = w.rpcs.find((r) => r.name === "challenge_tasks_approve_week");
  assertEquals(ap?.args, { _week_start: "2026-10-05", _actor: "admin-1" });
  assertEquals(w.toasts, ["✅ 2 ta tasdiqlandi"]);
  const edits = w.calls.filter((c) => c.method === "editMessageText");
  assertEquals(edits.map((e) => e.payload.message_id), [9001, 9002, 9100], "tapped first, then every other copy");
  assert(String(edits[0].payload.text).includes("2/2 tasdiqlandi"), String(edits[0].payload.text));
  assert(String(edits[0].payload.text).includes("Bahrom"));
  const rec = w.rpcs.find((r) => r.name === "challenge_task_week_edits_record");
  assertEquals((rec?.args._results as any[]).map((r) => [r.id, r.ok]), [[11, true], [12, true], [13, true]]);
  // a second tap (double tap / another admin): approved 0 -> "allaqachon tasdiqlangan", copies untouched
  const before = w.calls.length;
  await w.wa.onCallback(w.admin, w.cq("dtw:y:20261005"), { clicker: { id: "admin-1", name: "Bahrom" }, impersonating: false });
  assertEquals(w.toasts.at(-1), TOAST.already);
  assertEquals(w.calls.length - before, 1, "only the tapped message is edited");
  assert(String(w.calls.at(-1)!.payload.text).includes("allaqachon tasdiqlangan"));
});

Deno.test("refused: a non-admin clicker (recorded), an impersonating admin, a stale / forged button", async () => {
  const w = world({ admins: ["admin-1"] });
  await w.wa.onCallback(w.admin, w.cq("dtw:y:20261005", 8888), { clicker: { id: "student-1" }, impersonating: false });
  await w.wa.onCallback(w.admin, w.cq("dtw:y:20261005", 8889), { clicker: null, impersonating: false });
  await w.wa.onCallback(w.admin, w.cq("dtw:y:20261005"), { clicker: { id: "admin-1" }, impersonating: true });
  await w.wa.onCallback(w.admin, w.cq("dtw:y:20261006"), { clicker: { id: "admin-1" }, impersonating: false });
  assertEquals(w.toasts, [TOAST.adminOnly, TOAST.adminOnly, TOAST.readOnly, TOAST.stale]);
  assertEquals(w.rpcs.filter((r) => r.name === "challenge_tasks_approve_week").length, 0);
  assertEquals(w.calls.length, 0);
  assertEquals(w.inserts.filter((i) => i.action === "challenge_week_approval_refused").length, 2);
});

Deno.test("an RPC error is a toast + a DB-visible row, never a silent tap", async () => {
  const w = world({ approveError: { code: "42501", message: "Faqat admin haftani tasdiqlay oladi" } });
  await w.wa.onCallback(w.admin, w.cq("dtw:y:20261005"), { clicker: { id: "admin-1" }, impersonating: false });
  assertEquals(w.toasts, [TOAST.adminOnly]);
  assertEquals(w.inserts.filter((i) => i.action === "challenge_week_approval_failed").length, 1);
  assertEquals(approveErrorToast({ code: "P0001", message: "boom" }), TOAST.error);
  assertEquals(toApproveResult({ ok: false }), null);
  assertEquals(toApproveResult({ ok: true, approved: 3, already_approved: 1, failed: [] })?.approved, 3);
});

Deno.test("a week that is over: «Bu hafta o‘tib ketdi», no approval call, the copy loses its buttons, recorded once", async () => {
  const w = world({ today: "2026-10-14", admins: ["admin-past"] });
  await w.wa.onCallback(w.admin, w.cq("dtw:a:20261005"), { clicker: { id: "admin-past" }, impersonating: false });
  await w.wa.onCallback(w.admin, w.cq("dtw:y:20261005"), { clicker: { id: "admin-past" }, impersonating: false });
  assertEquals(w.toasts, [TOAST.pastWeek, TOAST.pastWeek]);
  assertEquals(w.rpcs.filter((r) => r.name === "challenge_tasks_approve_week").length, 0, "never approves a past week");
  const edits = w.calls.filter((c) => c.method === "editMessageText");
  assertEquals(edits.length, 2);
  assert(edits.every((e) => String(e.payload.text).startsWith("⌛ <b>Bu hafta o‘tib ketdi") && !JSON.stringify(e.payload.reply_markup).includes("dtw:")));
  const rows = w.inserts.filter((i) => i.action === "challenge_week_approval_past_week");
  assertEquals(rows.length, 1, "once per admin, week and day");
  assertEquals((rows[0].details as Record<string, unknown>).week, "2026-10-05");
});

Deno.test("mid-week: the confirm counts today and later only; past drafts left alone -> said so", async () => {
  const w = world({ today: "2026-10-06" }); // Tuesday: Monday's draft is past, Tuesday's (today) is approvable
  await w.wa.onCallback(w.admin, w.cq("dtw:a:20261005"), { clicker: { id: "admin-1" }, impersonating: false });
  const t = String(w.calls[0].payload.text);
  assert(t.startsWith("📅 <b>Shu hafta vazifalari") && t.includes("❓ <b>1 ta vazifa tasdiqlansinmi?</b>") &&
    t.includes("⌛ O‘tgan kunlardagi 1 ta qoralama kiritilmaydi"), t);
  const past = [{ task_id: 1, date: "2026-10-05", title: "Birinchi", reason: "o‘tgan kun" }];
  assertEquals(approveToast({ approved: 0, already_approved: 1, failed: [], skipped_past: past }), TOAST.pastDays);
  assertEquals(approveToast({ approved: 0, already_approved: 0, failed: [], skipped_past: past, past_week: true }), TOAST.pastWeek);
  assertEquals(approveToast({ approved: 0, already_approved: 3, failed: [] }), TOAST.already);
  assertEquals(approveToast({ approved: 1, already_approved: 0, failed: [], skipped_past: past }), "✅ 1 ta tasdiqlandi");
  assertEquals(toApproveResult({ ok: true, approved: 1, skipped_past: [past[0], 7], past_week: false })?.skipped_past, past);
});

Deno.test("partial: the guard refused one draft -> failures listed, copies updated, approve button kept", async () => {
  const w = world({ approve: { ok: true, approved: 1, already_approved: 0, failed: [{ date: "2026-10-06", title: "Ikkinchi", error: "Instagram vazifasi skrinshot va Instagram havolasini talab qilishi kerak" }], actor_name: "Admin" } });
  await w.wa.onCallback(w.admin, w.cq("dtw:y:20261005"), { clicker: { id: "admin-1" }, impersonating: false });
  assertEquals(w.toasts, ["⚠️ 1 ta tasdiqlandi, 1 ta xato"]);
  const t = String(w.calls[0].payload.text);
  assert(t.includes("1/2 tasdiqlandi") && t.includes("Tasdiqlanmadi (1)") && t.includes("Instagram havolasini"), t);
});
