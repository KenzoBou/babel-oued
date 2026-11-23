import { get, set } from 'idb-keyval';
import type { LangCode } from './langs';

/** Thème : du français vers la langue. Version : de la langue vers le français. */
export type Dir = 'theme' | 'version';
export interface Srs { box: number; due: number }
export interface SavedItem {
  id: string;
  lang: LangCode;
  /** Mot ou expression dans la langue apprise. */
  text: string;
  /** Sens en français. */
  fr: string;
  added: number;
  srs: Record<Dir, Srs>;
}

const KEY = 'saved';
const DAY = 86_400_000;
/** Répétition espacée (boîtes de Leitner) : intervalle en jours selon la boîte atteinte. */
const INTERVALS = [0, 1, 3, 7, 16, 35, 90];
export const MAX_BOX = INTERVALS.length - 1;

let items: SavedItem[] = [];
const listeners = new Set<() => void>();

export async function loadSaved() {
  items = ((await get(KEY).catch(() => null)) as SavedItem[] | null) ?? [];
  emit();
}
export const allSaved = () => items;
export const onSavedChange = (f: () => void) => listeners.add(f);
function emit() { for (const f of listeners) f(); }
async function persist() {
  emit();
  await set(KEY, items).catch(() => {});
}

const norm = (s: string) => s.trim().toLocaleLowerCase().replace(/\s+/g, ' ').replace(/[\s.!?¡¿…]+$/u, '');
export const findSaved = (lang: LangCode, text: string) => items.find((x) => x.lang === lang && norm(x.text) === norm(text));

export async function addSaved(lang: LangCode, text: string, fr: string) {
  text = text.trim();
  fr = fr.trim();
  if (!text) return;
  const ex = findSaved(lang, text);
  if (ex) { if (fr) ex.fr = fr; }
  else {
    const fresh = (): Srs => ({ box: 0, due: 0 });
    items.unshift({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, lang, text, fr, added: Date.now(), srs: { theme: fresh(), version: fresh() } });
  }
  await persist();
}
export async function updateSaved(id: string, patch: Partial<Pick<SavedItem, 'text' | 'fr'>>) {
  const it = items.find((x) => x.id === id);
  if (!it) return;
  Object.assign(it, patch);
  await persist();
}
export async function removeSaved(id: string) {
  items = items.filter((x) => x.id !== id);
  await persist();
}
export async function restoreSaved(it: SavedItem) {
  if (!items.some((x) => x.id === it.id)) items.unshift(it);
  await persist();
}

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const isDue = (it: SavedItem, dir: Dir) => it.srs[dir].due <= Date.now();
export function dueCount(dir?: Dir, lang?: LangCode) {
  return items.filter((x) => (!lang || x.lang === lang) && (dir ? isDue(x, dir) : isDue(x, 'theme') || isDue(x, 'version'))).length;
}

/** Réponse juste : boîte suivante, réapparaît dans quelques jours. Fausse : retour à la boîte 0. */
export async function grade(it: SavedItem, dir: Dir, ok: boolean) {
  const s = it.srs[dir];
  s.box = ok ? Math.min(s.box + 1, MAX_BOX) : 0;
  s.due = ok ? startOfToday() + INTERVALS[s.box] * DAY : 0;
  await persist();
}
