import { describe, it, expect } from "vitest";
import plan from "./__fixtures__/challenge6-daily-tasks-plan.json";
import {
  acceptsFor, addDays, buildImportRows, configWeekdays, deriveFromFormat, isIsoDate, isoWeekday, parseMessageUrl, parsePlan,
  planRef, requiresProblem, requiresValid, REQUIRES_MSG, scheduleDates, tashkentToday, telegramHtmlRuns, textOnlySatisfiable,
  type RequiresGroup,
} from "./dailyTasksPlan";

// The SQL mirrors (challenge_task_requires_valid / _requires_problem / _parse_message_url) are checked against this
// module fixture-by-fixture in supabase/functions/_challenge/testing/daily_tasks_calendar_test.ts.

const SHOT = { any: ["photo", "image_doc"], min: 1, label: "screenshot" } as RequiresGroup;
const TEXT = { any: ["text"], min: 1, label: "text" } as RequiresGroup;
const IG = { any: ["ig_link"], min: 1, label: "ig_link" } as RequiresGroup;

describe("deriveFromFormat: every format in the owner's 25-task plan", () => {
  const cases: [string, "general" | "instagram", RequiresGroup[], string[], number | null, string[]][] = [
    ["screenshot (2)", "general", [SHOT], ["text", "photo", "document"], null, ["count:2"]],
    ["text + screenshot", "general", [TEXT, SHOT], ["text", "photo", "document"], null, []],
    ["file (.xlsx/.csv) or screenshot", "general",
      [{ any: ["photo", "image_doc", "document"], min: 1, label: "file" }], ["text", "photo", "document"], null, ["note:-"]],
    ["Instagram post: screenshot + link", "instagram", [SHOT, IG], ["text", "photo", "document", "link"], null, []],
    ["image (3) + text (3 prompts)", "general", [SHOT, TEXT], ["text", "photo", "document"], null, ["count:3", "count:3"]],
    ["Instagram carousel: screenshot + link", "instagram", [SHOT, IG], ["text", "photo", "document", "link"], null, []],
    ["image (2) + text", "general", [SHOT, TEXT], ["text", "photo", "document"], null, ["count:2"]],
    ["video + text", "general", [{ any: ["video", "video_doc"], min: 1, label: "video" }, TEXT], ["text", "video", "document"], null, []],
    ["Instagram Reel: screenshot + link", "instagram", [SHOT, IG], ["text", "photo", "document", "link"], null, []],
    ["video (2) + text", "general", [{ any: ["video", "video_doc"], min: 1, label: "video" }, TEXT], ["text", "video", "document"], null, ["count:2"]],
    ["screenshot + text", "general", [SHOT, TEXT], ["text", "photo", "document"], null, []],
    ["screenshot + file", "general", [SHOT, { any: ["image_doc", "document"], min: 1, label: "file" }], ["text", "photo", "document"], null, []],
    ["screenshot", "general", [SHOT], ["text", "photo", "document"], null, []],
    ["text (or screenshot)", "general", [{ any: ["text", "photo", "image_doc"], min: 1, label: "text" }], ["text", "photo", "document"], null, []],
    ["text, screenshot or link", "general",
      [{ any: ["text", "photo", "image_doc", "link"], min: 1, label: "text" }], ["text", "photo", "document", "link"], null, []],
    ["voice (or round video note)", "general",
      [{ any: ["voice", "video_note", "audio"], min: 1, label: "voice" }], ["text", "voice", "video_note", "audio"], 20, []],
    ["screenshot (up to 3)", "general", [SHOT], ["text", "photo", "document"], null, ["count:-"]],
  ];
  for (const [format, type, requires, accepts, minDur, flags] of cases) {
    it(format, () => {
      const d = deriveFromFormat(format, type);
      expect(d.error).toBeNull();
      expect(d.requires).toEqual(requires);
      expect(d.accepts).toEqual(accepts);
      expect(d.minDurationSec).toBe(minDur);
      expect(d.flags.map((f) => `${f.kind}:${f.suggestedMin ?? "-"}`)).toEqual(flags);
      expect(requiresProblem(type, d.requires, d.accepts)).toBeNull();
    });
  }
  it("the fixture's formats are exactly the ones covered above", () => {
    const formats = new Set(plan.weeks.flatMap((w) => w.tasks.map((t) => t.format)));
    expect([...formats].sort()).toEqual(cases.map((c) => c[0]).sort());
  });
  it("'(N)' is never turned into a minimum", () => {
    expect(deriveFromFormat("screenshot (2)", "general").requires[0].min).toBe(1);
    expect(deriveFromFormat("screenshot (2)", "general").flags[0]).toMatchObject({ term: "screenshot (2)", text: "2", suggestedMin: 2, group: 0 });
  });
  it("an unknown fragment is an error, never a silent 'any item'", () => {
    expect(deriveFromFormat("spreadsheet + text", "general").error).toMatch(/spreadsheet/);
    expect(deriveFromFormat("", "general").error).not.toBeNull();
    expect(deriveFromFormat("screenshot + ", "general").error).toBeNull(); // a dangling '+' is just ignored
  });
  it("link is ig_link only on an instagram task; the Instagram prefix on a general task is flagged", () => {
    expect(deriveFromFormat("screenshot + link", "general").requires[1]).toEqual({ any: ["link"], min: 1, label: "link" });
    const d = deriveFromFormat("Instagram post: screenshot + link", "general");
    expect(d.flags.some((f) => f.kind === "type")).toBe(true);
  });
});

describe("requiresValid / requiresProblem (mirrors of the SQL CHECK and the approve guard)", () => {
  it("shape", () => {
    expect(requiresValid([])).toBe(true);
    expect(requiresValid([SHOT, TEXT])).toBe(true);
    for (const bad of [null, {}, [1], [{ any: [], min: 1, label: "text" }], [{ any: ["pdf"], min: 1, label: "file" }],
      [{ any: ["text", "text"], min: 1, label: "text" }], [{ any: ["text"], min: 0, label: "text" }],
      [{ any: ["text"], min: 21, label: "text" }], [{ any: ["text"], min: 1.5, label: "text" }], [{ any: ["text"], min: "1", label: "text" }],
      [{ any: ["text"], min: 1 }], [{ any: ["text"], min: 1, label: "image" }], [{ any: ["text"], min: 1, label: "text", x: 1 }],
      Array.from({ length: 9 }, () => TEXT)]) {
      expect(requiresValid(bad)).toBe(false);
    }
  });
  it("consistency with type and accepts, in the guard's order", () => {
    expect(requiresProblem("general", [{ any: ["text"], min: 0, label: "text" }], ["text"])).toBe(REQUIRES_MSG.invalid);
    expect(requiresProblem("general", [SHOT, IG], ["text", "photo", "document", "link"])).toBe(REQUIRES_MSG.igLinkOnGeneral);
    expect(requiresProblem("instagram", [SHOT], ["text", "photo", "document"])).toBe(REQUIRES_MSG.igNeedsShotAndLink);
    expect(requiresProblem("instagram", [], ["text"])).toBe(REQUIRES_MSG.igNeedsShotAndLink);
    expect(requiresProblem("instagram", [{ any: ["photo", "ig_link"], min: 1, label: "screenshot" }], ["photo", "link"])).toBe(REQUIRES_MSG.igNeedsShotAndLink);
    expect(requiresProblem("general", [SHOT], ["text", "photo"])).toBe(REQUIRES_MSG.notAccepted("image_doc"));
    expect(requiresProblem("general", [], ["text"])).toBeNull();
    expect(requiresProblem("instagram", [SHOT, IG], acceptsFor([SHOT, IG]))).toBeNull();
  });
  it("textOnlySatisfiable", () => {
    expect(textOnlySatisfiable([])).toBe(true);
    expect(textOnlySatisfiable([{ any: ["text", "photo", "image_doc"], min: 1, label: "text" }])).toBe(true);
    expect(textOnlySatisfiable([SHOT, TEXT])).toBe(false);
  });
});

describe("parsePlan + buildImportRows on the real plan", () => {
  const { tasks, errors } = parsePlan(JSON.stringify(plan));
  it("reads all 25 tasks in (week, day) order", () => {
    expect(errors).toEqual([]);
    expect(tasks).toHaveLength(25);
    expect(tasks.filter((t) => t.type === "instagram")).toHaveLength(7);
    expect(tasks.map(planRef).slice(0, 6)).toEqual(["W1D1", "W1D2", "W1D3", "W1D4", "W1D5", "W2D1"]);
  });
  it("schedules Mon-Fri from Thursday 2026-10-01, all drafts valid, points only when they differ", () => {
    const rows = buildImportRows(tasks, {
      startDate: "2026-10-01", weekdays: [1, 2, 3, 4, 5], occupiedDates: new Set(), existingRefs: new Set(),
      defaultPoints: { general: 5, instagram: 8 },
    });
    expect(rows.every((r) => r.status === "new" && r.item !== null)).toBe(true);
    expect(rows.slice(0, 4).map((r) => r.date)).toEqual(["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06"]);
    expect(rows.every((r) => r.date && isoWeekday(r.date) <= 5)).toBe(true);
    expect(new Set(rows.map((r) => r.date)).size).toBe(25);
    expect(rows.every((r) => r.item?.points === null)).toBe(true);
    const ig = rows.filter((r) => r.task.type === "instagram");
    expect(ig.every((r) => r.item?.requires_tag === true && r.item.requires.some((g) => g.label === "ig_link"))).toBe(true);
    expect(rows.find((r) => r.ref === "W5D4")?.item?.min_duration_sec).toBe(20);
    expect(rows[0].item).toMatchObject({ plan_ref: "W1D1", plan_format: "screenshot (2)", title: tasks[0].title_uz, body: tasks[0].task_uz });
  });
  it("re-import: existing plan refs are skipped and consume no date; taken dates are skipped", () => {
    const rows = buildImportRows(tasks, {
      startDate: "2026-10-01", weekdays: [1, 2, 3, 4, 5], occupiedDates: new Set(["2026-10-01"]), existingRefs: new Set(["W1D1"]),
      defaultPoints: { general: 5, instagram: 8 },
    });
    expect(rows[0].status).toBe("exists");
    expect(rows[1].date).toBe("2026-10-02");
    const custom = buildImportRows(tasks.slice(0, 1).map((t) => ({ ...t, points: 7 })), {
      startDate: "2026-10-01", weekdays: [4], occupiedDates: new Set(), existingRefs: new Set(), defaultPoints: { general: 5, instagram: 8 },
    });
    expect(custom[0].item?.points).toBe(7);
  });
  it("errors block the row", () => {
    const rows = buildImportRows([{ ...tasks[0], format: "hologram" }, { ...tasks[1], title_uz: "ab" }], {
      startDate: "2026-10-01", weekdays: [1, 2, 3, 4, 5], occupiedDates: new Set(), existingRefs: new Set(), defaultPoints: { general: 5, instagram: 8 },
    });
    expect(rows.map((r) => r.status)).toEqual(["error", "error"]);
    expect(rows.every((r) => r.item === null)).toBe(true);
  });
  it("accepts {tasks:[...]} and a bare array; reports bad input", () => {
    expect(parsePlan([{ title_uz: "Sarlavha", task_uz: "x", type: "general", format: "text", week: 1 }]).tasks).toHaveLength(1);
    expect(parsePlan("{").errors[0]).toMatch(/JSON/);
    expect(parsePlan({ weeks: [{ week: 1, tasks: [{ title_uz: "Sarlavha", type: "video", format: "text" }] }] }).errors[0]).toMatch(/task_uz/);
    expect(parsePlan({}).errors).toHaveLength(1);
  });
});

describe("dates", () => {
  it("Tashkent is UTC+5", () => {
    expect(tashkentToday(new Date("2026-09-30T18:59:59Z"))).toBe("2026-09-30");
    expect(tashkentToday(new Date("2026-09-30T19:00:00Z"))).toBe("2026-10-01");
  });
  it("weekday / addDays / schedule", () => {
    expect(isoWeekday("2026-10-01")).toBe(4);
    expect(isoWeekday("2026-10-04")).toBe(7);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(scheduleDates("2026-10-03", [6, 7], 3, new Set(["2026-10-04"]))).toEqual(["2026-10-03", "2026-10-10", "2026-10-11"]);
    expect(scheduleDates("2026-10-01", [], 3, new Set())).toEqual([]);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(configWeekdays(undefined)).toEqual([1, 2, 3, 4, 5]);
    expect(configWeekdays([5, 1, 1, 9])).toEqual([1, 5]);
  });
});

describe("parseMessageUrl (mirror of challenge_task_parse_message_url)", () => {
  it("message links inside a topic", () => {
    expect(parseMessageUrl("https://t.me/c/4440955972/144/5321")).toEqual({ chat: "4440955972", chatId: -1004440955972, topic: 144, msg: 5321 });
    expect(parseMessageUrl("https://t.me/c/4440955972/5321?thread=144")).toMatchObject({ topic: 144, msg: 5321 });
    expect(parseMessageUrl("https://t.me/c/4440955972/144/5321?single&thread=99")).toMatchObject({ topic: 99, msg: 5321 });
  });
  it("a topic link (no message) and other shapes are refused", () => {
    for (const u of ["https://t.me/c/4440955972/144", "https://t.me/c/4440955972/144?single", "https://t.me/c/4440955972/5321?thread=abc",
      "https://t.me/group/144/5", "t.me/c/1/2/3", "", null]) {
      expect(parseMessageUrl(u)).toBeNull();
    }
  });
});

describe("telegramHtmlRuns", () => {
  it("splits bold runs and unescapes", () => {
    expect(telegramHtmlRuns("📅 <b>1-kun</b> a &lt;b&gt; &amp; c")).toEqual([
      { text: "📅 ", bold: false }, { text: "1-kun", bold: true }, { text: " a <b> & c", bold: false },
    ]);
  });
});
