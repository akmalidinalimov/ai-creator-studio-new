import { describe, it, expect } from "vitest";

// Parity test: src/lib/miniappLinks.ts (web / Mini App) and supabase/functions/_shared/miniapp-links.ts (edge
// functions + the bot) are ONE route grammar kept as two byte-identical copies (the web bundle cannot import
// from supabase/functions). The edge side ENCODES start_params and paths, the Mini App DECODES them — a drift
// would silently send a watch button to the wrong screen. This fails if they differ.
import * as web from "@/lib/miniappLinks";
import * as edge from "../../supabase/functions/_shared/miniapp-links";
import webSrc from "@/lib/miniappLinks.ts?raw";
import edgeSrc from "../../supabase/functions/_shared/miniapp-links.ts?raw";

const norm = (s: string) => s.replace(/\r\n/g, "\n");
const C = "0b6f4e1c-2a3d-4e5f-8a9b-0c1d2e3f4a5b";
const L = "9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b";

describe("miniapp-links web/edge parity", () => {
  it("the two files are byte-identical (edit one, copy it over the other)", () => {
    expect(norm(webSrc)).toBe(norm(edgeSrc));
  });

  it("paths", () => {
    expect(web.continuePath()).toBe("/continue");
    expect(web.continuePath(null)).toBe("/continue");
    expect(web.continuePath(C)).toBe(`/continue/${C}`);
    expect(web.continuePath(C.toUpperCase())).toBe(`/continue/${C}`);
    expect(web.continuePath("not-a-uuid")).toBe("/continue");
    expect(web.lessonPath(C, L)).toBe(`/lesson/${C}/${L}`);
    expect(web.lessonPath(C, "x")).toBe(`/continue/${C}`);
    expect(web.coursePath(C)).toBe(`/course/${C}`);
    expect(web.coursePath("../x")).toBe("/dashboard");
    for (const f of ["continuePath", "coursePath"] as const) expect(edge[f](C)).toBe(web[f](C));
    expect(edge.lessonPath(C, L)).toBe(web.lessonPath(C, L));
  });

  it("withTrack / readTrack / stripTrack", () => {
    expect(web.withTrack(`/continue/${C}`, { src: "daily_reminder" })).toBe(`/continue/${C}?src=daily_reminder`);
    expect(web.withTrack("/continue", { src: "nudge_3d", ref: L })).toBe(`/continue?src=nudge_3d&ref=${L}`);
    expect(web.withTrack(`/continue?lesson=${L}`, { src: "bot_davom" })).toBe(`/continue?lesson=${L}&src=bot_davom`);
    expect(web.withTrack("/dashboard", { src: "evil" as never })).toBe("/dashboard");
    expect(web.withTrack("/dashboard", { src: "broadcast", ref: "1; drop" })).toBe("/dashboard?src=broadcast");
    expect(web.readTrack(`?src=nudge_7d&ref=${L}`)).toEqual({ src: "nudge_7d", ref: L });
    expect(web.readTrack("?src=nope")).toBeNull();
    expect(web.readTrack("?src=drip_3&ref=zzz")).toEqual({ src: "drip_3", ref: null });
    expect(web.stripTrack(`?lesson=${L}&src=bot_davom&ref=${L}`)).toBe(`?lesson=${L}`);
    expect(web.stripTrack("?src=bot_davom")).toBe("");
    expect(edge.withTrack("/continue", { src: "nudge_3d", ref: L })).toBe(web.withTrack("/continue", { src: "nudge_3d", ref: L }));
  });

  it("start_param round-trip", () => {
    const cases: Array<[Parameters<typeof web.encodeStartParam>[0], string, string]> = [
      ["continue", "c", "/continue"],
      [{ courseId: C }, `c_${C}`, `/continue/${C}`],
      [{ courseId: null }, "c", "/continue"],
      [{ lessonId: L }, `l_${L}`, `/continue?lesson=${L}`],
      ["hw", "hw", "/homework"],
      ["homework", "homework", "/homework"],
      ["leaderboard", "leaderboard", "/leaderboard"],
      ["profile", "profile", "/profile"],
    ];
    for (const [target, param, path] of cases) {
      expect(web.encodeStartParam(target)).toBe(param);
      expect(edge.encodeStartParam(target)).toBe(param);
      expect(web.startParamToPath(param)).toEqual({ path, src: null });
      const withSrc = web.encodeStartParam(target, "daily_task");
      expect(withSrc).toBe(`${param}__daily_task`);
      expect(withSrc).toMatch(/^[A-Za-z0-9_-]{1,512}$/);
      expect(web.startParamToPath(withSrc)).toEqual({ path, src: "daily_task" });
      expect(edge.startParamToPath(withSrc)).toEqual(web.startParamToPath(withSrc));
    }
    // An unknown src suffix is dropped, the path still maps.
    expect(web.startParamToPath(`c_${C}__whatever`)).toEqual({ path: `/continue/${C}`, src: null });
  });

  it("start_param is whitelist-only: nothing can become an open redirect", () => {
    const bad = [
      "//evil", "https://x", "/\\x", "\\\\x", "c_//evil.com", "l_https:x", "c_not-a-uuid", `c_${C}x`,
      "l_", "c_", "", "dashboard", "../etc", "c evil", "c%2F%2Fevil", "javascript:alert(1)", `x_${C}`,
    ];
    for (const p of bad) {
      expect(web.startParamToPath(p)).toBeNull();
      expect(edge.startParamToPath(p)).toBeNull();
    }
    expect(web.startParamToPath(null)).toBeNull();
    expect(web.startParamToPath(undefined)).toBeNull();
  });

  it("length limit (Telegram startapp ≤ 512 chars)", () => {
    expect(web.startParamToPath("c" + "_".repeat(512))).toBeNull();
    expect(web.startParamToPath("a".repeat(513))).toBeNull();
    expect(web.encodeStartParam({ courseId: C }, "streak_warning").length).toBeLessThanOrEqual(web.START_PARAM_MAX);
  });

  it("startParamFromInitData reads the signed field", () => {
    const init = new URLSearchParams({ user: '{"id":1}', start_param: `c_${C}__daily_task`, hash: "h" }).toString();
    expect(web.startParamFromInitData(init)).toBe(`c_${C}__daily_task`);
    expect(web.startParamFromInitData("user=%7B%7D&hash=h")).toBeNull();
    expect(web.startParamFromInitData(null)).toBeNull();
  });

  it("every src fits a start_param and a query value", () => {
    for (const s of web.MINIAPP_SRCS) {
      expect(s).toMatch(/^[a-z0-9_]+$/);
      expect(s.includes("__")).toBe(false);
      expect(web.isMiniAppSrc(s)).toBe(true);
    }
    expect(edge.MINIAPP_SRCS).toEqual(web.MINIAPP_SRCS);
  });
});
