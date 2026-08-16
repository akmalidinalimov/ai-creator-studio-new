import { useTranslation } from "react-i18next";
import { UserX } from "lucide-react";

/**
 * Shown inside the Telegram Mini App when the signed-in Telegram user cannot be
 * resolved to a profile (never linked, not a group member, ambiguous username, …).
 *
 * There is deliberately NO login link: inside Telegram, auth is automatic — the fix is
 * an admin/teacher linking the account, not the student typing a password. Web mode
 * never reaches this screen (the gate passes web visitors straight through).
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
      </div>
    </div>
  );
}
