import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import ptBR from "./locales/pt-BR.json";

const STORAGE_KEY = "printflow3d-language";

// Default UI language is pt-BR (product audience is Brazilian). A saved
// choice in localStorage takes precedence; the selector lives in Settings.
function getInitialLanguage(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "pt-BR") return saved;
  } catch {
    /* ignore */
  }
  return "pt-BR";
}

i18n.use(initReactI18next).init({
  lng: getInitialLanguage(),
  fallbackLng: "en",
  defaultNS: "translation",
  resources: {
    en: { translation: en },
    "pt-BR": { translation: ptBR },
  },
  interpolation: {
    escapeValue: false,
  },
});

export function changeLanguage(lng: string): void {
  i18n.changeLanguage(lng);
  try {
    localStorage.setItem(STORAGE_KEY, lng);
  } catch {
    /* ignore */
  }
}

export function getCurrentLanguage(): string {
  return i18n.language;
}

export const AVAILABLE_LANGUAGES = [
  { code: "pt-BR", label: "Português (Brasil)" },
  { code: "en", label: "English" },
] as const;

export default i18n;
