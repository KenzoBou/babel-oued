// Fonctions en ligne : Gemini, puis Mistral, Groq et OpenRouter en secours (offres gratuites).
// Les clés restent sur le téléphone.
import { get, set } from 'idb-keyval';
import { LANGS, NAME, type AnyLang, type LangCode } from './langs';

export interface Settings {
  geminiKey: string;
  model: string;
  /** Secours si Gemini est saturé ou à court de quota (facultatifs). */
  mistralKey: string;
  groqKey: string;
  openrouterKey: string;
  /** Vérifier en ligne automatiquement quand seule la traduction hors ligne est disponible. */
  autoVerify: boolean;
}
export const DEFAULT_MODEL = 'gemini-flash-latest';

export function loadSettings(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem('settings') || '{}');
    return {
      geminiKey: s.geminiKey || '', model: s.model || DEFAULT_MODEL,
      mistralKey: s.mistralKey || '', groqKey: s.groqKey || '', openrouterKey: s.openrouterKey || '',
      autoVerify: s.autoVerify !== false,
    };
  } catch {
    return { geminiKey: '', model: DEFAULT_MODEL, mistralKey: '', groqKey: '', openrouterKey: '', autoVerify: true };
  }
}
export function saveSettings(s: Settings) {
  localStorage.setItem('settings', JSON.stringify(s));
}
export function hasAnyKey() {
  const s = loadSettings();
  return !!(s.geminiKey || s.mistralKey || s.groqKey || s.openrouterKey);
}
export function onlineAvailable() {
  return navigator.onLine && hasAnyKey();
}

const S = (properties: Record<string, any>, required = Object.keys(properties)) => ({ type: 'OBJECT', properties, required });
const STR = { type: 'STRING' };
const BOOL = { type: 'BOOLEAN' };

export const FALLBACK_MODEL = 'gemini-flash-lite-latest';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Erreurs passagères côté Google (surcharge, panne) : on réessaie puis on change de modèle. */
const TRANSIENT = new Set([500, 502, 503, 504]);

/** Au-delà, on abandonne la requête : un modèle surchargé peut mettre 40 s à répondre 503. */
const TIMEOUT_MS = 12000;

async function request(model: string, key: string, prompt: string, schema: any) {
  return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.2 },
    }),
  });
}

/** Échec d'un fournisseur : message pour l'utilisateur, et code HTTP pour choisir le message final. */
class ProviderError extends Error {
  constructor(message: string, public status = 0) { super(message); }
}

/** Gemini : 2 essais sur le modèle choisi, puis 2 sur le modèle léger (quota et charge séparés). */
async function viaGemini(key: string, model: string, prompt: string, schema: any): Promise<string> {
  const plan: [string, number][] = [[model, 0], [model, 1000]];
  if (model !== FALLBACK_MODEL) plan.push([FALLBACK_MODEL, 0], [FALLBACK_MODEL, 2000]);
  let res: Response | undefined;
  let skip = '';
  for (const [m, wait] of plan) {
    if (m === skip) continue;
    if (wait) await sleep(wait);
    try {
      res = await request(m, key, prompt, schema);
    } catch {
      res = undefined; // coupure réseau ou délai dépassé : on retente
      continue;
    }
    if (res.ok) break;
    // Quota épuisé : inutile de réinsister sur ce modèle, mais le modèle de secours a son propre quota.
    if (res.status === 429) { skip = m; continue; }
    if (!TRANSIENT.has(res.status)) break;
  }
  if (!res) throw new ProviderError('Gemini ne répond pas');
  if (!res.ok) throw new ProviderError(`Gemini : erreur ${res.status}`, res.status);
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';
}

/** Schéma au format Gemini (types en majuscules) → JSON Schema, pour l'insérer dans la consigne. */
function toJsonSchema(x: any): any {
  if (Array.isArray(x)) return x.map(toJsonSchema);
  if (!x || typeof x !== 'object') return x;
  const o: any = {};
  for (const [k, v] of Object.entries(x)) o[k] = k === 'type' ? String(v).toLowerCase() : toJsonSchema(v);
  return o;
}

/** API compatibles OpenAI (Mistral, Groq, OpenRouter) : mode JSON, schéma rappelé dans la consigne. */
const COMPAT = {
  mistral: { name: 'Mistral', url: 'https://api.mistral.ai/v1/chat/completions', model: 'mistral-small-latest', headers: {} },
  groq: { name: 'Groq', url: 'https://api.groq.com/openai/v1/chat/completions', model: 'openai/gpt-oss-120b', headers: {} },
  // « openrouter/free » choisit lui-même un modèle gratuit disponible (la liste change souvent).
  openrouter: { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions', model: 'openrouter/free', headers: { 'X-Title': 'Babel-Oued' } },
};
type Compat = (typeof COMPAT)[keyof typeof COMPAT];

/** Certains modèles entourent le JSON de texte ou de ```json : on garde l'objet seul. */
function extractJson(text: string): string {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  return a >= 0 && b > a ? text.slice(a, b + 1) : text;
}
async function viaCompat(p: Compat, key: string, prompt: string, schema: any): Promise<string> {
  const content = `${prompt}

Réponds uniquement avec un objet JSON valide, conforme à ce JSON Schema (tous les champs sont obligatoires) :
${JSON.stringify(toJsonSchema(schema))}`;
  let res: Response | undefined;
  for (const wait of [0, 1500]) {
    if (wait) await sleep(wait);
    try {
      res = await fetch(p.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...p.headers },
        signal: AbortSignal.timeout(TIMEOUT_MS + 8000),
        body: JSON.stringify({
          model: p.model,
          messages: [{ role: 'user', content }],
          response_format: { type: 'json_object' },
          temperature: 0.2,
        }),
      });
    } catch {
      res = undefined;
      continue;
    }
    if (res.ok || !TRANSIENT.has(res.status)) break;
  }
  if (!res) throw new ProviderError(`${p.name} ne répond pas`);
  if (!res.ok) throw new ProviderError(`${p.name} : erreur ${res.status}`, res.status);
  const data = await res.json();
  return extractJson(data?.choices?.[0]?.message?.content ?? '');
}

/** Interroge les fournisseurs configurés dans l'ordre, jusqu'au premier qui répond. */
async function call<T>(prompt: string, schema: any, cacheKey: string): Promise<T> {
  const cached = await get(cacheKey).catch(() => undefined);
  if (cached) return cached as T;
  const s = loadSettings();
  const tries: [string, () => Promise<string>][] = [];
  if (s.geminiKey) tries.push(['Gemini', () => viaGemini(s.geminiKey, s.model, prompt, schema)]);
  if (s.mistralKey) tries.push(['Mistral', () => viaCompat(COMPAT.mistral, s.mistralKey, prompt, schema)]);
  if (s.groqKey) tries.push(['Groq', () => viaCompat(COMPAT.groq, s.groqKey, prompt, schema)]);
  if (s.openrouterKey) tries.push(['OpenRouter', () => viaCompat(COMPAT.openrouter, s.openrouterKey, prompt, schema)]);
  if (!tries.length) throw new Error('Ajoute une clé d’IA (Gemini, Mistral, Groq ou OpenRouter) dans les réglages.');
  const errors: ProviderError[] = [];
  for (const [name, run] of tries) {
    try {
      const out = JSON.parse(await run()) as T;
      await set(cacheKey, out).catch(() => {});
      return out;
    } catch (e) {
      errors.push(e instanceof ProviderError ? e : new ProviderError(`${name} : réponse illisible`));
    }
  }
  const st = errors.map((e) => e.status);
  if (st.some((x) => x === 400 || x === 401 || x === 403)) throw new Error(`Clé ou modèle refusé (${errors.map((e) => e.message).join(' ; ')}). Vérifie les réglages.`);
  if (st.every((x) => x === 429)) throw new Error('Quota gratuit atteint partout pour le moment, réessaie plus tard.');
  const hint = tries.length === 1 ? ' Ajoute une clé Mistral, Groq ou OpenRouter dans les réglages pour avoir un secours.' : '';
  throw new Error(`Aucun service d’IA disponible en ce moment (${errors.map((e) => e.message).join(' ; ')}). Réessaie dans une minute.${hint}`);
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
  /** Groupe de mots auquel appartient le mot dans la phrase (« mi sei mancata »). */
  groupe: string;
  /** Pourquoi la phrase est construite ainsi, comparé au français. */
  construction: string;
  /** Erreur qu'un francophone ferait naturellement, et pourquoi elle est fausse ; vide si aucune. */
  piege: string;
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
Réponds en français, de façon concise et exacte. Le plus important est d'expliquer le mot DANS CETTE PHRASE, pas dans l'absolu :
- groupe : le groupe de mots de la phrase auquel ce mot appartient et qui forme une unité grammaticale (ex. « mi sei mancata » pour « sei »), tel qu'il apparaît dans la phrase.
- construction : 2 à 4 phrases. Explique pourquoi la phrase est construite ainsi : qui est le sujet, quel auxiliaire et pourquoi, avec quoi s'accorde le participe, quel cas ou quelle préposition est régi, en comparant explicitement avec la construction française de la phrase originale quand elle diffère.
- piege : la forme qu'un francophone dirait par calque du français (ex. « mi hai mancata ») et pourquoi elle est fausse, en une ou deux phrases ; vide si le calque du français serait correct.
- lemme : forme de dictionnaire du mot.
- nature : nature grammaticale et forme précise (genre, nombre, cas, temps, mode, personne...).
- role : POURQUOI ce mot et cette forme sont là dans CETTE phrase (fonction, règle de grammaire, accord, cas régi, choix idiomatique) ; 1 à 3 phrases.
- racine : étymologie (racine latine, grecque, germanique, slave...). Si tu n'es pas sûr, dis-le plutôt que d'inventer.
- liens : 3 à 6 mots apparentés ou équivalents dans mes autres langues (fr, en, es, de, it, ru, hors ${NAME[lang]}), en écriture originale (cyrillique pour le russe, avec translittération entre parenthèses), avec une note courte : même racine (cognat) ou simple équivalent, faux ami éventuel.`;
  return call<Explanation>(
    prompt,
    S({ groupe: STR, construction: STR, piege: STR, lemme: STR, nature: STR, role: STR, racine: STR, liens: { type: 'ARRAY', items: S({ lang: STR, mot: STR, note: STR }) } }),
    `ex:v2:${lang}:${word}:${sentence}`,
  );
}

export interface ContextLine {
  lang: LangCode;
  texte: string;
  translit: string;
  note: string;
}
export interface ContextAnswer {
  phrase_fr: string;
  traductions: ContextLine[];
  conseil: string;
}
/** Traduction guidée par une situation décrite librement (« je suis dans un magasin, je veux dire… »). */
export function translateWithContext(request: string) {
  const prompt = `Tu es un interprète natif dans chacune de ces langues : ${langList}. Je suis francophone.
Je te décris librement une situation et ce que je veux exprimer. Déduis-en ce que je veux dire et la façon la plus naturelle de le dire, comme un local le dirait spontanément dans CETTE situation (registre, politesse, formule toute faite d'usage s'il en existe une), pas une traduction mot à mot.
- phrase_fr : la phrase que je dirais en français dans cette situation (courte, naturelle).
- traductions : pour chaque langue (${LANGS.map((l) => l.code).join(', ')}), texte = la phrase à dire ; translit = translittération latine pour le russe, vide pour les autres ; note = en français, très court, une nuance d'usage utile (tu/vous, formule plus polie, variante courante), vide si rien d'utile.
- conseil : en français, une phrase maximum sur un réflexe culturel lié à la situation, vide si rien de pertinent.

Ma demande : ${request}`;
  return call<ContextAnswer>(
    prompt,
    S({
      phrase_fr: STR,
      traductions: { type: 'ARRAY', items: S({ lang: { type: 'STRING', enum: LANGS.map((l) => l.code) }, texte: STR, translit: STR, note: STR }) },
      conseil: STR,
    }),
    `cx:v1:${request}`,
  );
}

export interface Origin {
  lang: AnyLang;
  sens: string;
  mot_a_mot: { mot: string; litteral: string; role: string }[];
  litteral: string;
  logique: string;
  origine: string;
  equivalents: { lang: string; texte: string }[];
}
/** Décortique une phrase ou expression : sens, mot à mot, pourquoi elle veut dire ça, d'où elle vient. */
export function explainOrigin(phrase: string) {
  const prompt = `Je suis francophone et je parle aussi anglais, espagnol, allemand, italien et russe. Je ne comprends pas d'où vient cette phrase ou expression, ni pourquoi elle veut dire ce qu'elle veut dire :
« ${phrase} »
Réponds en français, de façon concise, exacte et pédagogique :
- lang : la langue de la phrase (fr, en, es, de, it ou ru).
- sens : ce que la phrase veut dire, en français naturel.
- mot_a_mot : chaque mot ou groupe de mots dans l'ordre (mot = tel qu'écrit ; litteral = sa traduction littérale en français ; role = sa fonction grammaticale en quelques mots).
- litteral : la traduction mot à mot complète en français, même si elle sonne bizarre.
- logique : 2 à 4 phrases. Comment on passe du sens littéral au sens réel : image ou métaphore sous-jacente, construction grammaticale particulière, évolution du sens.
- origine : histoire ou étymologie de l'expression (époque, usage d'origine, racines des mots clés). Si l'origine est incertaine ou discutée, dis-le plutôt que d'inventer.
- equivalents : la façon de dire la même chose dans mes autres langues (fr, en, es, de, it, ru, hors la langue de la phrase), en écriture originale (cyrillique pour le russe, translittération entre parenthèses).`;
  return call<Origin>(
    prompt,
    S({
      lang: { type: 'STRING', enum: ['fr', 'en', 'es', 'de', 'it', 'ru'] },
      sens: STR,
      mot_a_mot: { type: 'ARRAY', items: S({ mot: STR, litteral: STR, role: STR }) },
      litteral: STR,
      logique: STR,
      origine: STR,
      equivalents: { type: 'ARRAY', items: S({ lang: STR, texte: STR }) },
    }),
    `or:v1:${phrase}`,
  );
}

export interface QA { q: string; a: string }
/** Question libre de suivi sur un mot, dans le contexte de sa phrase et de l'explication déjà donnée. */
export function askAboutWord(word: string, lang: AnyLang, sentence: string, original: string, explanation: string, thread: QA[], question: string) {
  const prompt = `Je suis francophone et je parle aussi anglais, espagnol, allemand, italien et russe. J'apprends en faisant des liens entre ces langues.
Phrase originale (français) : « ${original} »
Phrase en ${NAME[lang]} : « ${sentence} »
Mot étudié : « ${word} »
${explanation ? `Explication déjà donnée :\n${explanation}\n` : ''}${thread.length ? `Échanges précédents :\n${thread.map((t) => `Q : ${t.q}\nR : ${t.a}`).join('\n')}\n` : ''}
Ma question : ${question}

Réponds en français, directement à la question, de façon concise (3 à 6 phrases maximum), exacte et concrète, avec des exemples courts si c'est utile. Si tu n'es pas sûr, dis-le plutôt que d'inventer.`;
  return call<{ reponse: string }>(
    prompt,
    S({ reponse: STR }),
    `qa:v1:${lang}:${word}:${sentence}:${JSON.stringify(thread)}:${question}`,
  );
}
