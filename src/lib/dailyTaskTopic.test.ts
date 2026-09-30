import { describe, it, expect } from "vitest";
import { DAILY_TOPIC_MSG, dailyTopicError, dailyTopicSaveMessage, parseTopicUrl } from "./dailyTaskTopic";

// The SQL side (challenge_task_parse_topic_url + trg_groups_extract_daily_task_topic) is checked against this
// module fixture-by-fixture in supabase/functions/_challenge/testing/daily-topic-check.ts.
describe("parseTopicUrl (mirror of challenge_task_parse_topic_url)", () => {
  it("topic link, trailing slash, surrounding whitespace", () => {
    expect(parseTopicUrl("https://t.me/c/4440955972/144")).toEqual({ chat: "4440955972", chatId: -1004440955972, topic: 144 });
    expect(parseTopicUrl("  https://t.me/c/4440955972/144/  ")?.topic).toBe(144);
  });
  it("a message link inside a topic takes the MIDDLE number", () => {
    expect(parseTopicUrl("https://t.me/c/4440955972/144/5321")?.topic).toBe(144);
  });
  it("?thread= wins over the path; a non-numeric thread is not a topic link", () => {
    expect(parseTopicUrl("https://t.me/c/4440955972/5321?thread=144")?.topic).toBe(144);
    expect(parseTopicUrl("https://t.me/c/4440955972/144/5321?single&thread=99")?.topic).toBe(99);
    expect(parseTopicUrl("https://t.me/c/4440955972/144?thread=abc")).toBeNull();
    expect(parseTopicUrl("https://t.me/c/4440955972/144?single")?.topic).toBe(144);
  });
  it("not a private-group topic link -> null", () => {
    for (const u of ["https://t.me/somegroup/144", "https://t.me/+AbCdEf123", "https://t.me/c/4440955972", "https://t.me/c/0123/5",
      "https://t.me/c/4440955972/144#x", "t.me/c/4440955972/144", "", null, undefined]) {
      expect(parseTopicUrl(u)).toBeNull();
    }
  });
  it("the four production daily topics", () => {
    expect(parseTopicUrl("https://t.me/c/4440955972/144")?.chatId).toBe(-1004440955972);
    expect(parseTopicUrl("https://t.me/c/4390902020/99")?.chatId).toBe(-1004390902020);
    expect(parseTopicUrl("https://t.me/c/3714608284/38")?.chatId).toBe(-1003714608284);
    expect(parseTopicUrl("https://t.me/c/4463424516/12")?.chatId).toBe(-1004463424516);
  });
});

describe("dailyTopicError (mirror of the trigger's checks)", () => {
  const HW = "https://t.me/c/4440955972/3";
  it("empty clears -> ok", () => {
    expect(dailyTopicError("", HW)).toBeNull();
    expect(dailyTopicError("   ", null)).toBeNull();
  });
  it("valid daily topic in the homework chat -> ok", () => {
    expect(dailyTopicError("https://t.me/c/4440955972/144", HW)).toBeNull();
  });
  it("each refusal, in the trigger's order", () => {
    expect(dailyTopicError("salom", HW)).toBe(DAILY_TOPIC_MSG.badFormat);
    expect(dailyTopicError("https://t.me/c/4440955972/1", HW)).toBe(DAILY_TOPIC_MSG.general);
    expect(dailyTopicError("https://t.me/c/4440955972/144", "")).toBe(DAILY_TOPIC_MSG.homeworkMissing);
    expect(dailyTopicError("https://t.me/c/4440955972/144", "https://t.me/pub/3")).toBe(DAILY_TOPIC_MSG.homeworkNotC);
    expect(dailyTopicError("https://t.me/c/4390902020/99", HW)).toBe(DAILY_TOPIC_MSG.otherChat);
    expect(dailyTopicError("https://t.me/c/4440955972/3", HW)).toBe(DAILY_TOPIC_MSG.sameAsHomework);
  });
  it("the homework topic is compared under both readings (?thread= and the bot's first-number regex)", () => {
    const hw = "https://t.me/c/4440955972/3?thread=31";
    expect(dailyTopicError("https://t.me/c/4440955972/31", hw)).toBe(DAILY_TOPIC_MSG.sameAsHomework);
    expect(dailyTopicError("https://t.me/c/4440955972/3", hw)).toBe(DAILY_TOPIC_MSG.sameAsHomework);
  });
});

describe("dailyTopicSaveMessage", () => {
  it("maps the unique-index violation, passes the trigger's own text through", () => {
    expect(dailyTopicSaveMessage('duplicate key value violates unique constraint "uq_groups_daily_task_topic"')).toBe(DAILY_TOPIC_MSG.takenByOtherGroup);
    expect(dailyTopicSaveMessage(DAILY_TOPIC_MSG.general)).toBe(DAILY_TOPIC_MSG.general);
    expect(dailyTopicSaveMessage(undefined)).toBeNull();
  });
});
