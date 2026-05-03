import { supabase } from "@/integrations/supabase/client";

export const SETTING_DEFAULTS: Record<string, any> = {
  "homework.default_max_score": 10,
  "homework.default_tasks_per_module": 3,
  "homework.allow_per_task_max_score": true,
  "homework.comment_mode": "off",
  "engagement.daily_goal_default": 1,
  "engagement.streak_warning_after_days": 3,
  "engagement.activity_score_weights": { lessons: 0.4, homework: 0.3, streak: 0.2, minutes: 0.1 },
  "engagement.group_health_weights": { active: 0.4, completion: 0.4, score: 0.2 },
  "notifications.quiet_hours_start": "22:00",
  "notifications.quiet_hours_end": "08:00",
  "notifications.weekly_nudge_limit": 3,
  "notifications.broadcast_per_teacher_per_hour": 1,
  "re_engagement.default_cadence_days": [0, 3, 7, 14],
  "leaderboard.top_n": 10,
  "leaderboard.anonymize_last_name": true,
  "bot.test_recipient_username": "alikhanova_admin",
  "bot.magic_link_expiry_days": 7,
};

const cache = new Map<string, { v: any; t: number }>();
const TTL = 60_000;

export async function getSetting<T = any>(key: string): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v as T;
  const { data } = await supabase.rpc("get_setting" as any, { _key: key });
  const value = data ?? SETTING_DEFAULTS[key];
  cache.set(key, { v: value, t: Date.now() });
  return value as T;
}

export function clearSettingCache(key?: string) {
  if (key) cache.delete(key);
  else cache.clear();
}
