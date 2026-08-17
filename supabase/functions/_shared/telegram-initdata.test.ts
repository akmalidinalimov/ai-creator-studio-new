import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { validateInitData } from "./telegram-initdata.ts";

const BOT = "123456:TESTTOKEN";

// Build a validly-signed initData string, mirroring Telegram's algorithm, so we can test the validator.
async function signInitData(fields: Record<string, string>, token: string): Promise<string> {
  const enc = new TextEncoder();
  const dcs = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const wk = await crypto.subtle.importKey("raw", enc.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secret = new Uint8Array(await crypto.subtle.sign("HMAC", wk, enc.encode(token)));
  const sk = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", sk, enc.encode(dcs)));
  const hash = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  return new URLSearchParams({ ...fields, hash }).toString();
}

Deno.test("valid initData → ok with user + startParam", async () => {
  const authDate = String(Math.floor(Date.now() / 1000));
  const initData = await signInitData({
    user: JSON.stringify({ id: 42, username: "alice", first_name: "Alice" }),
    auth_date: authDate,
    start_param: "hw",
  }, BOT);
  const r = await validateInitData(initData, BOT, 600);
  assertEquals(r.ok, true);
  assertEquals(r.user?.id, 42);
  assertEquals(r.user?.username, "alice");
  assertEquals(r.startParam, "hw");
});

Deno.test("initData WITH signature field → ok (signature stays in the HMAC data-check-string)", async () => {
  // Real modern clients (Telegram Desktop/mobile 2025+) include an Ed25519 `signature` field, and the
  // bot-token `hash` is computed over ALL fields except `hash` — signature INCLUDED. Mirror that here:
  // sign a payload that contains `signature`, then assert the validator accepts it. If the validator
  // wrongly deletes `signature` before hashing, dcs loses a field and this fails — exactly the prod bug.
  const authDate = String(Math.floor(Date.now() / 1000));
  const initData = await signInitData({
    user: JSON.stringify({ id: 7, username: "bob", first_name: "Bob" }),
    auth_date: authDate,
    chat_instance: "-1234567890",
    chat_type: "sender",
    signature: "3q2-7_ed25519signatureplaceholder",
  }, BOT);
  const r = await validateInitData(initData, BOT, 600);
  assertEquals(r.ok, true);
  assertEquals(r.user?.id, 7);
});

Deno.test("tampered hash → not ok", async () => {
  const authDate = String(Math.floor(Date.now() / 1000));
  let initData = await signInitData({ user: JSON.stringify({ id: 1 }), auth_date: authDate }, BOT);
  initData = initData.replace(/hash=[0-9a-f]+/, "hash=" + "0".repeat(64));
  assertEquals((await validateInitData(initData, BOT, 600)).ok, false);
});

Deno.test("expired auth_date → not ok, flagged expired", async () => {
  const old = String(Math.floor(Date.now() / 1000) - 3600);
  const initData = await signInitData({ user: JSON.stringify({ id: 1 }), auth_date: old }, BOT);
  const r = await validateInitData(initData, BOT, 600);
  assertEquals(r.ok, false);
  assertEquals(r.expired, true);
});

Deno.test("wrong bot token → not ok", async () => {
  const authDate = String(Math.floor(Date.now() / 1000));
  const initData = await signInitData({ user: JSON.stringify({ id: 1 }), auth_date: authDate }, BOT);
  assertEquals((await validateInitData(initData, "999:WRONG", 600)).ok, false);
});

Deno.test("missing hash → not ok", async () => {
  assertEquals((await validateInitData("user=%7B%22id%22%3A1%7D&auth_date=1", BOT, 600)).ok, false);
});

Deno.test("no user id → not ok", async () => {
  const authDate = String(Math.floor(Date.now() / 1000));
  const initData = await signInitData({ user: JSON.stringify({ username: "x" }), auth_date: authDate }, BOT);
  assertEquals((await validateInitData(initData, BOT, 600)).ok, false);
});
