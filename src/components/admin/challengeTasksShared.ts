// Shared by the «Kunlik vazifalar» admin page, its day drawer and its plan importer (Daily Tasks PR-2).
import type { Json } from "@/integrations/supabase/types";
import { isoWeekday, MONTH_UZ, WEEKDAY_SHORT_UZ, type TaskSource } from "@/lib/dailyTasksPlan";

export type TaskRow = {
  id: number;
  course_id: string;
  task_date: string;
  type: string;
  title: string;
  body: string;
  learn_line: string | null;
  submit_hint: string | null;
  accepts: string[];
  requires: Json;
  min_text_chars: number | null;
  min_duration_sec: number | null;
  minutes: number | null;
  points: number | null;
  check_rubric: string | null;
  requires_tag: boolean | null;
  status: string;
  source: string;
  plan_ref: string | null;
  plan_format: string | null;
  approved_at: string | null;
  updated_at: string;
};

export type PostRow = {
  task_id: number;
  group_id: string;
  kind: string;
  state: string;
  chat_id: number;
  thread_id: number | null;
  message_id: number | null;
  sent_at: string | null;
};

export type GroupLite = {
  id: string;
  name: string;
  daily_task_chat_id: number | null;
  daily_task_topic_id: number | null;
};

export const STATUS_UZ: Record<string, string> = { draft: "Qoralama", approved: "Tasdiqlangan", cancelled: "Bekor qilingan" };
export const SOURCE_UZ: Record<TaskSource, string> = { manual: "Qo‘lda", import: "Rejadan", ai_draft: "AI qoralama", retro: "Retro (o‘tgan kun)" };
export const POST_STATE_UZ: Record<string, string> = {
  queued: "navbatda", sending: "yuborilmoqda", sent: "bot e’lon qildi", failed: "xato", sent_via_sql: "bot e’lon qildi (SQL)",
  skipped: "o‘tkazildi", manual: "qo‘lda e’lon qilingan",
};

/** "1-oktabr, Pa" */
export function prettyDate(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${d}-${MONTH_UZ[m - 1]}, ${WEEKDAY_SHORT_UZ[isoWeekday(iso) - 1]}`;
}

/** t.me link of a stored post (the Bot API chat id carries -100). */
export function postLink(p: Pick<PostRow, "chat_id" | "thread_id" | "message_id">): string | null {
  if (!p.message_id) return null;
  const chat = String(p.chat_id).replace(/^-100/, "");
  return p.thread_id ? `https://t.me/c/${chat}/${p.thread_id}/${p.message_id}` : `https://t.me/c/${chat}/${p.message_id}`;
}
