// Pins the bot's reading of student_course_groups (multi-course PR 3a): the course scope (main only vs main +
// secondary, an unpublished secondary left out), the task scope, the group of a task's course, which secondary
// group owns a (chat, thread) homework topic, and the auto-add switch (missing / malformed config = no auto-add).
// Run: deno test supabase/functions/telegram-bot-webhook/multi-course.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _resetAutoAddCache, autoAddTopicCandidate, courseScopeIds, groupForTaskCourse,
  loadAutoAddCourseIds, loadStudentCourseGroups, parseAutoAddConfig, pickCaptureGroup,
  type StudentCourseGroups, taskScopeIds,
} from "./multi-course.ts";
import { FakeDb } from "../_bot/testing/fake-db.ts";

const C7 = "11111111-1111-4111-8111-111111111111"; // main course (7.0)
const CS = "36e79750-6dd6-4f1d-ac6f-c74c7237ec86"; // CLAUDE STUDIO
const CX = "33333333-3333-4333-8333-333333333333"; // another course
const G7 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // CLAUDE STUDIO | 1 - GURUH
const GH = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // CLAUDE STUDIO | KANAL (holding)
const GX = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const single: StudentCourseGroups = { main: { group_id: G7, course_id: C7, published: true }, secondary: [] };
const multi: StudentCourseGroups = {
  main: { group_id: G7, course_id: C7, published: true },
  secondary: [{ group_id: GS, course_id: CS, published: true }],
};

Deno.test("courseScopeIds: one course = exactly the main course (unchanged single-course answer)", () => {
  assertEquals(courseScopeIds(single), [C7]);
});

Deno.test("courseScopeIds: main first, then each published secondary course", () => {
  assertEquals(courseScopeIds(multi), [C7, CS]);
});

Deno.test("courseScopeIds: an unpublished secondary course is left out; an unpublished main leaves the secondaries", () => {
  const sc: StudentCourseGroups = {
    main: { group_id: G7, course_id: C7, published: true },
    secondary: [{ group_id: GS, course_id: CS, published: false }, { group_id: GX, course_id: CX, published: true }],
  };
  assertEquals(courseScopeIds(sc), [C7, CX]);
  assertEquals(courseScopeIds({ ...sc, main: { group_id: G7, course_id: C7, published: false } }), [CX]);
  // nothing published → [] (the caller falls back to enrollments / default course, as before)
  assertEquals(courseScopeIds({ main: { group_id: G7, course_id: C7, published: false }, secondary: [] }), []);
  assertEquals(courseScopeIds({ main: null, secondary: [] }), []);
});

Deno.test("taskScopeIds: main ∪ secondary, published or not; nothing else", () => {
  assertEquals(taskScopeIds(single), [C7]);
  assertEquals(taskScopeIds(multi), [C7, CS]);
  assertEquals(taskScopeIds({ main: { group_id: G7, course_id: C7, published: false }, secondary: [{ group_id: GS, course_id: CS, published: false }] }), [C7, CS]);
  assertEquals(taskScopeIds({ main: { group_id: G7, course_id: null, published: false }, secondary: [] }), []);
});

Deno.test("groupForTaskCourse: a secondary course's task → its group; anything else → the main group", () => {
  assertEquals(groupForTaskCourse(CS, multi), GS);
  assertEquals(groupForTaskCourse(C7, multi), G7);
  assertEquals(groupForTaskCourse(CX, multi), G7);
  assertEquals(groupForTaskCourse(null, multi), G7);
  assertEquals(groupForTaskCourse(CS, single), G7);
  assertEquals(groupForTaskCourse(CS, { main: null, secondary: [] }), null);
});

Deno.test("pickCaptureGroup: the secondary group whose homework topic this is; none for a stranger's topic", () => {
  assertEquals(pickCaptureGroup([GS], multi.secondary)?.group_id, GS);
  assertEquals(pickCaptureGroup([GX, GS], multi.secondary)?.course_id, CS);
  assertEquals(pickCaptureGroup([GX], multi.secondary), null);
  assertEquals(pickCaptureGroup([], multi.secondary), null);
  assertEquals(pickCaptureGroup([GS], []), null);
});

Deno.test("parseAutoAddConfig: missing / malformed = [] (no auto-add); valid uuids kept, lower-cased, deduped", () => {
  assertEquals(parseAutoAddConfig(null), []);
  assertEquals(parseAutoAddConfig(undefined), []);
  assertEquals(parseAutoAddConfig("x"), []);
  assertEquals(parseAutoAddConfig([CS]), []);
  assertEquals(parseAutoAddConfig({}), []);
  assertEquals(parseAutoAddConfig({ auto_add_course_ids: CS }), []);
  assertEquals(parseAutoAddConfig({ auto_add_course_ids: [1, null, "nope", {}] }), []);
  assertEquals(parseAutoAddConfig({ auto_add_course_ids: [CS, CS.toUpperCase(), " " + CX + " "] }), [CS, CX]);
});

Deno.test("loadAutoAddCourseIds: no platform_settings row / unreadable table = []", async () => {
  _resetAutoAddCache();
  assertEquals(await loadAutoAddCourseIds(new FakeDb({ platform_settings: [] })), []);
  _resetAutoAddCache();
  const broken = new FakeDb({});
  broken.failOn.add("platform_settings");
  assertEquals(await loadAutoAddCourseIds(broken), []);
  _resetAutoAddCache();
  const db = new FakeDb({ platform_settings: [{ key: "multi_course", value: { auto_add_course_ids: [CS] } }] });
  assertEquals(await loadAutoAddCourseIds(db), [CS]);
  _resetAutoAddCache();
});

Deno.test("loadStudentCourseGroups: main from profiles.group_id, secondaries from student_course_groups (never the main course)", async () => {
  const db = new FakeDb({
    profiles: [{ id: "u1", group_id: G7 }, { id: "u2", group_id: G7 }],
    groups: [{ id: G7, course_id: C7, courses: { published: true } }],
    student_course_groups: [
      { user_id: "u1", course_id: C7, group_id: G7, is_main: true, courses: { published: true } },
      { user_id: "u1", course_id: CS, group_id: GS, is_main: false, courses: { published: true } },
      { user_id: "u1", course_id: CX, group_id: GX, is_main: false, courses: { published: false } },
    ],
  });
  const sc = await loadStudentCourseGroups(db, "u1");
  assertEquals(sc.main, { group_id: G7, course_id: C7, published: true });
  assertEquals(sc.secondary, [
    { group_id: GS, course_id: CS, published: true },
    { group_id: GX, course_id: CX, published: false },
  ]);
  assertEquals(courseScopeIds(sc), [C7, CS]);
  const one = await loadStudentCourseGroups(db, "u2");
  assertEquals(courseScopeIds(one), [C7]);
  // the secondary table unreadable → single-course answer, never a crash
  db.failOn.add("student_course_groups");
  assertEquals(courseScopeIds(await loadStudentCourseGroups(db, "u1")), [C7]);
});

const COURSES = [
  { id: CS, published: true, channel_group_id: GH, telegram_channel_chat_id: "-1003000000001" },
  { id: CX, published: false, channel_group_id: null },
];

Deno.test("autoAddTopicCandidate: an auto-add course they are not in → that group; never main / other / holding / ambiguous", () => {
  assertEquals(autoAddTopicCandidate([{ id: GS, course_id: CS }], [CS], COURSES, single), { group_id: GS, course_id: CS });
  // not in the list
  assertEquals(autoAddTopicCandidate([{ id: GS, course_id: CS }], [], COURSES, single), null);
  // unpublished course
  assertEquals(autoAddTopicCandidate([{ id: GX, course_id: CX }], [CX], COURSES, single), null);
  // their main course: a move, never an add
  assertEquals(autoAddTopicCandidate([{ id: GS, course_id: CS }], [CS], COURSES,
    { main: { group_id: GH, course_id: CS, published: true }, secondary: [] }), null);
  // already in a real group of it
  assertEquals(autoAddTopicCandidate([{ id: GS, course_id: CS }], [CS], COURSES, multi), null);
  // only in its channel holding group → moved into the real group they post in
  assertEquals(autoAddTopicCandidate([{ id: GS, course_id: CS }], [CS], COURSES,
    { main: single.main, secondary: [{ group_id: GH, course_id: CS, published: true }] }), { group_id: GS, course_id: CS });
  // the holding group itself is never a topic target
  assertEquals(autoAddTopicCandidate([{ id: GH, course_id: CS }], [CS], COURSES, single), null);
  // two candidate groups behind one topic → ambiguous
  assertEquals(autoAddTopicCandidate([{ id: GS, course_id: CS }, { id: GX, course_id: CS }], [CS], COURSES, single), null);
});

Deno.test("capture group from (chat, thread): same topic number in the main and the secondary chat resolves per chat", async () => {
  const { matchOwnHomeworkTopic } = await import("./capture-guard.ts");
  const groups = [
    { id: G7, homework_topic_id: 7, homework_topic_url: "https://t.me/c/2000000000/7", telegram_group_url: null },
    { id: GS, homework_topic_id: 7, homework_topic_url: "https://t.me/c/3000000002/7", telegram_group_url: null },
    { id: GX, homework_topic_id: 7, homework_topic_url: "https://t.me/c/4000000004/7", telegram_group_url: null },
  ];
  // homeworkTopicGroupIds' rule, then the student's own groups
  const owners = (chatId: number, threadId: number) =>
    groups.filter((g) => matchOwnHomeworkTopic({ chatId, threadId }, g)).map((g) => g.id);
  const capture = (chatId: number, threadId: number) => {
    const ids = owners(chatId, threadId);
    if (ids.includes(multi.main!.group_id)) return multi.main!.group_id; // the main group's topic: as today
    return pickCaptureGroup(ids, multi.secondary)?.group_id ?? null;
  };
  assertEquals(capture(-1002000000000, 7), G7);
  assertEquals(capture(-1003000000002, 7), GS);
  assertEquals(capture(-1004000000004, 7), null); // a stranger's group: the foreign-topic redirect, as today
  assertEquals(capture(-1003000000002, 8), null); // not a homework topic: general chat, silent
});
