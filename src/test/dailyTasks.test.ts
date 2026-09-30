import { describe, it, expect, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} })); // pure helpers only: no client needed
vi.mock("@/lib/beacon", () => ({ reportClientError: vi.fn() }));

import {
  acceptsFile, DT_CAPTION_TEXT_SAFE, DT_MAX_MESSAGES, effectiveKind, fileKindOf, formatTaskDate, maxFilesFor, parsePostHtml,
  pickerAccept, requiresHint, statusTone, tashkentDateOf, tashkentToday,
} from "@/lib/dailyTasks";
// The edge function's own copies: the Mini App must refuse exactly what submit-daily-task refuses.
import * as edge from "../../supabase/functions/submit-daily-task/core";
import { dailyTaskPath, encodeStartParam, startParamToPath } from "@/lib/miniappLinks";
import { parentOf, resolveLanding } from "@/lib/telegram/landing";

// Kunlik vazifalar (Daily Tasks PR-7) — the Mini App's pure helpers.

describe("parsePostHtml (the SQL post renderer's <b> + three entities, rendered as TEXT)", () => {
  it("keeps bold runs and unescapes only &amp; &lt; &gt;", () => {
    expect(parsePostHtml("📅 <b>1-kun vazifasi</b> · 5-oktabr\n<b>A &amp; B</b>\n\n1 &lt; 2 &gt; 0")).toEqual([
      { text: "📅 ", bold: false },
      { text: "1-kun vazifasi", bold: true },
      { text: " · 5-oktabr\n", bold: false },
      { text: "A & B", bold: true },
      { text: "\n\n1 < 2 > 0", bold: false },
    ]);
  });
  it("never produces markup: any other tag stays literal text", () => {
    const parts = parsePostHtml("<img src=x onerror=alert(1)><b>ok</b>");
    expect(parts[0]).toEqual({ text: "<img src=x onerror=alert(1)>", bold: false });
    expect(parts[1]).toEqual({ text: "ok", bold: true });
  });
  it("empty / null → no parts", () => {
    expect(parsePostHtml(null)).toEqual([]);
    expect(parsePostHtml("")).toEqual([]);
  });
});

describe("file kinds mirror the edge function (the server refuses what the picker refuses)", () => {
  const cases: Array<[string, number]> = [
    ["image/jpeg", 100], ["image/png", 11 * 1024 * 1024], ["image/webp", 5], ["image/heic", 5], ["video/mp4", 5],
    ["video/quicktime", 5], ["application/pdf", 5], ["audio/mpeg", 5], ["", 5],
  ];
  it("fileKindOf", () => {
    for (const [mime, size] of cases) expect(fileKindOf(mime, size)).toBe(edge.fileKindOf(mime, size));
    expect(fileKindOf("image/png", 11 * 1024 * 1024)).toBe("document"); // over sendPhoto's 10 MB → a file
  });
  it("effectiveKind + acceptsFile", () => {
    const acceptSets = [["text", "photo"], ["text", "photo", "document"], ["document"], ["video"], ["text", "link"], ["audio"]];
    for (const accepts of acceptSets) {
      for (const [mime, size] of cases) {
        const k = effectiveKind(fileKindOf(mime, size), accepts);
        expect(k).toBe(edge.effectiveKind(edge.fileKindOf(mime, size), accepts));
        expect(acceptsFile(accepts, k, mime)).toBe(edge.acceptsFile(accepts, { kind: k, mime }));
      }
    }
    expect(effectiveKind("photo", ["document"])).toBe("document"); // a file task gets the image as a file (image_doc)
  });
  it("maxFilesFor: exactly as many files as keep the post at the engine's 10 messages (a long text is its own message)", () => {
    expect(DT_MAX_MESSAGES).toBe(edge.MAX_MESSAGES);
    expect(DT_CAPTION_TEXT_SAFE).toBe(edge.CAPTION_TEXT_SAFE);
    const header = edge.buildHeader({ name: "Ali", last_name: "Valiyev", telegram_username: "ali_v" }, { id: 7, date: "2026-10-05", title: "Birinchi" });
    const room = edge.captionTextMax(header);
    const files = (k: number) => Array.from({ length: k }, () => ({ kind: "photo" as const, blob: new Blob(["x"]), name: "a.jpg", size: 1, mime: "image/jpeg" }));
    for (const len of [0, 10, room, room + 1, 1000, 3500]) {
      const text = "x".repeat(len);
      const n = maxFilesFor(text, room);
      expect(edge.plannedMessages(edge.planParts(files(n), text, header))).toBeLessThanOrEqual(edge.MAX_MESSAGES);
      expect(edge.plannedMessages(edge.planParts(files(n + 1), text, header))).toBeGreaterThan(edge.MAX_MESSAGES); // tight
    }
    expect(maxFilesFor("x".repeat(room + 1), room)).toBe(9);
    expect(maxFilesFor(`  ${"x".repeat(room)}  `, room)).toBe(10); // what is sent is trimmed
    expect(maxFilesFor("x".repeat(DT_CAPTION_TEXT_SAFE + 1), null)).toBe(9); // no room from prepare: the safe one
    expect(maxFilesFor("x".repeat(DT_CAPTION_TEXT_SAFE), undefined)).toBe(10);
  });
  it("pickerAccept", () => {
    expect(pickerAccept(["text", "photo"])).toBe("image/*");
    expect(pickerAccept(["photo", "video"])).toBe("image/*,video/*");
    expect(pickerAccept(["document"])).toBe("*/*");
    expect(pickerAccept(["text", "link"])).toBe("");
  });
});

describe("requiresHint (a hint only — the engine's missing[] is the truth)", () => {
  const SHOT = { any: ["photo", "image_doc"], min: 1, label: "screenshot" };
  const TEXT = { any: ["text"], min: 1, label: "text" };
  const IG = { any: ["ig_link"], min: 1, label: "ig_link" };
  it("screenshot + text", () => {
    expect(requiresHint([SHOT, TEXT], { kinds: [], text: "" })).toEqual([{ label: "screenshot", met: false }, { label: "text", met: false }]);
    expect(requiresHint([SHOT, TEXT], { kinds: ["photo"], text: "Mana bugungi vazifam, ko'ring!" }))
      .toEqual([{ label: "screenshot", met: true }, { label: "text", met: true }]);
    expect(requiresHint([SHOT, TEXT], { kinds: ["image_doc"], text: "qisqa" })[1].met).toBe(false);
  });
  it("a URL is not text; an Instagram post link is an ig_link", () => {
    expect(requiresHint([TEXT], { kinds: [], text: "https://example.com/a-very-long-link-here" })[0].met).toBe(false);
    expect(requiresHint([IG], { kinds: [], text: "https://www.instagram.com/p/C8xYz12AbC/" })[0].met).toBe(true);
    expect(requiresHint([IG], { kinds: [], text: "https://www.instagram.com/share/abc" })[0].met).toBe(false);
  });
  it("min counts", () => {
    const two = { any: ["photo"], min: 2, label: "screenshot" };
    expect(requiresHint([two], { kinds: ["photo"], text: "" })[0].met).toBe(false);
    expect(requiresHint([two], { kinds: ["photo", "photo"], text: "" })[0].met).toBe(true);
  });
});

describe("dates and tones", () => {
  it("Tashkent dates", () => {
    expect(tashkentToday(new Date("2026-10-04T19:30:00Z"))).toBe("2026-10-05"); // 00:30 in Tashkent
    expect(tashkentDateOf("2026-10-05T18:59:59Z")).toBe("2026-10-05");
    expect(tashkentDateOf("2026-10-05T19:00:00Z")).toBe("2026-10-06");
    expect(tashkentDateOf(null)).toBeNull();
  });
  it("formatTaskDate matches the bot's words", () => {
    expect(formatTaskDate("2026-10-05", "uz")).toBe("5-oktabr");
    expect(formatTaskDate("2026-10-05", "ru")).toBe("5 октября");
    expect(formatTaskDate("2026-10-05", "en")).toBe("Oct 5");
  });
  it("statusTone", () => {
    expect(statusTone("accepted")).toBe("ok");
    expect(statusTone("checking")).toBe("wait");
    expect(statusTone("needs_more")).toBe("redo");
    expect(statusTone("withdrawn")).toBe("none");
  });
});

describe("start params dt / dt_<id> / ig (tg-miniapp-auth + the Mini App gate share this grammar)", () => {
  it("map to the daily-task pages, whitelist-only", () => {
    expect(startParamToPath("dt")).toEqual({ path: "/challenge/tasks", src: null });
    expect(startParamToPath("dt_42")).toEqual({ path: "/challenge/tasks/42", src: null });
    expect(startParamToPath("dt_42__daily_task")).toEqual({ path: "/challenge/tasks/42", src: "daily_task" });
    expect(startParamToPath("ig")).toEqual({ path: "/settings#profile", src: null });
    for (const bad of ["dt_0", "dt_01", "dt_x", "dt_", "dt_1234567890123", "dt_-1"]) expect(startParamToPath(bad)).toBeNull();
  });
  it("encode", () => {
    expect(encodeStartParam({ taskId: 42 })).toBe("dt_42");
    expect(encodeStartParam({ taskId: 42 }, "daily_task")).toBe("dt_42__daily_task");
    expect(encodeStartParam({ taskId: -1 })).toBe("dt");
    expect(encodeStartParam("dt")).toBe("dt");
    expect(encodeStartParam("ig")).toBe("ig");
    expect(dailyTaskPath(7)).toBe("/challenge/tasks/7");
    expect(dailyTaskPath("x")).toBe("/challenge/tasks");
  });
  it("the Mini App lands there and Telegram's Back button returns to the list", () => {
    expect(resolveLanding({ pathname: "/", search: "", startParam: "dt_42", serverTarget: "/dashboard" })).toBe("/challenge/tasks/42");
    expect(resolveLanding({ pathname: "/challenge/tasks/42", search: "", startParam: null, serverTarget: "/dashboard" })).toBe("/challenge/tasks/42");
    expect(parentOf("/challenge/tasks/42")).toBe("/challenge/tasks");
    expect(parentOf("/challenge/tasks")).toBe("/dashboard");
  });
});
