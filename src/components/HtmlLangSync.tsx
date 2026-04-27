import { useEffect } from "react";
import { useTranslation } from "react-i18next";

/**
 * Keeps <html lang="..."> in sync with the active i18next language.
 * Mounted once near the root.
 */
export const HtmlLangSync = () => {
  const { i18n } = useTranslation();
  useEffect(() => {
    const apply = (lng: string) => {
      if (typeof document !== "undefined") {
        document.documentElement.lang = lng || "uz";
      }
    };
    apply(i18n.language);
    i18n.on("languageChanged", apply);
    return () => {
      i18n.off("languageChanged", apply);
    };
  }, [i18n]);
  return null;
};
