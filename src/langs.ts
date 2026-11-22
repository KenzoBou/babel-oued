export type LangCode = 'en' | 'es' | 'de' | 'it' | 'ru';
export type AnyLang = LangCode | 'fr';

export interface Lang {
  code: LangCode;
  name: string;
  flag: string;
  /** Modèle Opus-MT (ONNX, transformers.js). */
  model: string;
  /** Langue intermédiaire quand il n'existe pas de modèle direct depuis le français. */
  pivot?: LangCode;
}

/** Dans l'ordre d'affichage voulu. */
export const LANGS: Lang[] = [
  { code: 'en', name: 'Anglais', flag: '🇬🇧', model: 'Xenova/opus-mt-fr-en' },
  { code: 'es', name: 'Espagnol', flag: '🇪🇸', model: 'Xenova/opus-mt-fr-es' },
  { code: 'de', name: 'Allemand', flag: '🇩🇪', model: 'Xenova/opus-mt-fr-de' },
  { code: 'it', name: 'Italien', flag: '🇮🇹', model: 'Xenova/opus-mt-es-it', pivot: 'es' },
  { code: 'ru', name: 'Russe', flag: '🇷🇺', model: 'Xenova/opus-mt-fr-ru' },
];

export const FLAG: Record<AnyLang, string> = {
  fr: '🇫🇷', en: '🇬🇧', es: '🇪🇸', de: '🇩🇪', it: '🇮🇹', ru: '🇷🇺',
};
export const NAME: Record<AnyLang, string> = {
  fr: 'Français', en: 'Anglais', es: 'Espagnol', de: 'Allemand', it: 'Italien', ru: 'Russe',
};
