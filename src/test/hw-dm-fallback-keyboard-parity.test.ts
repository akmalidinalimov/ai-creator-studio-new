import { describe, expect, it } from "vitest";

// The SQL fallback teacher DM's keyboard = the drainer's, in CI.
//
// hw_dm_fallback_deliver() (SQL, pg_net) delivers the new-homework teacher DM when the edge drainer
// (notify-homework-submission) is down. Since #239 the drainer sends [🎯 Baholash ↗ web_app] into the teacher
// Mini App while platform_settings.teacher_miniapp is on; migration 20261001080000 gives the fallback the same
// row, built in SQL by public.hw_dm_fallback_keyboard(submission, message_url, app_on).
//
// Two languages now build ONE url, so they can drift: SQL cannot import _shared/miniapp-links.ts, and
// `src=teacher_hw_dm&ref=<id>` is what tg-miniapp-auth/open.ts records as 'teacher_miniapp_open' — a drift would
// quietly stop attributing fallback taps, or open the wrong screen. The migration therefore carries its parity
// cases as a jsonb literal between the `keyboard-parity-cases:begin/end` markers and asserts, at apply time, that
// hw_dm_fallback_keyboard() returns each case's `want`. THIS test asserts the other half, on every CI run: each
// `want` is what the TypeScript builders (teacherAppButton + submissionDmKeyboard) produce for the same input.
// Together: SQL == the migration's cases == TypeScript. Editing either side without the other fails here.
//
// The PGlite harness (supabase/functions/_teacher/testing/teacher-waiting-rule-check.ts, sections F and K) runs
// the real migration against production's function text and fuzzes 120 random keyboards, but it needs `deno test
// -A` and is named *-check.ts, so CI never collects it. This file is the CI-side gate.
import migrationSrc from "../../supabase/migrations/20261001080000_teacher_waiting_rule_and_detectors.sql?raw";
import { isRealTopicLink, submissionDmKeyboard } from "../../supabase/functions/notify-homework-submission/copy";
import { DEFAULT_MINIAPP_BASE } from "../../supabase/functions/_shared/miniapp-button";
import {
  GRADE_APP_LABEL,
  GRADE_CHAT_LABEL,
  teacherAppButton,
  teacherGradePath,
} from "../../supabase/functions/_shared/teacher-miniapp";
import { withTrack } from "../../supabase/functions/_shared/miniapp-links";

type Btn = Record<string, unknown>;
type Keyboard = { inline_keyboard: Btn[][] };
type Case = { sub: string; url: string; app: boolean; want: Keyboard };

/** The cases the migration pins, read out of its own text (the single source both sides are checked against). */
function migrationCases(): Case[] {
  const src = migrationSrc.replace(/\r\n/g, "\n");
  const begin = src.indexOf("keyboard-parity-cases:begin");
  const end = src.indexOf("keyboard-parity-cases:end");
  expect(begin, "the migration must carry its keyboard parity cases between the markers").toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(begin);
  const block = src.slice(begin, end);
  const open = block.indexOf("$kb$");
  const close = block.indexOf("$kb$", open + 4);
  expect(open, "the cases must be a $kb$...$kb$ jsonb literal").toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return JSON.parse(block.slice(open + 4, close)) as Case[];
}

/**
 * TypeScript's keyboard for the fallback DM: the drainer's composition (teacherAppButton + submissionDmKeyboard),
 * with the fallback's own shorter post label — "📂 Postni ko'rish" is what the SQL has always sent, and keeping it
 * is what makes the flag-off keyboard byte-identical to the pre-migration DM.
 */
async function tsKeyboard(sub: string, url: string, app: boolean): Promise<Keyboard> {
  const gradeApp = app
    ? await teacherAppButton({
      text: GRADE_APP_LABEL.uz,
      flag: { on: true, watch: true },
      chatId: 102, // a private chat: teacherAppButton refuses anything else
      path: teacherGradePath(sub),
      src: "teacher_hw_dm",
      ref: sub,
      fn: "hw-dm-fallback-keyboard-parity",
      base: DEFAULT_MINIAPP_BASE, // SQL cannot read MINIAPP_BASE; both sides use the default origin
    })
    : null;
  const kb = submissionDmKeyboard("uz", {
    submissionId: sub,
    messageUrl: url,
    guessed: false, // the SQL fallback never offers ✏️ retag (it does not know whether the task was guessed)
    gradeApp,
    chatLabel: GRADE_CHAT_LABEL.uz,
  });
  return {
    inline_keyboard: kb.inline_keyboard.map((row) =>
      row.map((b) => (typeof b.url === "string" && isRealTopicLink(b.url) ? { ...b, text: "📂 Postni ko'rish" } : b))
    ) as Btn[][],
  };
}

describe("hw_dm_fallback_keyboard: the migration's pinned cases = TypeScript", () => {
  const cases = migrationCases();

  it("the migration pins enough cases: both flag states, a real topic post and a deep-link placeholder", () => {
    expect(cases.length).toBeGreaterThanOrEqual(7);
    expect(cases.some((c) => c.app)).toBe(true);
    expect(cases.some((c) => !c.app)).toBe(true);
    expect(cases.some((c) => isRealTopicLink(c.url))).toBe(true);
    expect(cases.some((c) => !isRealTopicLink(c.url))).toBe(true);
    for (const c of cases) {
      expect(typeof c.sub).toBe("string");
      expect(typeof c.app).toBe("boolean");
      expect(Array.isArray(c.want?.inline_keyboard)).toBe(true);
    }
  });

  it.each(cases.map((c, i) => [i, c] as const))("case %i: want = TypeScript", async (_i, c) => {
    expect(c.want).toEqual(await tsKeyboard(c.sub, c.url, c.app));
  });

  it("the web_app url is _shared/miniapp-links.ts withTrack(teacherGradePath(sub)), byte for byte", () => {
    for (const c of cases.filter((x) => x.app)) {
      const want = DEFAULT_MINIAPP_BASE + withTrack(teacherGradePath(c.sub), { src: "teacher_hw_dm", ref: c.sub });
      const first = c.want.inline_keyboard[0][0] as { text?: string; web_app?: { url?: string } };
      expect(first.text).toBe(GRADE_APP_LABEL.uz);
      expect(first.web_app?.url).toBe(want);
      // The open signal tg-miniapp-auth/open.ts needs: a known teacher src, and the ref it attributes the tap to.
      const q = new URL(want).searchParams;
      expect([q.get("sub"), q.get("src"), q.get("ref")]).toEqual([c.sub.toLowerCase(), "teacher_hw_dm", c.sub.toLowerCase()]);
    }
  });

  it("flag off: no web_app button anywhere, and 🎯 stays the in-chat callback", () => {
    for (const c of cases.filter((x) => !x.app)) {
      const flat = c.want.inline_keyboard.flat();
      expect(flat.some((b) => "web_app" in b)).toBe(false);
      const grade = flat.find((b) => b.text === "🎯 Baholash") as { callback_data?: string } | undefined;
      expect(grade?.callback_data).toBe(`gs:open:${c.sub}`);
    }
  });

  it("every callback_data fits Telegram's 64-byte cap", () => {
    for (const c of cases) {
      for (const b of c.want.inline_keyboard.flat()) {
        if (typeof b.callback_data === "string") {
          expect(new TextEncoder().encode(b.callback_data).length).toBeLessThanOrEqual(64);
        }
      }
    }
  });
});
