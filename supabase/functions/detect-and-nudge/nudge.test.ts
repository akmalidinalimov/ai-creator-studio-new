// Pins one nudge: the Mini App button's ref IS the nudge_log id, magic_token is null on the web_app path, the
// flag-off path is today's magic link (token stored), a rejected web_app button is resent with the magic link,
// and a transport throw is contained. Run: deno test supabase/functions/detect-and-nudge/
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type NudgeDeps, nudgePayload, sendNudgeWith, type TgRaw } from "./nudge.ts";

const ID = "5a5a5a5a-1111-4222-8333-444455556666";
const P = { id: "11111111-1111-4111-8111-111111111111", telegram_id: 42, preferred_locale: "uz" };

function deps(flag: NudgeDeps["flag"], outcomes: TgRaw[] | "throw") {
  const sent: Array<Record<string, unknown>> = [];
  const logs: Array<Record<string, unknown>> = [];
  const magic: string[] = [];
  const d: NudgeDeps = {
    flag,
    newId: () => ID,
    makeMagicLink: (_u, path) => { magic.push(path); return Promise.resolve({ token: `tok${magic.length}`, url: `https://aicreator.academy/auth/magic?t=tok${magic.length}` }); },
    send: (p) => {
      sent.push(p);
      if (outcomes === "throw") return Promise.reject(new Error("telegram_transport_error (sendMessage): boom"));
      return Promise.resolve(outcomes[sent.length - 1]);
    },
    insertLog: (row) => { logs.push(row); return Promise.resolve({ error: null }); },
    redact: (e) => String((e as Error).message),
  };
  return { d, sent, logs, magic };
}
const OK: TgRaw = { ok: true, status: 200, data: { ok: true, result: { message_id: 777 } } };

Deno.test("flag ON: web_app to /continue with ref = the nudge_log id; magic_token null; no magic link made", async () => {
  const t = deps({ on: true, watch: true }, [OK]);
  const r = await sendNudgeWith(t.d, P, "inactive_3d", "Salom", "▶️ Davom", {}, "/dashboard");
  assertEquals(r.ok, true);
  assertEquals(t.magic, []);
  assertEquals(t.sent[0], {
    chat_id: 42, text: "Salom", disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[{ text: "▶️ Davom", web_app: { url: `https://www.aicreator.academy/continue?src=nudge_3d&ref=${ID}` } }]] },
  });
  assertEquals(t.logs[0].id, ID);
  assertEquals(t.logs[0].magic_token, null);
  assertEquals(t.logs[0].telegram_message_id, "777");
  assertEquals((t.logs[0].payload as any).button_mode, "web_app");
});

Deno.test("module_complete and inactive_7d carry their own src", async () => {
  for (const [type, src] of [["module_complete", "nudge_module"], ["inactive_7d", "nudge_7d"]] as const) {
    const t = deps({ on: true, watch: true }, [OK]);
    await sendNudgeWith(t.d, P, type, "x", "b", {}, "/dashboard");
    const url = ((t.sent[0].reply_markup as any).inline_keyboard[0][0].web_app.url) as string;
    assertEquals(url, `https://www.aicreator.academy/continue?src=${src}&ref=${ID}`);
  }
});

Deno.test("flag OFF: today's payload exactly (magic link to the old target), token stored", async () => {
  const t = deps({ on: false, watch: false }, [OK]);
  await sendNudgeWith(t.d, P, "inactive_3d", "Salom", "▶️ Davom", { a: "b" }, "/dashboard");
  assertEquals(t.magic, ["/dashboard"]);
  // The old tgSend body: chat_id, text, disable_web_page_preview, reply_markup with the url button.
  assertEquals(t.sent[0], {
    chat_id: 42, text: "Salom", disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[{ text: "▶️ Davom", url: "https://aicreator.academy/auth/magic?t=tok1" }]] },
  });
  assertEquals(t.logs[0].magic_token, "tok1");
  assertEquals((t.logs[0].payload as any).button_mode, "magic_link");
  assertEquals((t.logs[0].payload as any).button_reason, "flag_off");
});

Deno.test("a rejected web_app button is resent once with the magic link, and the token is logged", async () => {
  const t = deps({ on: true, watch: true }, [
    { ok: false, status: 400, data: { ok: false, description: "Bad Request: BUTTON_TYPE_INVALID" } },
    OK,
  ]);
  const r = await sendNudgeWith(t.d, P, "inactive_7d", "x", "b", {}, "/dashboard");
  assertEquals(r.ok, true);
  assertEquals(t.sent.length, 2);
  assertEquals(t.magic, ["/dashboard"]);
  assertEquals(t.logs[0].magic_token, "tok1");
  assertEquals((t.logs[0].payload as any).button_mode, "magic_link");
});

Deno.test("a recipient error is logged, not resent", async () => {
  const t = deps({ on: true, watch: true }, [{ ok: false, status: 403, data: { ok: false, description: "Forbidden: bot was blocked by the user" } }]);
  const r = await sendNudgeWith(t.d, P, "inactive_3d", "x", "b", {}, "/dashboard");
  assertEquals(r.ok, false);
  assertEquals(t.sent.length, 1);
  assertEquals(typeof t.logs[0].error, "string");
});

Deno.test("a transport throw is contained: the nudge_log row is still written with the error", async () => {
  const t = deps({ on: true, watch: true }, "throw");
  const r = await sendNudgeWith(t.d, P, "inactive_3d", "x", "b", {}, "/dashboard");
  assertEquals(r.ok, false);
  assertEquals(t.logs.length, 1);
  assertEquals(t.logs[0].id, ID);
  assertEquals(String(t.logs[0].error).includes("transport"), true);
});

Deno.test("nudgePayload without a button has no reply_markup", () => {
  assertEquals(nudgePayload(1, "t", null), { chat_id: 1, text: "t", disable_web_page_preview: true });
});
