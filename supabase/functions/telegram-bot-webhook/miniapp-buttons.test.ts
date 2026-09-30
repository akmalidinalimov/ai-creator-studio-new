// Pins the bot's watch buttons: 📚 Davom etish / /dars / welcome open the Mini App when the student Mini App is
// on, fall back to today's magic link when it is off (either the webhook's own state or the shared flag), never
// build a magic link for a non-private chat, and resend a rejected web_app button once with the magic link.
// Run: deno test supabase/functions/telegram-bot-webhook/miniapp-buttons.test.ts
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { continuePath, sendStudentWatchMessage, studentWatchButton } from "./miniapp-buttons.ts";
import { _resetStudentMiniAppFlagCache } from "../_shared/miniapp-button.ts";

const C = "0b6f4e1c-2a3d-4e5f-8a9b-0c1d2e3f4a5b";
const L = "9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b";

function fakeAdmin(flagValue: unknown) {
  const inserts: any[] = [];
  return {
    inserts,
    from(table: string) {
      const q: any = {
        select: () => q, eq: () => q, gte: () => q,
        limit: () => Promise.resolve({ data: [], error: null }),
        maybeSingle: () => Promise.resolve({ data: table === "platform_settings" && flagValue ? { value: flagValue } : null, error: null }),
        insert: (row: any) => { inserts.push({ table, row }); return Promise.resolve({ error: null }); },
      };
      return q;
    },
  };
}

function magic() {
  const calls: string[] = [];
  return { calls, fn: (p: string) => { calls.push(p); return Promise.resolve(`https://ai-creator-studio-new.vercel.app/auth/magic?t=T${calls.length}`); } };
}

const davom = (admin: unknown, webhookOn: boolean, m: ReturnType<typeof magic>, chatId = 555) =>
  studentWatchButton(admin, {
    chatId, text: "▶️ Darsni ochish", miniPath: continuePath(C), legacyPath: `/lesson/${C}/${L}`, src: "bot_davom",
    webhookOn, magicLink: m.fn,
  });

Deno.test("flag on → a Mini App web_app button; no magic link is created", async () => {
  _resetStudentMiniAppFlagCache();
  const m = magic();
  const w = await davom(fakeAdmin({ enabled: true }), true, m);
  assertEquals(w.mode, "web_app");
  assertEquals(w.button, { text: "▶️ Darsni ochish", web_app: { url: `https://www.aicreator.academy/continue/${C}?src=bot_davom` } });
  assertEquals(m.calls, []);
  _resetStudentMiniAppFlagCache();
});

Deno.test("the webhook's own state off → today's magic link, to the old lesson path", async () => {
  _resetStudentMiniAppFlagCache();
  const m = magic();
  const w = await davom(fakeAdmin({ enabled: true }), false, m);
  assertEquals(w.mode, "magic_link");
  assertEquals(w.button, { text: "▶️ Darsni ochish", url: "https://ai-creator-studio-new.vercel.app/auth/magic?t=T1" });
  assertEquals(m.calls, [`/lesson/${C}/${L}`]);
  _resetStudentMiniAppFlagCache();
});

Deno.test("watch_buttons:false → magic link even though the Mini App entry is on", async () => {
  _resetStudentMiniAppFlagCache();
  const m = magic();
  const w = await davom(fakeAdmin({ enabled: true, watch_buttons: false }), true, m);
  assertEquals(w.mode, "magic_link");
  _resetStudentMiniAppFlagCache();
});

Deno.test("a non-private chat id never gets a magic link", async () => {
  _resetStudentMiniAppFlagCache();
  const m = magic();
  await assertRejects(() => davom(fakeAdmin({ enabled: false }), false, m, -1001234567890));
  assertEquals(m.calls, []);
  _resetStudentMiniAppFlagCache();
});

Deno.test("sendStudentWatchMessage: HTML + no preview, and a rejected web_app button is resent with the magic link", async () => {
  _resetStudentMiniAppFlagCache();
  const admin = fakeAdmin({ enabled: true });
  const m = magic();
  const w = await davom(admin, true, m);
  const bodies: any[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const first = bodies.length === 1;
    return Promise.resolve(new Response(
      JSON.stringify(first ? { ok: false, description: "Bad Request: BUTTON_TYPE_INVALID" } : { ok: true, result: { message_id: 1 } }),
      { status: first ? 400 : 200 },
    ));
  }) as typeof fetch;
  try {
    const out = await sendStudentWatchMessage(admin, 555, "Keyingi dars:", [[w], [{ text: "🆘 Yordam", url: "https://t.me/support" }]]);
    assertEquals(out.ok, true);
  } finally {
    globalThis.fetch = realFetch;
    _resetStudentMiniAppFlagCache();
  }
  assertEquals(bodies.length, 2);
  assertEquals(bodies[0].parse_mode, "HTML");
  assertEquals(bodies[0].disable_web_page_preview, true);
  assertEquals(bodies[0].reply_markup.inline_keyboard[0][0].web_app.url, `https://www.aicreator.academy/continue/${C}?src=bot_davom`);
  assertEquals(bodies[1].reply_markup.inline_keyboard, [
    [{ text: "▶️ Darsni ochish", url: "https://ai-creator-studio-new.vercel.app/auth/magic?t=T1" }],
    [{ text: "🆘 Yordam", url: "https://t.me/support" }],
  ]);
  assertEquals(m.calls, [`/lesson/${C}/${L}`]);
  assertEquals(admin.inserts.some((i) => i.row.action === "miniapp_button_rejected"), true);
});
