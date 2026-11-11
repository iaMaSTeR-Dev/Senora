import { createContext, useContext } from 'react';
import { Language, translations } from './i18n';
import { uiTranslations } from './uiTranslations';

export const LanguageContext = createContext<Language>('en');
export function useUILanguage(preferred?: Language): Language {
  const language = useContext(LanguageContext);
  return preferred ?? language;
}

const catalog = new Map<string, { en: string; fa: string }>();
for (const [en, fa] of uiTranslations) {
  catalog.set(en, { en, fa });
  catalog.set(fa, { en, fa });
}
for (const key of Object.keys(translations.en) as (keyof typeof translations.en)[]) {
  const en = translations.en[key];
  const fa = translations.fa[key];
  if (!catalog.has(en)) catalog.set(en, { en, fa });
  if (!catalog.has(fa)) catalog.set(fa, { en, fa });
}

/** Preserve surrounding inline whitespace while translating application labels, never user content. */
export function uiText(text: string, language: Language): string {
  const key = text.trim();
  const entry = catalog.get(key);
  return entry ? text.replace(key, entry[language]) : text;
}
