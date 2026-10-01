// Pins the "/" command lists: Telegram's rules for every entry, the scopes (students bot-wide in private chats
// per language, staff per chat, groups untouched), and that a student never gets a per-chat list.
// Run: deno test supabase/functions/telegram-bot-webhook/bot-commands.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyGlobalCommands, chatCommandCall, commandsFor, globalCommandCalls } from "./bot-commands.ts";
import { fakeTelegram } from "../_bot/testing/fake-db.ts";

Deno.test("every command is valid for setMyCommands (a-z0-9_, 1-32; description 1-256) and unique per list", () => {
  for (const role of ["student", "teacher", "admin"] as const) {
    for (const l of ["uz", "ru", "en"] as const) {
      const list = commandsFor(role, l);
      assert(list.length > 0 && list.length <= 100);
      assertEquals(new Set(list.map((c) => c.command)).size, list.length, `${role}/${l} duplicates`);
      for (const c of list) {
        assert(/^[a-z0-9_]{1,32}$/.test(c.command), c.command);
        assert(c.description.length >= 1 && c.description.length <= 256, c.description);
      }
    }
  }
});

Deno.test("the student list now has /dars; teachers get the teacher commands, not the student ones", () => {
  const s = commandsFor("student", "uz").map((c) => c.command);
  assertEquals(s, ["start", "davom", "dars", "vazifalar", "profil", "sozlamalar", "til", "yordam"]);
  const t = commandsFor("teacher", "uz").map((c) => c.command);
  assert(t.includes("baholash") && t.includes("tinactive") && t.includes("sozlamalar"));
  assert(!t.includes("davom") && !t.includes("vazifalar"));
  assert(!commandsFor("admin", "uz").some((c) => c.command === "claude"), "the owner-only /claude is never advertised");
});

Deno.test("scopes: bot-wide = all private chats (uz default + ru + en); never the default scope groups see", () => {
  const g = globalCommandCalls();
  assertEquals(g.map((p) => [(p.scope as { type: string }).type, p.language_code ?? null]), [
    ["all_private_chats", null], ["all_private_chats", "ru"], ["all_private_chats", "en"],
  ]);
  assertEquals((g[1].commands as { description: string }[])[1].description, "📚 Следующий урок");
});

Deno.test("per chat: staff only, private chats only", () => {
  assertEquals(chatCommandCall(42, "student", "uz"), null);
  assertEquals(chatCommandCall(-100123, "teacher", "uz"), null);
  const t = chatCommandCall(42, "teacher", "ru")!;
  assertEquals(t.scope, { type: "chat", chat_id: 42 });
  assertEquals((t.commands as { command: string }[])[1].command, "baholash");
});

Deno.test("applyGlobalCommands tallies outcomes and keeps a few errors (never throws)", async () => {
  const tg = fakeTelegram((_m, p) => (p.language_code === "en" ? { ok: false, status: 400, error: "Bad Request: BOT_COMMAND_INVALID" } : { ok: true }));
  const t = await applyGlobalCommands(tg.call);
  assertEquals([t.ok, t.failed], [2, 1]);
  assertEquals(t.errors, ["Bad Request: BOT_COMMAND_INVALID"]);
});
