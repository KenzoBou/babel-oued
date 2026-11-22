/// <reference lib="webworker" />
// Dictionnaire hors ligne (Wiktionnaire) : SQLite WebAssembly stocké dans l'OPFS du WebView.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

const DB_NAME = '/dict.sqlite';
const LANG_SET = new Set(['fr', 'en', 'es', 'de', 'it', 'ru']);

let db: any = null;
let idioms: { id: number; toks: string[] }[] = [];
let idiomsByTok = new Map<string, number[]>();

function post(m: unknown) {
  (self as unknown as Worker).postMessage(m);
}

export function norm(s: string): string {
  return s.replace(/[́̀]/g, '').replace(/’/g, "'").normalize('NFC').toLowerCase().trim();
}

function all(sql: string, bind: unknown[] = []): any[] {
  return db.selectObjects(sql, bind);
}

// Un seul contexte à la fois peut ouvrir les fichiers de la base (OPFS « access handles » exclusifs).
// Après un rechargement de la page, l'ancien worker peut encore les tenir quelques instants :
// le verrou fait attendre le nouveau jusqu'à ce que l'ancien soit vraiment terminé.
const LOCK = 'babel-oued-dict';
let locked: Promise<void> | null = null;
function acquireLock(): Promise<void> {
  if (!navigator.locks) return Promise.resolve();
  return (locked ??= new Promise<void>((resolve, reject) => {
    navigator.locks
      .request(LOCK, { signal: AbortSignal.timeout(20000) }, () => {
        resolve();
        return new Promise<never>(() => {}); // gardé jusqu'à la fin du worker
      })
      .catch((e: Error) => {
        locked = null;
        reject(e.name === 'AbortError' || e.name === 'TimeoutError'
          ? new Error('Le dictionnaire est déjà ouvert dans un autre onglet de l’application. Ferme-le, puis recharge la page.')
          : e);
      });
  }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function installPool(sqlite3: any) {
  for (let i = 0; ; i++) {
    try {
      return await sqlite3.installOpfsSAHPoolVfs({ name: 'babel-oued', forceReinitIfPreviouslyFailed: true });
    } catch (e) {
      // Fichiers encore tenus par un contexte en train de se fermer : on laisse le temps de les libérer.
      if (i >= 5 || !/Access Handle|NoModificationAllowed|InvalidState/i.test(String((e as Error)?.message ?? e) + (e as Error)?.name)) throw e;
      await sleep(500 * (i + 1));
    }
  }
}

async function open() {
  await acquireLock();
  const sqlite3 = await sqlite3InitModule();
  const pool = await installPool(sqlite3);
  const have = pool.getFileNames().includes(DB_NAME);
  // Version du dictionnaire fourni dans l'APK : s'il change, on le réinstalle.
  const DICT_VERSION = (await fetch('/dict.version').then((r) => (r.ok ? r.text() : '')).catch(() => '')).trim() || 'dict-v1';
  let version: string | null = null;
  if (have) {
    const probe = new pool.OpfsSAHPoolDb(DB_NAME);
    try {
      version = (probe.selectValue("SELECT v FROM meta WHERE k='version'") as string | undefined) ?? null;
    } catch { /* ancienne base sans table meta */ }
    probe.close();
  }
  if (!have || version !== DICT_VERSION) {
    // Première ouverture : le dictionnaire compressé est fourni dans l'APK.
    const res = await fetch('/dict.pack');
    if (!res.ok || !res.body) throw new Error('Dictionnaire introuvable dans l’application');
    const total = Number(res.headers.get('content-length')) || 0;
    let loaded = 0;
    const counted = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctl) {
          loaded += chunk.byteLength;
          post({ type: 'progress', loaded, total });
          ctl.enqueue(chunk);
        },
      }),
    );
    const reader = counted.pipeThrough(new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>).getReader();
    const t0 = performance.now();
    await pool.importDb(DB_NAME, async () => {
      const { value, done } = await reader.read();
      return done ? undefined : value;
    });
    console.info(`[dict] import ${Math.round(performance.now() - t0)} ms`);
    const w = new pool.OpfsSAHPoolDb(DB_NAME);
    w.exec("CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)");
    w.exec({ sql: "INSERT OR REPLACE INTO meta VALUES('version', ?)", bind: [DICT_VERSION] });
    w.close();
  }
  db = new pool.OpfsSAHPoolDb(DB_NAME);
  const t1 = performance.now();
  loadIdioms();
  console.info(`[dict] ${idioms.length} expressions chargées en ${Math.round(performance.now() - t1)} ms`);
}

// ---------- Expressions ----------
const SE = new Set(['se', 'me', 'te', 'nous', 'vous', "s'", "m'", "t'"]);
const PLACEHOLDER = new Set(["quelqu'un", 'qqn', 'quelque', 'chose', 'qqch']);
const STOP = new Set(['de', 'du', 'des', 'le', 'la', 'les', 'un', 'une', 'à', 'au', 'aux', 'en', 'et', "l'", "d'", 'se', "s'"]);

function toks(s: string): string[] {
  return norm(s).replace(/'/g, "' ").split(/[\s,.;:!?«»"()\-]+/).filter(Boolean);
}

function loadIdioms() {
  // Index partiel (créé par build_dict.py ; ajouté ici une fois pour les bases plus anciennes) :
  // sans lui, cette requête lit toute la table et prend plus d'une minute dans le WebView.
  db.exec('CREATE INDEX IF NOT EXISTS entry_multi ON entry(lang, key) WHERE multi=1');
  const rows = all("SELECT id, key FROM entry WHERE lang='fr' AND multi=1");
  idioms = [];
  idiomsByTok = new Map();
  for (const r of rows) {
    const t = toks(r.key).filter((x) => !PLACEHOLDER.has(x));
    if (t.length < 2 || t.every((x) => STOP.has(x))) continue;
    const i = idioms.push({ id: r.id, toks: t }) - 1;
    const first = t[0];
    (idiomsByTok.get(first) ?? idiomsByTok.set(first, []).get(first)!).push(i);
  }
}

function lemmas(lang: string, word: string): string[] {
  const k = norm(word);
  const out = new Set([k]);
  for (const r of all('SELECT lemma FROM form WHERE lang=? AND key=?', [lang, k])) out.add(norm(r.lemma));
  return [...out];
}

function tokMatches(idiomTok: string, cand: Set<string>) {
  if (cand.has(idiomTok)) return true;
  return SE.has(idiomTok) && [...cand].some((c) => SE.has(c));
}

function findIdioms(sentence: string) {
  const words = toks(sentence);
  const cands = words.map((w) => new Set(lemmas('fr', w.replace(/'$/, '')).concat(w)));
  const found: { id: number; start: number; end: number; len: number }[] = [];
  for (let i = 0; i < words.length; i++) {
    const starts = new Set<number>();
    for (const c of cands[i]) for (const k of idiomsByTok.get(c) ?? []) starts.add(k);
    if (SE.has(words[i])) for (const s of SE) for (const k of idiomsByTok.get(s) ?? []) starts.add(k);
    for (const k of starts) {
      const it = idioms[k];
      let j = i + 1, gaps = 0, ok = true;
      for (let t = 1; t < it.toks.length; t++) {
        while (j < words.length && !tokMatches(it.toks[t], cands[j]) && gaps < 1) { j++; gaps++; }
        if (j >= words.length || !tokMatches(it.toks[t], cands[j])) { ok = false; break; }
        j++;
      }
      if (ok) found.push({ id: it.id, start: i, end: j, len: it.toks.length });
    }
  }
  // Garde les plus longues, sans chevauchement.
  found.sort((a, b) => b.len - a.len || a.start - b.start);
  const used = new Set<number>();
  const keep = [];
  for (const f of found) {
    let free = true;
    for (let p = f.start; p < f.end; p++) if (used.has(p)) free = false;
    if (!free) continue;
    for (let p = f.start; p < f.end; p++) used.add(p);
    keep.push(f);
  }
  return keep.slice(0, 5).map((f) => {
    const e = all('SELECT * FROM entry WHERE id=?', [f.id])[0];
    return { ...entryOut(e), translations: transOf(f.id) };
  });
}

// ---------- Mots ----------
function entryOut(e: any) {
  return {
    id: e.id, lang: e.lang, word: e.word, pos: e.pos, gender: e.gender, ipa: e.ipa,
    glosses: JSON.parse(e.glosses || '[]') as string[], etym: e.etym as string | null,
  };
}

function transOf(id: number) {
  const out: Record<string, string[]> = {};
  for (const r of all('SELECT lang, word FROM trans WHERE entry_id=?', [id])) (out[r.lang] ??= []).length < 4 && out[r.lang].push(r.word);
  return out;
}

function cognates(e: any) {
  const targets = all('SELECT target FROM etym WHERE entry_id=?', [e.id]).map((r) => r.target as string);
  const self_ = `${norm(e.word)}#${e.lang}`;
  const res = new Map<string, any>();
  const add = (r: any, via: string) => {
    const k = `${r.lang}:${r.word}`;
    if (r.lang !== e.lang && !res.has(k) && res.size < 12) res.set(k, { lang: r.lang, word: r.word, gloss: JSON.parse(r.glosses || '[]')[0] ?? '', via });
  };
  // Mots de mes langues qui partagent une même racine (ex. latin fenestra).
  if (targets.length) {
    const q = targets.map(() => '?').join(',');
    for (const r of all(
      `SELECT DISTINCT e.lang, e.word, e.glosses, x.target FROM etym x JOIN entry e ON e.id=x.entry_id
       WHERE x.target IN (${q}) AND e.multi=0 LIMIT 60`, targets)) add(r, r.target);
  }
  // Mots qui citent celui-ci, et mots cités directement dans l'étymologie.
  for (const r of all(
    `SELECT e.lang, e.word, e.glosses FROM etym x JOIN entry e ON e.id=x.entry_id WHERE x.target=? AND e.multi=0 LIMIT 20`, [self_])) add(r, self_);
  for (const t of targets) {
    const [w, l] = t.split('#');
    if (LANG_SET.has(l)) for (const r of all('SELECT lang, word, glosses FROM entry WHERE lang=? AND key=? LIMIT 1', [l, w])) add(r, t);
  }
  return [...res.values()];
}

function lookup(lang: string, word: string) {
  const k = norm(word);
  const forms = all(
    'SELECT f.lemma, i.txt AS info FROM form f LEFT JOIN info i ON i.id=f.info WHERE f.lang=? AND f.key=? LIMIT 6', [lang, k],
  ).map((f) => ({ lemma: f.lemma, info: f.info ? String(f.info).split('~').join(f.lemma) : null }));
  const keys = [k, ...forms.map((f) => norm(f.lemma))];
  // Allemand : les noms prennent une majuscule, la clé est en minuscules donc ça marche aussi.
  const seen = new Set<number>();
  const entries: any[] = [];
  for (const key of keys) {
    for (const e of all('SELECT * FROM entry WHERE lang=? AND key=? LIMIT 3', [lang, key])) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      entries.push(e);
    }
  }
  const main = entries[0];
  let equivalents: Record<string, string[]> = {};
  let french: string[] = [];
  if (main) {
    if (lang === 'fr') equivalents = transOf(main.id);
    else {
      french = all(
        `SELECT DISTINCT e.word, e.id FROM trans t JOIN entry e ON e.id=t.entry_id WHERE t.lang=? AND t.word IN (?, ?) AND e.multi=0 LIMIT 4`,
        [lang, main.word, word]).map((r) => r.word);
      const fr = all(`SELECT e.id FROM trans t JOIN entry e ON e.id=t.entry_id WHERE t.lang=? AND t.word IN (?, ?) AND e.multi=0 LIMIT 1`, [lang, main.word, word])[0];
      if (fr) equivalents = transOf(fr.id);
    }
  }
  return {
    word, lang,
    forms: forms.map((f) => ({ lemma: f.lemma, info: f.info })),
    entries: entries.slice(0, 3).map(entryOut),
    cognates: main ? cognates(main) : [],
    equivalents, french,
  };
}

let ready: Promise<void> | null = null;
self.onmessage = async (ev: MessageEvent<any>) => {
  const m = ev.data;
  try {
    ready ??= open();
    await ready;
    if (m.type === 'init') post({ type: 'ready', id: m.id });
    else if (m.type === 'lookup') post({ type: 'reply', id: m.id, data: lookup(m.lang, m.word) });
    else if (m.type === 'idioms') post({ type: 'reply', id: m.id, data: findIdioms(m.text) });
  } catch (e) {
    ready = null;
    post({ type: 'error', id: m.id, message: String((e as Error)?.message ?? e) });
  }
};
