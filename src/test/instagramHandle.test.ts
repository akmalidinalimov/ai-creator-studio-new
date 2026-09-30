import { describe, it, expect } from "vitest";
import {
  parseInstagramHandle,
  isInstagramHandleTaken,
  INSTAGRAM_RESERVED_SEGMENTS,
  INSTAGRAM_REJECT_REASONS,
} from "@/lib/instagramHandle";
import uz from "@/i18n/locales/uz.json";
import ru from "@/i18n/locales/ru.json";
import en from "@/i18n/locales/en.json";
// The DB twin: public.instagram_handle_parse(), which normalize_instagram_username() runs on every write.
import migration from "../../supabase/migrations/20260930154000_instagram_handle_parse.sql?raw";

const sql = migration.replace(/\r\n/g, "\n");

describe("parseInstagramHandle — the handle validator", () => {
  it("normalizes a plain handle, an @handle and a profile link", () => {
    expect(parseInstagramHandle("@My.Handle")).toEqual({ ok: true, handle: "my.handle" });
    expect(parseInstagramHandle("my_handle")).toEqual({ ok: true, handle: "my_handle" });
    expect(parseInstagramHandle("https://www.instagram.com/Ali.Uz/?igsh=MTN4")).toEqual({ ok: true, handle: "ali.uz" });
    expect(parseInstagramHandle("instagram.com/ali_uz")).toEqual({ ok: true, handle: "ali_uz" });
  });

  it("a blank field means 'clear the handle', not an error", () => {
    for (const v of ["", "   ", null, undefined, "\t\n"]) expect(parseInstagramHandle(v)).toEqual({ ok: true, handle: null });
  });

  it("trims the invisible characters a mobile paste carries", () => {
    expect(parseInstagramHandle("​@ali.uz﻿ ")).toEqual({ ok: true, handle: "ali.uz" });
    expect(parseInstagramHandle("\t@Tab.User\n")).toEqual({ ok: true, handle: "tab.user" });
  });

  it("refuses a post / reel / story link — it used to be stored as 'reel' or 'p'", () => {
    for (const v of [
      "https://www.instagram.com/reel/C8xYz12/?igsh=abc",
      "https://www.instagram.com/p/ABC123/",
      "https://instagram.com/reels/xyz",
      "https://www.instagram.com/stories/someone/123/",
      "https://www.instagram.com/share/reel/BAabc/",
      "instagram.com/explore/tags/ai/",
    ]) expect(parseInstagramHandle(v)).toEqual({ ok: false, reason: "not_profile_link" });
  });

  it("refuses a link with no handle — it used to CLEAR a stored handle", () => {
    for (const v of ["https://instagram.com/", "instagram.com", "https://www.instagram.com", "instagram.com/?hl=ru"]) {
      expect(parseInstagramHandle(v)).toEqual({ ok: false, reason: "no_handle_in_link" });
    }
  });

  it("refuses spaces, Cyrillic, dashes and other links (these used to show 'Saqlandi' and not save)", () => {
    for (const v of ["my handle", "алишер", "my-handle", "https://t.me/someone", "ali@gmail.com"]) {
      expect(parseInstagramHandle(v)).toEqual({ ok: false, reason: "bad_chars" });
    }
    expect(parseInstagramHandle("@")).toEqual({ ok: false, reason: "empty" });
    expect(parseInstagramHandle("a".repeat(31))).toEqual({ ok: false, reason: "too_long" });
    expect(parseInstagramHandle("a".repeat(30))).toEqual({ ok: true, handle: "a".repeat(30) });
  });

  it("recognizes the unique-index conflict (a handle another account already has)", () => {
    expect(isInstagramHandleTaken({ code: "23505", message: 'duplicate key value violates unique constraint "uq_profiles_instagram_username"' })).toBe(true);
    expect(isInstagramHandleTaken({ message: 'duplicate key value violates unique constraint "uq_profiles_instagram_username"' })).toBe(true);
    expect(isInstagramHandleTaken({ code: "23505", message: 'duplicate key value violates unique constraint "profiles_email_key"' })).toBe(false);
    expect(isInstagramHandleTaken({ code: "42501", message: "permission denied" })).toBe(false);
    expect(isInstagramHandleTaken(null)).toBe(false);
  });
});

describe("parity with the DB rule (migration 20260930154000)", () => {
  it("the reserved first path segments are the same list in SQL and TS", () => {
    const line = sql.split("\n").find((l) => l.includes("_seg = any (array["));
    expect(line, "the reserved-segment line in instagram_handle_parse").toBeTruthy();
    const inner = line!.split("array[")[1].split("]")[0];
    const sqlList = [...inner.matchAll(/'([^']*)'/g)].map((m) => m[1]);
    expect([...sqlList].sort()).toEqual([...INSTAGRAM_RESERVED_SEGMENTS].sort());
  });

  it("every self-test case of the migration parses the same way in TS", () => {
    const block = sql.split("-- parity-cases:begin")[1]?.split("-- parity-cases:end")[0] ?? "";
    const lit = String.raw`(null|'(?:[^']|'')*')`;
    const re = new RegExp(String.raw`^\s*\('((?:[^']|'')*)',\s*${lit},\s*${lit}\),?\s*$`, "gm");
    const unq = (s: string) => (s === "null" ? null : s.slice(1, -1).replace(/''/g, "'"));
    const cases = [...block.matchAll(re)].map((m) => ({ input: m[1].replace(/''/g, "'"), handle: unq(m[2]), reason: unq(m[3]) }));
    expect(cases.length).toBeGreaterThanOrEqual(20);
    for (const c of cases) {
      const r = parseInstagramHandle(c.input);
      expect({ input: c.input, handle: r.ok ? r.handle : null, reason: r.ok ? null : r.reason })
        .toEqual({ input: c.input, handle: c.handle, reason: c.reason });
    }
  });

  it("every reason the SQL can return is a reason the TS knows (and vice versa)", () => {
    const sqlReasons = new Set([...sql.matchAll(/reason := '([a-z_]+)'/g)].map((m) => m[1]));
    expect([...sqlReasons].sort()).toEqual([...INSTAGRAM_REJECT_REASONS].sort());
  });
});

describe("messages", () => {
  const locales = { uz, ru, en } as Record<string, any>;
  it("every refusal reason, and the taken / not-saved states, has a message in uz, ru and en", () => {
    for (const [lng, dict] of Object.entries(locales)) {
      const errs = dict.settings?.instagramErrors ?? {};
      for (const k of [...INSTAGRAM_REJECT_REASONS, "taken", "notSaved", "restSaved"]) {
        expect(typeof errs[k] === "string" && errs[k].length > 0, `${lng}: settings.instagramErrors.${k}`).toBe(true);
      }
      expect(typeof dict.settings?.instagramHint, `${lng}: settings.instagramHint`).toBe("string");
      expect(typeof dict.profile?.settingsPersonal, `${lng}: profile.settingsPersonal`).toBe("string");
    }
    expect(uz.settings.instagramErrors.taken).toMatch(/band/);
  });
});
