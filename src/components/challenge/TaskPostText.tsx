import { parsePostHtml } from "@/lib/dailyTasks";

/** The daily task post exactly as the bot posts it (bold runs kept), rendered as TEXT — never as HTML. */
export function TaskPostText({ html, className }: { html: string; className?: string }) {
  const parts = parsePostHtml(html);
  return (
    <div className={`whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground ${className ?? ""}`}>
      {parts.map((p, i) => (p.bold ? <strong key={i} className="font-extrabold">{p.text}</strong> : <span key={i}>{p.text}</span>))}
    </div>
  );
}
