import { describe, expect, it } from "vitest";
import { normalizeTelegramUsername, teacherAccountOutcome, teacherReach } from "./coTeacher";

describe("normalizeTelegramUsername", () => {
  it("accepts the forms an admin pastes, keeping the case", () => {
    for (const raw of ["@A_Barnoshka", "A_Barnoshka", "  @A_Barnoshka ", "t.me/A_Barnoshka", "https://t.me/A_Barnoshka",
      "https://telegram.me/A_Barnoshka/", "@@A_Barnoshka"]) {
      expect(normalizeTelegramUsername(raw)).toEqual({ ok: true, username: "A_Barnoshka" });
    }
  });
  it("refuses what is not a Telegram username", () => {
    for (const raw of ["", "@", "8403774811", "abc", "1abcde", "_abcde", "Barno Ustoz", "barno-ustoz", "a".repeat(33)]) {
      expect(normalizeTelegramUsername(raw).ok).toBe(false);
    }
  });
});

describe("teacherAccountOutcome", () => {
  it("created and matched accounts give the profile id", () => {
    expect(teacherAccountOutcome({ status: "created", userId: "u1" }, "x")).toEqual({ ok: true, userId: "u1", created: true });
    expect(teacherAccountOutcome({ status: "updated", userId: "u2" }, "x")).toEqual({ ok: true, userId: "u2", created: false });
  });
  it("a student's username, a missing id and server errors are refusals", () => {
    const r = teacherAccountOutcome({ status: "role_conflict", userId: "u3", error: "…" }, "mavhoji");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("@mavhoji talaba");
    expect(teacherAccountOutcome({ status: "updated" }, "x").ok).toBe(false);
    expect(teacherAccountOutcome({ status: "error", error: "boom" }, "x")).toEqual({ ok: false, error: "boom" });
    expect(teacherAccountOutcome(null, "x").ok).toBe(false);
  });
});

describe("teacherReach", () => {
  it("ready only with a Telegram id AND a pressed /start", () => {
    expect(teacherReach({ telegram_id: 5, telegram_write_access_at: "2026-10-17T00:00:00Z" })).toBe("ready");
    expect(teacherReach({ telegram_id: 5, telegram_write_access_at: null })).toBe("needs_start");
    expect(teacherReach({ telegram_id: null, telegram_write_access_at: "2026-10-17T00:00:00Z" })).toBe("needs_start");
    expect(teacherReach(null)).toBe("needs_start");
  });
});
