import { describe, it, expect } from "vitest";
import { fastPathRedirect, parentOf, resolveLanding } from "@/lib/telegram/landing";
import { backTarget } from "@/lib/telegram/useTelegramBackButton";

const C = "0b6f4e1c-2a3d-4e5f-8a9b-0c1d2e3f4a5b";
const L = "9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b";

describe("resolveLanding (fresh Mini App sign-in)", () => {
  const cases: Array<[string, Parameters<typeof resolveLanding>[0], string]> = [
    ["a cold watch button stays on the lesson, src stripped",
      { pathname: `/lesson/${C}/${L}`, search: "?src=daily_reminder", startParam: null, serverTarget: "/dashboard" },
      `/lesson/${C}/${L}`],
    ["a /continue button keeps its course, src+ref stripped",
      { pathname: `/continue/${C}`, search: `?src=nudge_3d&ref=${L}`, startParam: null, serverTarget: "/dashboard" },
      `/continue/${C}`],
    ["other query params survive",
      { pathname: "/continue", search: `?lesson=${L}&src=bot_davom`, startParam: null, serverTarget: "/dashboard" },
      `/continue?lesson=${L}`],
    ["the root goes to the server target (student)",
      { pathname: "/", search: "", startParam: null, serverTarget: "/dashboard" }, "/dashboard"],
    ["/dashboard for staff still goes to /tg/teacher (unchanged)",
      { pathname: "/dashboard", search: "", startParam: null, serverTarget: "/tg/teacher" }, "/tg/teacher"],
    ["/tg/teacher/grade is kept (unchanged)",
      { pathname: "/tg/teacher/grade", search: "", startParam: null, serverTarget: "/tg/teacher" }, "/tg/teacher/grade"],
    ["a direct-link start_param at the root maps",
      { pathname: "/", search: "", startParam: `c_${C}__daily_task`, serverTarget: `/continue/${C}` }, `/continue/${C}`],
    ["a lesson start_param goes through /continue (enrolment + tier checked there)",
      { pathname: "/", search: "", startParam: `l_${L}`, serverTarget: "/dashboard" }, `/continue?lesson=${L}`],
    ["a bogus start_param falls back to the server target",
      { pathname: "/", search: "", startParam: "//evil", serverTarget: "/dashboard" }, "/dashboard"],
    ["no server target → /dashboard",
      { pathname: "", search: "", startParam: null, serverTarget: undefined }, "/dashboard"],
  ];
  for (const [name, args, want] of cases) {
    it(name, () => expect(resolveLanding(args)).toBe(want));
  }
});

describe("fastPathRedirect (already signed in)", () => {
  it("the root with start_param c_<uuid> goes to /continue/<uuid>", () => {
    expect(fastPathRedirect("/", `c_${C}`)).toBe(`/continue/${C}`);
    expect(fastPathRedirect("/", `c_${C}__daily_task`)).toBe(`/continue/${C}`);
  });
  it("anything else stays put", () => {
    expect(fastPathRedirect(`/lesson/${C}/${L}`, `c_${C}`)).toBeNull();
    expect(fastPathRedirect("/", null)).toBeNull();
    expect(fastPathRedirect("/", "https://evil")).toBeNull();
  });
});

describe("Telegram Back button", () => {
  it("a cold deep-link entry (idx 0 / no state) goes to the parent screen", () => {
    expect(backTarget(`/lesson/${C}/${L}`, { idx: 0 })).toBe(`/course/${C}`);
    expect(backTarget(`/lesson/${C}/${L}`, null)).toBe(`/course/${C}`);
    expect(backTarget(`/course/${C}`, undefined)).toBe("/dashboard");
    expect(backTarget("/homework", { idx: 0 })).toBe("/dashboard");
    expect(backTarget("/tg/teacher/grade", { idx: 0 })).toBe("/tg/teacher");
    expect(backTarget("/tg/teacher/groups/student/x", { idx: 0 })).toBe("/tg/teacher/groups");
  });
  it("with history (idx > 0) it pops one step, as before", () => {
    expect(backTarget(`/lesson/${C}/${L}`, { idx: 1 })).toBe(-1);
    expect(backTarget(`/course/${C}`, { idx: 3 })).toBe(-1);
  });
  it("staff-only standalone screens keep navigate(-1)", () => {
    expect(parentOf("/tg/broadcast")).toBeNull();
    expect(parentOf("/admin/users")).toBeNull();
    expect(backTarget("/tg/group-board", { idx: 0 })).toBe(-1);
  });
});
