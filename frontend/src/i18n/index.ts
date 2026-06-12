import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import deCommon from "./de/common.json";
import deAuth from "./de/auth.json";
import deSettings from "./de/settings.json";
import enCommon from "./en/common.json";
import enAuth from "./en/auth.json";
import enSettings from "./en/settings.json";

export const SUPPORTED_LANGUAGES = ["de", "en"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      de: { common: deCommon, auth: deAuth, settings: deSettings },
      en: { common: enCommon, auth: enAuth, settings: enSettings },
    },
    fallbackLng: "de",
    defaultNS: "common",
    ns: ["common", "auth", "settings"],
    interpolation: { escapeValue: false }, // React escaped bereits
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: "budget-pal-ui-language",
      caches: ["localStorage"],
    },
  });

export default i18n;
