// A minimal but structurally real campaign pack, for tests only.
//
// It mirrors the fields the ENGINE reads from campaign-pack/DUMMY-pack.json (Agent C's file, which
// does not live in this repo yet). It is inlined rather than read from disk so the unit tests need
// no --allow-read and run in CI's plain `deno test supabase/functions/`.
//
// When Agent C's DUMMY-pack.json lands here, replace this with a read of that file so the tests and
// the rest of the team exercise the same fixture. Until then, keep the two structurally in step —
// the values are deliberately identical to the DUMMY pack's.

import type { CampaignPack } from "../types.ts";

export const TEST_PACK: CampaignPack = {
  manifest: {
    pack_version: "test-v1",
    campaign_name: "Test Fixture Campaign",
    language: "en",
    timezone: "Asia/Tashkent",
    starts_on: "2099-01-01",
    duration_days: 3,
    channel_id: "-1000000000001",
    discussion_group_id: "-1000000000002",
    admin_telegram_ids: ["111111111"],
  },
  schedule: {
    slots: [
      { id: "midday", time: "13:00", surface: "channel" },
      { id: "evening", time: "20:00", surface: "channel", renders: "leaderboard" },
      { id: "scorecard", time: "21:00", surface: "dm", renders: "scorecard" },
    ],
    budgets: { channel_per_day: 2, dm_per_day: 2, event_day_channel: 3 },
    quiet_hours: { from: "22:00", to: "08:00" },
  },
  economy: {
    points: {
      reaction: { value: 1, cap_per_day: 3 },
      comment: { value: 2, cap_per_day: 5, min_chars: 10 },
      question: { value: 2, tag: "#question", cap_per_day: 3 },
      task_complete: { value: 10, cap_per_day: 1 },
      peer_encouragement: { value: 3, cap_per_day: 3 },
      event_attendance: { value: 100 },
    },
    tiers: [
      { key: "bronze", threshold: 40 },
      { key: "silver", threshold: 90 },
      { key: "gold", threshold: 160 },
    ],
    endowed_progress: 20,
  },
  days: [
    { day: 1, topic: "Topic one", belief: "B1", hashtag: "#task1", task: { instruction_key: "day1.task" },
      posts: [{ slot: "midday", copy_key: "day1.midday" }, { slot: "evening", copy_key: "day1.evening" }] },
    { day: 2, topic: "Topic two", belief: "B2", hashtag: "#task2", task: { instruction_key: "day2.task" },
      posts: [{ slot: "midday", copy_key: "day2.midday" }] },
    { day: 3, topic: "Topic three", belief: "B3", hashtag: "#task3", task: { instruction_key: "day3.task" },
      posts: [{ slot: "midday", copy_key: "day3.midday" }] },
  ],
  events: [
    { id: "live_d1", date: "2099-01-04", time: "19:00", role: "build", pitch: false,
      code_words: ["apple", "river"], points: 100, countdowns: ["-24h", "-6h", "-1h", "-10m"] },
    { id: "live_d2", date: "2099-01-05", time: "19:00", role: "sell", pitch: true,
      code_words: ["window", "garden"], points: 150, countdowns: ["-24h", "-1h"] },
  ],
  commands: [
    { key: "points", command: "/points", aliases: ["points", "score"], reply_key: "cmd.points" },
    { key: "rank", command: "/rank", aliases: ["rank", "top"], reply_key: "cmd.rank" },
    { key: "help", command: "/help", aliases: ["help"], reply_key: "cmd.help" },
  ],
  cm: {
    cheer_triggers: ["first_ever_submission", "first_n_of_day", "standout", "struggling", "returning_quiet"],
    first_n_of_day: 10,
    limits: {
      text_replies_per_user_per_day: 1,
      ai_answers_per_user_per_day: 1,
      bot_messages_per_thread: 10,
      thread_revivals_per_day: 1,
      reply_delay_seconds: { min: 30, max: 90 },
    },
    reaction_emojis: ["🔥", "👏", "❤️", "🎉", "👍"],
  },
  routing: {
    escalate_keywords: ["price", "cost", "pay", "refund"],
    ai_scope: "AI tools, prompts, and today's task only",
    ai_forbidden: ["price", "dates", "payment", "refunds", "guarantees", "income"],
    holding_reply_key: "cm.escalate",
  },
  brand: {
    colors: { accent: "#DC6D55", ink: "#242323", paper: "#FCF8F6" },
    logo: "test_logo", footer_left: "Left", footer_right: "Right",
    font_regular: "Inter-Regular.ttf", font_bold: "Inter-Bold.ttf",
  },
  copy: {
    "day1.midday": { text: "Day 1 midday post.", one_cta: true },
    "day1.evening": { text: "Day 1 evening post.", one_cta: true },
    "day1.task": { text: "Day 1 task instruction." },
    "day2.midday": { text: "Day 2 midday post.", one_cta: true },
    "day3.midday": { text: "Day 3 midday post.", one_cta: true },
    "cheer.first_submission": { variants: ["Cheer A", "Cheer B", "Cheer C", "Cheer D", "Cheer E"] },
    "nudge.quiet": { variants: ["Nudge A", "Nudge B", "Nudge C", "Nudge D", "Nudge E"] },
    "cmd.points": { text: "You have {points} points, rank {rank}." },
    "cmd.rank": { text: "Rank {rank}." },
    "cmd.help": { text: "Help text." },
    "cm.escalate": { text: "A human will get back to you." },
    "btn.commit": { text: "Count me in" },
  },
};

/** A deep copy, so a test that mutates the pack cannot leak into the next one. */
export function testPack(): CampaignPack {
  return structuredClone(TEST_PACK);
}
