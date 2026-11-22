// Fonctions en ligne (API Gemini, offre gratuite). La clé reste sur le téléphone.
import { get, set } from 'idb-keyval';
import { LANGS, NAME, type AnyLang, type LangCode } from './langs';

export interface Settings {
  geminiKey: string;
  model: string;
}
export const DEFAULT_MODEL = 'gemini-flash-latest';

export function loadSettings(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem('settings') || '{}');
    return { geminiKey: s.geminiKey || '', model: s.model || DEFAULT_MODEL };
  } catch {
    return { geminiKey: '', model: DEFAULT_MODEL };
  }
}
export function saveSettings(s: Settings) {
  localStorage.setItem('settings', JSON.stringify(s));
}
export function onlineAvailable() {
  return navigator.onLine && !!loadSettings().geminiKey;
}

const S = (properties: Record<string, any>, required = Object.keys(properties)) => ({ type: 'OBJECT', properties, required });
const STR = { type: 'STRING' };
const BOOL = { type: 'BOOLEAN' };

async function call<T>(prompt: string, schema: any, cacheKey: string): Promise<T> {
  const cached = await get(cacheKey).catch(() => undefined);
  if (cached) return cached as T;
  const { geminiKey, model } = loadSettings();
  if (!geminiKey) throw new Error('Ajoute ta clé Gemini dans les réglages.');
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.2 },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 429) throw new Error('Quota gratuit Gemini atteint pour le moment, réessaie plus tard.');
    if (res.status === 400 || res.status === 403) throw new Error(`Clé ou modèle Gemini refusé (${res.status}). Vérifie les réglages.`);
    throw new Error(`Gemini : erreur ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';
  const out = JSON.parse(text) as T;
  await set(cacheKey, out).catch(() => {});
  return out;
}

const langList = LANGS.map((l) => `${l.code} = ${l.name}`).join(', ');

export type Translations = Record<LangCode, string>;

export function translateOnline(fr: string) {
  const prompt = `Tu es un traducteur littéraire natif dans chacune de ces langues : ${langList}.
Traduis la phrase française ci-dessous de façon naturelle et idiomatique, comme le dirait spontanément un locuteur natif, en respectant le registre (familier, neutre, soutenu).
Ne traduis jamais une expression figée mot à mot : remplace-la par l'expression équivalente de la langue cible, ou à défaut par son sens.
Dans "notes", en français et en une ou deux phrases, signale uniquement s'il y a une expression idiomatique ou une ambiguïté et comment tu l'as rendue ; sinon laisse vide.

Phrase : ${fr}`;
  return call<Translations & { notes: string }>(
    prompt,
    S({ en: STR, es: STR, de: STR, it: STR, ru: STR, notes: STR }),
    `tr:v1:${fr}`,
  );
}

export interface Verdict {
  lang: LangCode;
  ok: boolean;
  probleme: string;
  correction: string;
}
export function verifyOnline(fr: string, tr: Partial<Translations>) {
  const lines = LANGS.map((l) => `${l.code} (${l.name}) : ${tr[l.code] ?? ''}`).join('\n');
  const prompt = `Tu es un relecteur expert, natif de chacune de ces langues. Voici une phrase française et ses traductions automatiques.
Pour chaque langue, dis si la traduction rend fidèlement le SENS et le REGISTRE de l'original (une expression figée traduite mot à mot = faux).
Sois exigeant mais ne corrige pas une traduction correcte pour une simple préférence de style.
Pour chaque langue : ok (vrai/faux), probleme (en français, court, vide si ok), correction (la traduction idiomatique à utiliser ; recopie l'originale si ok).

Phrase française : ${fr}
${lines}`;
  return call<{ verdicts: Verdict[]; resume: string }>(
    prompt,
    S({
      verdicts: { type: 'ARRAY', items: S({ lang: { type: 'STRING', enum: LANGS.map((l) => l.code) }, ok: BOOL, probleme: STR, correction: STR }) },
      resume: STR,
    }),
    `ve:v1:${fr}:${JSON.stringify(tr)}`,
  );
}

export interface Explanation {
  lemme: string;
  nature: string;
  role: string;
  racine: string;
  liens: { lang: string; mot: string; note: string }[];
}
export function explainOnline(word: string, lang: AnyLang, sentence: string, original: string, dictHint: string) {
  const prompt = `Je suis francophone et je parle aussi anglais, espagnol, allemand, italien et russe. J'apprends en faisant des liens entre ces langues.
Phrase originale (français) : « ${original} »
Phrase en ${NAME[lang]} : « ${sentence} »
Mot cliqué : « ${word} »
${dictHint ? `Données du Wiktionnaire (fiables) :\n${dictHint}\n` : ''}
Réponds en français, de façon concise et exacte :
- lemme : forme de dictionnaire du mot.
- nature : nature grammaticale et forme précise (genre, nombre, cas, temps, mode, personne...).
- role : POURQUOI ce mot et cette forme sont là dans CETTE phrase (fonction, règle de grammaire, accord, cas régi, choix idiomatique) ; 1 à 3 phrases.
- racine : étymologie (racine latine, grecque, germanique, slave...). Si tu n'es pas sûr, dis-le plutôt que d'inventer.
- liens : 3 à 6 mots apparentés ou équivalents dans mes autres langues (fr, en, es, de, it, ru, hors ${NAME[lang]}), en écriture originale (cyrillique pour le russe, avec translittération entre parenthèses), avec une note courte : même racine (cognat) ou simple équivalent, faux ami éventuel.`;
  return call<Explanation>(
    prompt,
    S({ lemme: STR, nature: STR, role: STR, racine: STR, liens: { type: 'ARRAY', items: S({ lang: STR, mot: STR, note: STR }) } }),
    `ex:v1:${lang}:${word}:${sentence}`,
  );
}
