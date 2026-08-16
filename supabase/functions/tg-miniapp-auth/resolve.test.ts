import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveProfile, type ResolveDeps } from "./resolve.ts";

// A base set of deps where nothing matches; each test overrides only what it needs.
const base = (): ResolveDeps => ({
  findByTelegramId: async () => null,
  findStudentUsernameOnly: async () => null,
  isMember: async () => true,
  linkTelegramId: async () => {},
  alertFirstLink: async () => {},
});

Deno.test("linked telegram_id → signin, no backfill", async () => {
  const d = { ...base(), findByTelegramId: async () => ({ id: "p1", email: "p1@telegram.local" }) };
  assertEquals(await resolveProfile(d, { id: 1 }), {
    kind: "signin", profileId: "p1", email: "p1@telegram.local", backfilled: false,
  });
});

Deno.test("student username + member → signin backfilled + link + alert fired", async () => {
  let linked = false, alerted = false;
  const d: ResolveDeps = {
    ...base(),
    findStudentUsernameOnly: async () => ({ id: "p2", email: "p2@telegram.local", group_id: "g", group_chat_id: -100 }),
    isMember: async () => true,
    linkTelegramId: async () => { linked = true; },
    alertFirstLink: async () => { alerted = true; },
  };
  assertEquals(await resolveProfile(d, { id: 2, username: "malika" }), {
    kind: "signin", profileId: "p2", email: "p2@telegram.local", backfilled: true,
  });
  assertEquals(linked, true);
  assertEquals(alerted, true);
});

Deno.test("student username + non-member → not_linked, no link", async () => {
  let linked = false;
  const d: ResolveDeps = {
    ...base(),
    findStudentUsernameOnly: async () => ({ id: "p3", email: "e", group_id: "g", group_chat_id: -100 }),
    isMember: async () => false,
    linkTelegramId: async () => { linked = true; },
  };
  assertEquals(await resolveProfile(d, { id: 3, username: "x" }), { kind: "not_linked" });
  assertEquals(linked, false);
});

Deno.test("getChatMember error (null) → not_linked (fail closed)", async () => {
  let linked = false;
  const d: ResolveDeps = {
    ...base(),
    findStudentUsernameOnly: async () => ({ id: "p4", email: "e", group_id: "g", group_chat_id: -100 }),
    isMember: async () => null,
    linkTelegramId: async () => { linked = true; },
  };
  assertEquals(await resolveProfile(d, { id: 4, username: "x" }), { kind: "not_linked" });
  assertEquals(linked, false);
});

Deno.test("ambiguous username (>1 match) → not_linked", async () => {
  const d: ResolveDeps = { ...base(), findStudentUsernameOnly: async () => ({ ambiguous: true }) };
  assertEquals(await resolveProfile(d, { id: 5, username: "x" }), { kind: "not_linked" });
});

Deno.test("no match at all → not_linked", async () => {
  assertEquals(await resolveProfile(base(), { id: 6, username: "ghost" }), { kind: "not_linked" });
});

Deno.test("no username on user → not_linked (can't backfill)", async () => {
  assertEquals(await resolveProfile(base(), { id: 7 }), { kind: "not_linked" });
});

Deno.test("student match but no group_chat_id → not_linked (fail closed, nothing to verify)", async () => {
  const d: ResolveDeps = {
    ...base(),
    findStudentUsernameOnly: async () => ({ id: "p8", email: "e", group_id: "g", group_chat_id: null }),
  };
  assertEquals(await resolveProfile(d, { id: 8, username: "x" }), { kind: "not_linked" });
});
