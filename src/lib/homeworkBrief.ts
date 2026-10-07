// Which text is a homework's description (pure — unit-tested without a Supabase client). Used by
// src/components/homework/HomeworkBrief.tsx: prompt_<lang> → prompt_uz → prompt_ru → prompt_en → description.

export interface BriefRow {
  id: string;
  parent_id: string | null;
  description: string | null;
  prompt_uz: string | null;
  prompt_ru: string | null;
  prompt_en: string | null;
}

export function pickPrompt(row: BriefRow | undefined, lang: string): string {
  if (!row) return "";
  const lng = (lang || "uz").slice(0, 2);
  const byLang = lng === "ru" ? row.prompt_ru : lng === "en" ? row.prompt_en : row.prompt_uz;
  return (byLang || row.prompt_uz || row.prompt_ru || row.prompt_en || row.description || "").trim();
}
