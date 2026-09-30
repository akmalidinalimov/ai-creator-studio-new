// Tests for the capture chat guard and the previous-course task guard.
// Run: deno test supabase/functions/telegram-bot-webhook/capture-guard.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  chatIdFromTelegramUrl, courseToken, findOwnHomeworkTopic, type GroupTopicConfig, homeworkTopicGroupIds,
  matchOwnHomeworkTopic, otherCourseTask, pickSubmissionModule, recordOtherCourseRefused, taskCourseVerdict,
} from "./capture-guard.ts";

// The live groups on 2026-09-30 (prod, read-only). Homework topic numbers collide across chats:
// 7 = PRE 5.0, 2-VIP 5.0 and AC 4-GURUH; 6 = AC 2-GURUH and AC 6-GURUH; 8 = 1-VIP 5.0's homework topic
// and AC 2-GURUH's networking topic.
const PRE5: GroupTopicConfig = { id: "35f246e4", homework_topic_id: 7, homework_topic_url: "https://t.me/c/3718576417/7", telegram_group_url: "https://t.me/+C3hKu1F2lw43NmQ0" };
const VIP1: GroupTopicConfig = { id: "6eea7030", homework_topic_id: 8, homework_topic_url: "https://t.me/c/4249393939/8", telegram_group_url: "https://t.me/+d58xyKDXtHJhYzdk" };
const VIP2: GroupTopicConfig = { id: "49d44eeb", homework_topic_id: 7, homework_topic_url: "https://t.me/c/4310467008/7", telegram_group_url: "https://t.me/+GUgxEQUJfVUzZTQ0" };
const AC2: GroupTopicConfig = { id: "c092a0db", homework_topic_id: 6, homework_topic_url: "https://t.me/c/4390902020/6", telegram_group_url: null };
const AC4: GroupTopicConfig = { id: "93e8e7b0", homework_topic_id: 7, homework_topic_url: "https://t.me/c/4463424516/7", telegram_group_url: null };
const AC6: GroupTopicConfig = { id: "f92fcc1d", homework_topic_id: 6, homework_topic_url: "https://t.me/c/4423411304/6", telegram_group_url: null };
const CHAT = {
  PRE5: -1003718576417, VIP1: -1004249393939, VIP2: -1004310467008, AC2: -1004390902020, AC4: -1004463424516, AC6: -1004423411304,
};

Deno.test("chatIdFromTelegramUrl: /c/ links → Bot API chat id; invite links and junk → null", () => {
  assertEquals(chatIdFromTelegramUrl("https://t.me/c/3718576417/7"), CHAT.PRE5);
  assertEquals(chatIdFromTelegramUrl("https://t.me/c/3718576417/7/1234"), CHAT.PRE5);
  assertEquals(chatIdFromTelegramUrl("http://t.me/c/4463424516/7"), CHAT.AC4);
  assertEquals(chatIdFromTelegramUrl("t.me/c/4463424516/7"), CHAT.AC4);
  assertEquals(chatIdFromTelegramUrl("  https://t.me/c/4390902020/6  "), CHAT.AC2);
  assertEquals(chatIdFromTelegramUrl("https://t.me/+C3hKu1F2lw43NmQ0"), null);
  assertEquals(chatIdFromTelegramUrl("https://t.me/c/abc/7"), null);
  assertEquals(chatIdFromTelegramUrl(null), null);
  assertEquals(chatIdFromTelegramUrl(""), null);
});

Deno.test("topic 7 in its own chat is the student's homework topic", () => {
  assertEquals(matchOwnHomeworkTopic({ chatId: CHAT.PRE5, threadId: 7 }, PRE5), { via: "shared" });
  assertEquals(matchOwnHomeworkTopic({ chatId: CHAT.VIP2, threadId: 7 }, VIP2), { via: "shared" });
  assertEquals(matchOwnHomeworkTopic({ chatId: CHAT.AC4, threadId: 7 }, AC4), { via: "shared" });
});

Deno.test("topic 7 in ANOTHER chat is never the student's homework topic (the August misfiles, and 5.0 ↔ Challenge)", () => {
  // A 2-GURUH VIP 5.0 student posting in the 1-GURUH PRE 5.0 chat, thread 7: the 4 real misfiles.
  assertEquals(matchOwnHomeworkTopic({ chatId: CHAT.PRE5, threadId: 7 }, VIP2), null);
  // PRE / 2-VIP 5.0 students posting in AC CHALLENGE | 4-GURUH's homework topic (also 7).
  assertEquals(matchOwnHomeworkTopic({ chatId: CHAT.AC4, threadId: 7 }, PRE5), null);
  assertEquals(matchOwnHomeworkTopic({ chatId: CHAT.AC4, threadId: 7 }, VIP2), null);
  // …and a 4-GURUH Challenge student posting in the 5.0 chats' thread 7.
  assertEquals(matchOwnHomeworkTopic({ chatId: CHAT.PRE5, threadId: 7 }, AC4), null);
  assertEquals(matchOwnHomeworkTopic({ chatId: CHAT.VIP2, threadId: 7 }, AC4), null);
});

Deno.test("topic 8: 1-VIP 5.0's homework topic, but only in 1-VIP's chat (not AC 2-GURUH networking)", () => {
  assertEquals(matchOwnHomeworkTopic({ chatId: CHAT.VIP1, threadId: 8 }, VIP1), { via: "shared" });
  assertEquals(matchOwnHomeworkTopic({ chatId: CHAT.AC2, threadId: 8 }, VIP1), null);
});

Deno.test("topic 6: AC 2-GURUH and AC 6-GURUH each own only their chat's 6", () => {
  assertEquals(matchOwnHomeworkTopic({ chatId: CHAT.AC2, threadId: 6 }, AC2), { via: "shared" });
  assertEquals(matchOwnHomeworkTopic({ chatId: CHAT.AC6, threadId: 6 }, AC2), null);
  assertEquals(matchOwnHomeworkTopic({ chatId: CHAT.AC2, threadId: 6 }, AC6), null);
  // 1-VIP 5.0's networking topic is 6 too: not a homework topic of anyone in that chat.
  assertEquals(matchOwnHomeworkTopic({ chatId: CHAT.VIP1, threadId: 6 }, AC2), null);
});

Deno.test("own chat, general topic → not a homework topic (members' own space)", () => {
  assertEquals(matchOwnHomeworkTopic({ chatId: CHAT.PRE5, threadId: 3 }, PRE5), null);
  assertEquals(matchOwnHomeworkTopic({ chatId: CHAT.PRE5, threadId: 1 }, PRE5), null);
});

Deno.test("a group without a /c/ homework URL has no shared topic (homework_topic_id alone is not enough)", () => {
  const noUrl: GroupTopicConfig = { id: "g", homework_topic_id: 7, homework_topic_url: null, telegram_group_url: null };
  assertEquals(matchOwnHomeworkTopic({ chatId: CHAT.PRE5, threadId: 7 }, noUrl), null);
});

Deno.test("per-module topics: matched in the chat of their own URL, else the group's chat", () => {
  const mt = (url: string | null) => [{ module_id: "m-4", telegram_topic_id: 42, telegram_topic_url: url }];
  assertEquals(matchOwnHomeworkTopic({ chatId: CHAT.VIP2, threadId: 42 }, VIP2, mt("https://t.me/c/4310467008/42")), { via: "module", moduleId: "m-4" });
  assertEquals(matchOwnHomeworkTopic({ chatId: CHAT.AC4, threadId: 42 }, VIP2, mt("https://t.me/c/4310467008/42")), null);
  // A module URL that is not a /c/ link falls back to the group's chat.
  assertEquals(matchOwnHomeworkTopic({ chatId: CHAT.VIP2, threadId: 42 }, VIP2, mt(null)), { via: "module", moduleId: "m-4" });
  assertEquals(matchOwnHomeworkTopic({ chatId: CHAT.AC4, threadId: 42 }, VIP2, mt(null)), null);
  // Another thread number never matches.
  assertEquals(matchOwnHomeworkTopic({ chatId: CHAT.VIP2, threadId: 43 }, VIP2, mt(null)), null);
});

// ---- I/O wrappers over a tiny in-memory PostgREST stand-in ----------------------------------------------

type Row = Record<string, any>;
function fakeDb(tables: Record<string, Row[]>, opts: { failOn?: string } = {}) {
  const inserted: Row[] = [];
  const from = (table: string) => {
    if (opts.failOn === table) throw new Error("db down");
    const filters: Array<(r: Row) => boolean> = [];
    const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const q: any = {
      select: (_c: string) => q,
      eq: (c: string, v: unknown) => { filters.push((r) => (c === "details->>dedupe_key" ? r.details?.dedupe_key : r[c]) === v); return q; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return q; },
      gte: (_c: string, _v: string) => q,
      limit: (_n: number) => q,
      or: (f: string) => {
        const alts = f.split(",").map((p) => { const [col, , pat] = p.split("."); return { col, needle: pat.replace(/%/g, "") }; });
        filters.push((r) => alts.some((a) => String(r[a.col] ?? "").includes(a.needle)));
        return q;
      },
      maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      insert: (row: Row) => { inserted.push(row); (tables[table] ??= []).push({ ...row }); return Promise.resolve({ error: null }); },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(res, rej),
    };
    return q;
  };
  return { admin: { from }, inserted };
}

Deno.test("findOwnHomeworkTopic: shared topic needs no read; a module topic is read for this thread only", async () => {
  const { admin } = fakeDb({
    group_module_topics: [
      { group_id: VIP2.id, module_id: "m-2", telegram_topic_id: 42, telegram_topic_url: "https://t.me/c/4310467008/42" },
      { group_id: AC4.id, module_id: "m-9", telegram_topic_id: 42, telegram_topic_url: "https://t.me/c/4463424516/42" },
    ],
  });
  assertEquals(await findOwnHomeworkTopic(admin, VIP2, CHAT.VIP2, 7), { via: "shared" });
  assertEquals(await findOwnHomeworkTopic(admin, VIP2, CHAT.VIP2, 42), { via: "module", moduleId: "m-2" });
  assertEquals(await findOwnHomeworkTopic(admin, VIP2, CHAT.AC4, 42), null);
  assertEquals(await findOwnHomeworkTopic(admin, VIP2, CHAT.PRE5, 7), null);
  assertEquals(await findOwnHomeworkTopic(fakeDb({}, { failOn: "group_module_topics" }).admin, VIP2, CHAT.VIP2, 42), null);
});

Deno.test("homeworkTopicGroupIds: the redirect fires only inside another group's HOMEWORK topic", async () => {
  const { admin } = fakeDb({ groups: [PRE5, VIP1, VIP2, AC2, AC4, AC6], group_module_topics: [] });
  // The PRE chat's thread 7 belongs to PRE only (2-VIP's 7 lives in another chat).
  assertEquals(await homeworkTopicGroupIds(admin, CHAT.PRE5, 7), [PRE5.id]);
  assertEquals(await homeworkTopicGroupIds(admin, CHAT.AC4, 7), [AC4.id]);
  // AC 2-GURUH's networking topic 8 is nobody's homework topic, whatever 1-VIP's number is.
  assertEquals(await homeworkTopicGroupIds(admin, CHAT.AC2, 8), []);
  // General chat of a group → nobody's.
  assertEquals(await homeworkTopicGroupIds(admin, CHAT.PRE5, 3), []);
  // Unknown chat / db error → silent.
  assertEquals(await homeworkTopicGroupIds(admin, -1009999999999, 7), []);
  assertEquals(await homeworkTopicGroupIds(fakeDb({}, { failOn: "groups" }).admin, CHAT.PRE5, 7), []);
});

Deno.test("homeworkTopicGroupIds: a chat shared by two groups returns only the group whose topic it is", async () => {
  const OLD = { id: "old-4.0", homework_topic_id: 5, homework_topic_url: "https://t.me/c/3718576417/5", telegram_group_url: null };
  const { admin } = fakeDb({ groups: [PRE5, OLD], group_module_topics: [] });
  assertEquals(await homeworkTopicGroupIds(admin, CHAT.PRE5, 7), [PRE5.id]);
  assertEquals(await homeworkTopicGroupIds(admin, CHAT.PRE5, 5), ["old-4.0"]);
});

const C50 = "78011384-4024-49b0-b72d-b0b2e3a04ee8";
const C60 = "f502f631-2104-4834-b6c2-702cd3080e27";

Deno.test("taskCourseVerdict: refuses only a proven mismatch", () => {
  assertEquals(taskCourseVerdict(C50, [C50]), { ok: true });
  assertEquals(taskCourseVerdict(C50, [C60]), { ok: false, taskCourseId: C50, currentCourseIds: [C60] });
  assertEquals(taskCourseVerdict(C50, [C60, C50]), { ok: true });
  assertEquals(taskCourseVerdict(null, [C60]), { ok: true });
  assertEquals(taskCourseVerdict(C50, []), { ok: true });
  assertEquals(taskCourseVerdict(C50, [null, ""]), { ok: true });
});

Deno.test("otherCourseTask: a 5.0 task for a student now in a Challenge group is refused; own-course passes", async () => {
  const { admin } = fakeDb({
    homework_assignments: [{ id: "a-50", module_id: "m-50" }, { id: "a-60", module_id: "m-60" }],
    modules: [{ id: "m-50", course_id: C50 }, { id: "m-60", course_id: C60 }],
  });
  const inChallenge = (_u: string) => Promise.resolve([C60]);
  assertEquals(await otherCourseTask(admin, "u-1", { assignmentId: "a-50" }, inChallenge), { taskCourseId: C50, currentCourseIds: [C60] });
  assertEquals(await otherCourseTask(admin, "u-1", { moduleId: "m-50" }, inChallenge), { taskCourseId: C50, currentCourseIds: [C60] });
  assertEquals(await otherCourseTask(admin, "u-1", { assignmentId: "a-60" }, inChallenge), null);
  // Unknown task / unreadable course → not refused (the capture and tier gates still apply).
  assertEquals(await otherCourseTask(admin, "u-1", { assignmentId: "missing" }, inChallenge), null);
  assertEquals(await otherCourseTask(fakeDb({}, { failOn: "modules" }).admin, "u-1", { moduleId: "m-50" }, inChallenge), null);
});

Deno.test("recordOtherCourseRefused: one admin_actions row per path/student/course/day", async () => {
  const { admin, inserted } = fakeDb({ admin_actions: [] });
  const mm = { taskCourseId: C50, currentCourseIds: [C60] };
  await recordOtherCourseRefused(admin, "hw:resub_yes", "u-rec-1", mm, { assignment_id: "a-50" });
  await recordOtherCourseRefused(admin, "hw:resub_yes", "u-rec-1", mm, { assignment_id: "a-50" });
  await recordOtherCourseRefused(admin, "hw:start", "u-rec-1", mm);
  assertEquals(inserted.length, 2);
  assertEquals(inserted[0].action, "stale_course_button_refused");
  assertEquals(inserted[0].target_user_id, "u-rec-1");
  assertEquals(inserted[0].details.path, "hw:resub_yes");
  assertEquals(inserted[0].details.task_course_id, C50);
  assertEquals(inserted[0].details.current_course_ids, [C60]);
  assertEquals(inserted[0].details.assignment_id, "a-50");
  assertEquals(inserted[0].details.source, "telegram-bot-webhook");
  assertEquals(inserted[1].details.path, "hw:start");
});

Deno.test("pickSubmissionModule: the course token disambiguates a student with work in two courses", () => {
  const subs = [
    { id: "m50-p0", position: 0, course_id: C50 },
    { id: "m60-p0", position: 0, course_id: C60 },
    { id: "m50-p5", position: 5, course_id: C50 },
    { id: "m50-p0", position: 0, course_id: C50 }, // duplicates (one row per submission) are fine
  ];
  assertEquals(pickSubmissionModule(subs, 0, { coursePrefix: courseToken(C50), currentCourseId: C60 }), "m50-p0");
  assertEquals(pickSubmissionModule(subs, 0, { coursePrefix: courseToken(C60), currentCourseId: C50 }), "m60-p0");
  // Legacy button (no token): prefer the current course, else the lowest course id.
  assertEquals(pickSubmissionModule(subs, 0, { currentCourseId: C60 }), "m60-p0");
  assertEquals(pickSubmissionModule(subs, 0, {}), "m50-p0");
  // One candidate: it wins even when it is not the current course (the submission's own course).
  assertEquals(pickSubmissionModule(subs, 5, { currentCourseId: C60 }), "m50-p5");
  assertEquals(pickSubmissionModule(subs, 3, { currentCourseId: C60 }), null);
});

Deno.test("tr:mod callback with the course token stays under Telegram's 64-byte cap", () => {
  const sid = "e7911541-0000-4000-8000-000000000000";
  const data = `tr:mod:${sid}:${99}:${courseToken(C60)}`;
  assertEquals(courseToken(C60), "f502f631");
  assertEquals(new TextEncoder().encode(data).length <= 64, true);
});
