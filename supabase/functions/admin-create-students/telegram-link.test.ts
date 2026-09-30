// Tests for the incoming-telegram_id verdict on a matched existing profile. Run:
//   deno test supabase/functions/admin-create-students/telegram-link.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { incomingTelegramVerdict } from "./telegram-link.ts";

Deno.test("no telegram_user_id in the row → absent (today's behaviour everywhere)", () => {
  assertEquals(incomingTelegramVerdict(true, undefined, null), "absent");
  assertEquals(incomingTelegramVerdict(false, undefined, 123), "absent");
});

Deno.test("the intake student: profile has no telegram_id → free (the already_in_group branch links it)", () => {
  assertEquals(incomingTelegramVerdict(true, 555, null), "free");
  assertEquals(incomingTelegramVerdict(true, 555, undefined), "free");
  assertEquals(incomingTelegramVerdict(false, 555, ""), "free");
});

Deno.test("the profile already holds this id → same (number or string from PostgREST)", () => {
  assertEquals(incomingTelegramVerdict(true, 555, 555), "same");
  assertEquals(incomingTelegramVerdict(true, 555, "555"), "same");
  assertEquals(incomingTelegramVerdict(false, 8984800239, "8984800239"), "same");
});

Deno.test("system caller + profile linked to a DIFFERENT account → conflict_system (row refused, nothing written)", () => {
  // The live shape: @Yaktaram's profile is linked to 7658778572 while 8984800239 now holds the username.
  assertEquals(incomingTelegramVerdict(true, 8984800239, 7658778572), "conflict_system");
  assertEquals(incomingTelegramVerdict(true, 8984800239, "7658778572"), "conflict_system");
});

Deno.test("admin caller + different id → differs_admin (a deliberate correction keeps today's overwrite)", () => {
  assertEquals(incomingTelegramVerdict(false, 8984800239, 7658778572), "differs_admin");
});
