import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { UserX } from "lucide-react";

/**
 * Shown inside the Telegram Mini App when the signed-in Telegram user cannot be
 * resolved to a profile (never linked, not a group member, ambiguous username, …).
 *
 * Recovery: an ACTIVE student already has their telegram_id linked and never reaches
 * this screen. For the rare unresolved case we offer a website login so the student is
 * never stranded — they sign in with the account they already have. (A follow-up can
 * bind their telegram_id after that login so it becomes automatic next time.) Web mode
 * never reaches this screen — the gate passes web visitors straight through.
 */
export default function TgNotLinked() {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-background text-foreground">
      <div className="w-full max-w-sm space-y-4 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-muted">
          <UserX className="h-7 w-7 text-muted-foreground" />
        </div>
        <h1 className="text-lg font-semibold">{t("miniapp.notLinkedTitle")}</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">{t("miniapp.notLinkedBody")}</p>
        <Link
          to="/login"
          className="inline-flex w-full items-center justify-center rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90"
        >
          {t("miniapp.notLinkedLogin")}
        </Link>
      </div>
    </div>
  );
}
