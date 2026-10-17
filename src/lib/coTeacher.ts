// Adding a group's secondary teacher (Yordamchi ustoz) by Telegram username — GroupDetail's «@username» field.
//
// The account side goes through admin-create-students (role 'teacher'): it finds the profile by username
// (case-insensitive), or creates a username-only teacher account, and refuses a username that belongs to a
// student. A username-only teacher is linked to their Telegram account the first time they press /start in the
// bot (resolveProfileForTelegramUser: staff profiles skip the group-membership gate). Then the group_teachers
// row (is_primary=false) makes them one of the group's teachers: the «KURATORGA SAVOLLAR» reminders, the
// ❓ Savollar inbox and the homework DMs all fan out to primary ∪ co-teachers (_shared/group-teachers.ts).
//
// The bot can only write to someone who has pressed /start (profiles.telegram_write_access_at) — the same
// condition teacher-questions-reminder sends on — so the page shows that for every teacher.

export type UsernameCheck = { ok: true; username: string } | { ok: false; error: string };

/** "@Name", "name", "t.me/name", "https://t.me/name" → "Name" (case kept); anything else is refused. */
export function normalizeTelegramUsername(raw: string): UsernameCheck {
  let s = String(raw ?? "").trim();
  s = s.replace(/^(https?:\/\/)?(www\.)?(t|telegram)\.me\//i, "").replace(/[/?#].*$/, "");
  s = s.replace(/^@+/, "").trim();
  if (!s) return { ok: false, error: "Username kiriting" };
  if (/^\d+$/.test(s)) return { ok: false, error: "Bu raqam (ID). Telegram username kiriting, masalan @barno_ustoz" };
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(s)) {
    return { ok: false, error: "Telegram username 5–32 belgi: lotin harflari, raqamlar va _ (harf bilan boshlanadi)" };
  }
  return { ok: true, username: s };
}

export type CreateRow = { status?: string; userId?: string; error?: string };
export type AccountOutcome =
  | { ok: true; userId: string; created: boolean }
  | { ok: false; error: string };

/** admin-create-students' one result row → the teacher's profile id, or the reason it was refused. */
export function teacherAccountOutcome(row: CreateRow | null | undefined, username: string): AccountOutcome {
  if (!row) return { ok: false, error: "Server javob bermadi" };
  if ((row.status === "created" || row.status === "updated") && row.userId) {
    return { ok: true, userId: row.userId, created: row.status === "created" };
  }
  if (row.status === "role_conflict") {
    return { ok: false, error: `@${username} talaba sifatida ro'yxatdan o'tgan — uni ustoz qilib bo'lmaydi.` };
  }
  return { ok: false, error: row.error || `@${username} qo'shilmadi (${row.status || "xato"})` };
}

export type TeacherContact = {
  telegram_id?: number | string | null;
  telegram_write_access_at?: string | null;
};

/** 'ready' = the bot can write to them (questions reach them); 'needs_start' = they must press /start first. */
export function teacherReach(p: TeacherContact | null | undefined): "ready" | "needs_start" {
  return p?.telegram_id && p.telegram_write_access_at ? "ready" : "needs_start";
}
