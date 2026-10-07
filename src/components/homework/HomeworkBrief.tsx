import { Fragment, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { type BriefRow, pickPrompt } from "@/lib/homeworkBrief";

export { pickPrompt };

/* The homework's DESCRIPTION — one component for every place a student opens a homework (2026-10-07, owner: "in
 * one place there is a description, in another there is none"). Mounted by ModuleHomework.tsx (Darslar → module
 * → Uy vazifasi) and by Homework.tsx's picker upload stage (Vazifa tab → Yangi vazifa topshirish).
 *
 * Text precedence (unchanged from ModuleHomework): prompt_<lang> → prompt_uz → prompt_ru → prompt_en →
 * description. A step of a multi-step homework (parent_id set — module 3's three videos) usually has no text of
 * its own: it shows its parent's. `**bold**` (how the descriptions are written) renders bold instead of showing
 * the asterisks. Below it, always, what can be uploaded (rasm, video or fayl).
 *
 * homework_assignments is readable by any authenticated user (RLS "hwa read auth").
 */

/** The description of each assignment id (a step without text of its own gets its parent's). Never throws. */
export async function fetchHomeworkBriefs(ids: string[], lang: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!ids.length) return out;
  const cols = "id, parent_id, description, prompt_uz, prompt_ru, prompt_en";
  const { data, error } = await supabase.from("homework_assignments").select(cols).in("id", ids);
  if (error) throw error;
  const rows = (data ?? []) as BriefRow[];
  const parentIds = [...new Set(rows.filter((r) => !pickPrompt(r, lang) && r.parent_id).map((r) => r.parent_id as string))];
  const parents: Record<string, BriefRow> = {};
  if (parentIds.length) {
    const { data: pd } = await supabase.from("homework_assignments").select(cols).in("id", parentIds);
    for (const p of (pd ?? []) as BriefRow[]) parents[p.id] = p;
  }
  for (const r of rows) {
    out[r.id] = pickPrompt(r, lang) || (r.parent_id ? pickPrompt(parents[r.parent_id], lang) : "");
  }
  return out;
}

/** `**bold**` → <strong>; everything else as plain text (React escapes it). */
export function renderBold(text: string) {
  const parts = text.split(/\*\*([^*\n]+?)\*\*/g);
  return parts.map((p, i) => (i % 2 === 1 ? <strong key={i}>{p}</strong> : <Fragment key={i}>{p}</Fragment>));
}

export function HomeworkBriefText({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      {text && (
        <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-foreground/90">{renderBold(text)}</p>
      )}
      <p className="text-[12px] font-semibold text-muted-foreground">{t("homework.picker.acceptedTypes")}</p>
    </div>
  );
}

/** Self-loading variant for a single assignment (the Vazifa tab picker). */
export default function HomeworkBrief({ assignmentId }: { assignmentId: string }) {
  const { i18n } = useTranslation();
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setText(null);
    fetchHomeworkBriefs([assignmentId], i18n.language)
      .then((m) => { if (alive) setText(m[assignmentId] ?? ""); })
      .catch((e) => {
        console.error("[HomeworkBrief] load failed", e);
        if (alive) setText(""); // the upload still works; the accepted-types line still shows
      });
    return () => { alive = false; };
  }, [assignmentId, i18n.language]);

  if (text === null) return <div className="h-10 animate-pulse rounded-md bg-surface-2" />;
  return <HomeworkBriefText text={text} />;
}
