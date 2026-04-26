import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import uz from "./locales/uz.json";
import ru from "./locales/ru.json";
import en from "./locales/en.json";

export const SUPPORTED_LANGUAGES = [
  { code: "uz", label: "O'zbekcha", short: "Uz", flag: "🇺🇿" },
  { code: "ru", label: "Русский", short: "Ru", flag: "🇷🇺" },
  { code: "en", label: "English", short: "En", flag: "🇺🇸" },
] as const;

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]["code"];

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      uz: { translation: uz },
      ru: { translation: ru },
      en: { translation: en },
    },
    fallbackLng: "uz",
    supportedLngs: ["uz", "ru", "en"],
    interpolation: { escapeValue: false },
    detection: {
      order: ["localStorage", "navigator", "htmlTag"],
      lookupLocalStorage: "lng",
      caches: ["localStorage"],
    },
  });

export default i18n;
