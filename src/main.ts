import './styles.css';
import { get, set } from 'idb-keyval';
import { LANGS, FLAG, NAME, type AnyLang, type LangCode } from './langs';
import {
  explainOnline, loadSettings, onlineAvailable, saveSettings, translateOnline, translateWithContext, hasAnyKey, verifyOnline, explainOrigin, askAboutWord, type QA,
  DEFAULT_MODEL, type Translations,
} from './gemini';
import { addSaved, allSaved, dueCount, findSaved, grade, isDue, loadSaved, MAX_BOX, onSavedChange, removeSaved, restoreSaved, updateSaved, type Dir, type SavedItem } from './saved';

// ---------- Workers ----------
const tr = new Worker(new URL('./translator.worker.ts', import.meta.url), { type: 'module' });
const dict = new Worker(new URL('./dict.worker.ts', import.meta.url), { type: 'module' });

let rpcId = 0;
const pending = new Map<number, { ok: (v: any) => void; ko: (e: Error) => void }>();
dict.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'progress') return setDictProgress(m.loaded, m.total);
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.type === 'error' ? p.ko(new Error(m.message)) : p.ok(m.data);
};
function dictCall<T = any>(msg: object): Promise<T> {
  const id = ++rpcId;
  return new Promise((ok, ko) => {
    pending.set(id, { ok, ko });
    dict.postMessage({ ...msg, id });
  });
}

// ---------- État ----------
interface Card { text: string; source: 'opus' | 'gemini' | 'corrige'; verdict?: { ok: boolean; probleme: string; correction: string } }
interface Current {
  fr: string; id: number; cards: Partial<Record<LangCode, Card>>; notes?: string;
  /** Traduction Gemini : en cours, réussie, échouée ou non tentée (hors ligne / sans clé). */
  online?: 'pending' | 'ok' | 'failed' | 'off';
  opusDone?: boolean;
  autoVerified?: boolean;
}
let current: Current | null = null;
/** Mode quiz : les traductions restent cachées jusqu'à ce qu'on touche la langue. */
let quiz = false;
const revealed = new Set<LangCode>();
let modelsReady = false;
let dictReady = false;
let dictError = '';

// ---------- DOM ----------
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const h = (tag: string, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

document.querySelector('#app')!.innerHTML = `
  <header>
    <h1>Babel-Oued</h1>
    <span id="net" class="net"></span>
    <button id="btn-settings" class="icon" aria-label="Réglages">⚙️</button>
  </header>
  <section id="setup" class="setup" hidden></section>
  <nav class="tabs" role="tablist">
    <button type="button" role="tab" data-tab="simple" aria-selected="true"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h9M8.5 3v2M11 5c-1 4-3.5 7-7 9M6.5 9c1.2 2 3 3.6 5 4.6"/><path d="M13 21l4-10 4 10M14.5 17.5h5"/></svg><span>Traduire</span></button>
    <button type="button" role="tab" data-tab="context" aria-selected="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/></svg><span>Contexte</span></button>
    <button type="button" role="tab" data-tab="origin" aria-selected="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21v-8M12 13c0-4-3-6-7-6 0 4 3 6 7 6zM12 11c0-4 3-7 7-7 0 4-3 7-7 7z"/></svg><span>Origine</span></button>
    <button type="button" role="tab" data-tab="carnet" aria-selected="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11"/><path d="M10 4v6l2-1.5 2 1.5V4"/></svg><span>Carnet</span><b id="due-badge" class="tab-badge" hidden></b></button>
  </nav>
  <section id="tab-origin" hidden>
    <form id="or-form">
      <textarea id="or-input" rows="2" placeholder="Colle une phrase ou une expression, dans n’importe laquelle de tes langues. Ex. : te he echado de menos"></textarea>
      <button id="or-go" type="submit">Décortiquer</button>
    </form>
    <p id="or-status" class="muted" hidden></p>
    <div id="or-result"></div>
  </section>
  <section id="tab-carnet" hidden>
    <div class="seg" id="cn-view">
      <button type="button" data-view="list" aria-pressed="true">Mes mots</button>
      <button type="button" data-view="review" aria-pressed="false">Réviser</button>
    </div>
    <div id="cn-langs" class="chips"></div>
    <div id="cn-list">
      <details id="cn-add" class="block add">
        <summary>＋ Ajouter un mot ou une expression</summary>
        <form id="cn-add-form">
          <select id="cn-add-lang">${LANGS.map((l) => `<option value="${l.code}">${l.flag} ${l.name}</option>`).join('')}</select>
          <input id="cn-add-text" placeholder="Mot ou expression" autocomplete="off">
          <input id="cn-add-fr" placeholder="Sens en français" lang="fr" autocomplete="off">
          <button type="submit">Enregistrer</button>
        </form>
      </details>
      <div id="cn-items"></div>
    </div>
    <div id="cn-review" hidden>
      <div class="seg small" id="cn-dir">
        <button type="button" data-dir="theme" aria-pressed="true">Thème · 🇫🇷 → langue</button>
        <button type="button" data-dir="version" aria-pressed="false">Version · langue → 🇫🇷</button>
      </div>
      <div id="rv"></div>
    </div>
  </section>
  <section id="tab-context" hidden>
    <form id="ctx-form">
      <textarea id="ctx-input" rows="3" lang="fr" placeholder="Décris la situation et ce que tu veux dire. Ex. : je suis dans un magasin, je veux dire que je jette juste un coup d’œil."></textarea>
      <button id="ctx-go" type="submit">Comment le dire ?</button>
    </form>
    <p id="ctx-status" class="muted" hidden></p>
    <div id="ctx-result"></div>
  </section>
  <div id="tab-simple">
  <form id="form">
    <textarea id="input" rows="3" placeholder="Écris une phrase en français…" lang="fr"></textarea>
    <div class="form-row">
      <label class="switch"><input id="quiz-toggle" type="checkbox"><span>Mode quiz</span></label>
      <button id="go" type="submit">Traduire</button>
    </div>
  </form>
  <div id="source" class="source" hidden></div>
  <div id="idioms"></div>
  <div id="cards"></div>
  <div id="actions" class="actions" hidden>
    <button id="verify" class="secondary">🔍 Vérifier en ligne</button>
  </div>
  <p id="warning" class="warning" hidden></p>
  <section id="history"></section>
  </div>
  <div id="sheet" class="sheet" hidden><div class="sheet-body"><button class="close" aria-label="Fermer">✕</button><div id="sheet-content"></div></div></div>
  <dialog id="settings">
    <form method="dialog" class="settings">
      <h2>Réglages</h2>
      <label>Clé API Gemini (gratuite)
        <input id="key" type="password" autocomplete="off" placeholder="AIza…">
      </label>
      <p class="hint">À créer sur <b>aistudio.google.com/apikey</b> avec ton compte Google. Elle reste uniquement sur ce téléphone.
      Sur l’offre gratuite, Google peut utiliser les phrases envoyées pour améliorer ses modèles.</p>
      <label>Modèle Gemini <input id="model" placeholder="${DEFAULT_MODEL}"></label>
      <h3>Secours si Gemini est saturé (facultatif)</h3>
      <label>Clé API Mistral
        <input id="mistral-key" type="password" autocomplete="off">
      </label>
      <p class="hint">Sur <b>console.mistral.ai</b>. Depuis fin 2026, les nouveaux comptes gratuits n’ont plus de clé API : il faut des crédits payants. Facultatif.</p>
      <label>Clé API Groq (gratuite)
        <input id="groq-key" type="password" autocomplete="off" placeholder="gsk_…">
      </label>
      <p class="hint">Sur <b>console.groq.com/keys</b>, sans carte bancaire.</p>
      <label>Clé API OpenRouter (gratuite)
        <input id="openrouter-key" type="password" autocomplete="off" placeholder="sk-or-…">
      </label>
      <p class="hint">Sur <b>openrouter.ai/keys</b>. Modèles gratuits, environ 50 requêtes par jour : utilisée en dernier recours.</p>
      <label>Thème
        <select id="theme"><option value="light">Clair</option><option value="dark">Sombre</option><option value="auto">Comme le téléphone</option></select>
      </label>
      <label class="check"><input id="autoverify" type="checkbox"> Vérifier en ligne automatiquement les traductions hors ligne</label>
      <div class="row"><button value="cancel" class="secondary">Annuler</button><button id="save" value="ok">Enregistrer</button></div>
    </form>
  </dialog>
`;

// ---------- Thème (clair par défaut) ----------
type Theme = 'light' | 'dark' | 'auto';
function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0d1016' : '#f4f6f9');
}
const savedTheme = (localStorage.getItem('theme') as Theme | null) ?? 'light';
applyTheme(savedTheme);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme((localStorage.getItem('theme') as Theme | null) ?? 'light'));

// ---------- Réseau ----------
function refreshNet() {
  const el = $('#net');
  if (!navigator.onLine) el.textContent = '● Hors ligne';
  else if (!hasAnyKey()) el.textContent = '● En ligne (sans clé)';
  else el.textContent = '● En ligne';
  el.dataset.on = String(onlineAvailable());
  $('#verify').toggleAttribute('disabled', !onlineAvailable());
  $('#ctx-go').toggleAttribute('disabled', !onlineAvailable() || ctxBusy);
  $('#or-go').toggleAttribute('disabled', !onlineAvailable() || orBusy);
}
addEventListener('online', refreshNet);
addEventListener('offline', refreshNet);

// ---------- Installation (premier lancement) ----------
const progress = new Map<string, { loaded: number; total: number }>();
let dictProg = { loaded: 0, total: 0 };
function renderSetup() {
  const el = $('#setup');
  if (modelsReady && dictReady) { el.hidden = true; return; }
  el.hidden = false;
  let loaded = 0, total = 0;
  for (const p of progress.values()) { loaded += p.loaded; total += p.total; }
  const mb = (n: number) => (n / 1e6).toFixed(0);
  // Bandeau discret : une ligne par élément encore en préparation (une seule fois, au premier lancement).
  const pct = (a: number, b: number) => (b ? Math.min(100, Math.round((100 * a) / b)) : 0);
  const row = (label: string, value: number, detail: string) =>
    `<div class="setup-row"><span>${label}</span><progress max="100" value="${value}"></progress><span class="setup-val">${detail}</span></div>`;
  let html = '';
  if (!modelsReady) html += row('Modèles', pct(loaded, total), total ? `${mb(loaded)}/${mb(total)} Mo` : '…');
  if (dictError) html += `<p class="setup-err">Dictionnaire indisponible : ${dictError}</p>`;
  else if (!dictReady) {
    const p = pct(dictProg.loaded, dictProg.total);
    html += row('Dictionnaire', p, dictProg.total && p >= 100 ? 'finalisation…' : dictProg.total ? `${p} %` : dictProg.loaded ? `${mb(dictProg.loaded)} Mo` : 'ouverture…');
  }
  el.innerHTML = `<p class="setup-title">Préparation hors ligne, une seule fois (Wi-Fi conseillé)</p>${html}`;
}
function setDictProgress(loaded: number, total: number) {
  dictProg = { loaded, total };
  renderSetup();
}

tr.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'progress') { progress.set(m.file + m.lang, { loaded: m.loaded, total: m.total }); renderSetup(); }
  else if (m.type === 'ready') { modelsReady = true; renderSetup(); }
  else if (m.type === 'result' && current && m.id === current.id) {
    const c = current.cards[m.lang as LangCode];
    if (!c || c.source === 'opus') { current.cards[m.lang as LangCode] = { text: m.text, source: 'opus' }; renderCards(); }
  } else if (m.type === 'done' && current && m.id === current.id) {
    $('#go').removeAttribute('disabled');
    current.opusDone = true;
    maybeAutoVerify();
  } else if (m.type === 'error') {
    $('#go').removeAttribute('disabled');
    toast(`Traduction hors ligne : ${m.message}`);
  }
};

// ---------- Rendu ----------
function clickable(text: string, lang: AnyLang, original: string): HTMLElement {
  const p = h('p', 'text');
  p.lang = lang;
  const seg = new Intl.Segmenter(lang, { granularity: 'word' });
  for (const s of seg.segment(text)) {
    if (s.isWordLike) {
      const w = h('span', 'w', s.segment);
      w.onclick = () => openWord(s.segment, lang, text, original);
      p.append(w);
    } else p.append(document.createTextNode(s.segment));
  }
  return p;
}

function renderCards() {
  if (!current) return;
  const root = $('#cards');
  root.innerHTML = '';
  const anyOpus = LANGS.some((l) => current!.cards[l.code]?.source === 'opus');
  for (const l of LANGS) {
    const c = current.cards[l.code];
    const card = h('article', 'card');
    card.dataset.lang = l.code;
    const head = h('div', 'card-head');
    head.append(h('span', 'flag', l.flag), h('span', 'lname', l.name));
    if (quiz && !revealed.has(l.code)) {
      card.classList.add('quiz-hidden');
      card.append(head, h('p', 'text muted', c ? '👆 Devine, puis touche pour voir' : 'Traduction…'));
      if (c) card.onclick = () => { revealed.add(l.code); renderCards(); };
      root.append(card);
      continue;
    }
    if (c) {
      const badge = h('span', `badge ${c.source}`, c.source === 'opus' ? 'hors ligne · littéral' : c.source === 'gemini' ? 'idiomatique' : 'corrigé');
      head.append(badge, saveBtn(l.code, c.text, current.fr), originLink(c.text));
    }
    card.append(head);
    if (!c) card.append(h('p', 'text muted', 'Traduction…'));
    else {
      card.append(clickable(c.text, l.code, current.fr));
      if (c.source === 'opus' && l.pivot) card.append(h('p', 'note', 'Traduit via l’espagnol (pas de modèle direct français → italien).'));
      if (c.verdict) {
        const v = h('div', `verdict ${c.verdict.ok ? 'ok' : 'ko'}`);
        v.append(h('span', '', c.verdict.ok ? '✅ Correct' : `⚠️ ${c.verdict.probleme}`));
        if (!c.verdict.ok && c.verdict.correction && c.verdict.correction !== c.text) {
          v.append(h('p', 'fix', c.verdict.correction));
          const b = h('button', 'secondary small', 'Utiliser cette version');
          b.onclick = () => { current!.cards[l.code] = { text: c.verdict!.correction, source: 'corrige', verdict: { ...c.verdict!, ok: true, probleme: '' } }; renderCards(); };
          v.append(b);
        }
        card.append(v);
      }
    }
    root.append(card);
  }
  // La vérification n'a d'intérêt que pour les traductions hors ligne (littérales).
  $('#actions').hidden = !anyOpus || quiz;
  const warn = $('#warning');
  warn.hidden = !anyOpus;
  warn.textContent = '⚠️ Traduction automatique hors ligne : les expressions idiomatiques peuvent être traduites mot à mot. Fie-toi à l’encadré 💡 et, si tu as du réseau, au bouton « Vérifier ».';
  if (quiz) warn.hidden = true;
  if (current.notes && !quiz) { const n = h('p', 'notes', `💬 ${current.notes}`); root.prepend(n); }
}

function renderIdioms(list: any[]) {
  const root = $('#idioms');
  root.innerHTML = '';
  for (const it of list) {
    const box = h('aside', 'idiom');
    box.append(h('div', 'idiom-title', `💡 « ${it.word} »`), h('div', 'pos', it.pos));
    if (it.glosses[0]) box.append(h('p', '', it.glosses[0]));
    const ul = h('ul', 'equiv');
    for (const l of LANGS) {
      const ws = it.translations[l.code];
      if (ws?.length) ul.append(h('li', '', `${l.flag} ${ws.join(', ')}`));
    }
    if (ul.childElementCount) box.append(ul);
    else box.append(h('p', 'muted', 'Pas d’équivalent enregistré dans le Wiktionnaire.'));
    if (it.etym) { const d = h('details'); d.append(h('summary', '', 'Origine'), h('p', '', it.etym)); box.append(d); }
    root.append(box);
  }
}

// ---------- Traduire ----------
async function translate(fr: string) {
  fr = fr.trim();
  if (!fr) return;
  const id = Date.now();
  current = { fr, id, cards: {} };
  revealed.clear();
  $('#go').setAttribute('disabled', '');
  const src = $('#source');
  src.hidden = false;
  src.innerHTML = '';
  src.append(h('span', 'flag', FLAG.fr), clickable(fr, 'fr', fr));
  renderCards();
  $('#idioms').innerHTML = '';
  tr.postMessage({ type: 'translate', id, text: fr });
  dictCall({ type: 'idioms', text: fr }).then(renderIdioms).catch(() => {});
  if (onlineAvailable()) {
    current.online = 'pending';
    translateOnline(fr).then((t) => {
      if (current?.id !== id) return;
      current.online = 'ok';
      for (const l of LANGS) if (t[l.code]) current.cards[l.code] = { text: t[l.code], source: 'gemini' };
      current.notes = t.notes || undefined;
      renderCards();
      saveHistory();
    }).catch((e) => {
      if (current?.id !== id) return;
      current.online = 'failed';
      toast(`${e.message} Les traductions hors ligne seront vérifiées dès que possible.`);
      maybeAutoVerify();
    });
  } else current.online = 'off';
}

/** Si Gemini n'a pas pu traduire, on fait au moins relire la traduction hors ligne. */
function maybeAutoVerify() {
  if (!current || current.autoVerified || !current.opusDone || current.online !== 'failed') return;
  if (!onlineAvailable() || !loadSettings().autoVerify) return;
  current.autoVerified = true;
  verify();
}

async function verify() {
  if (!current) return;
  const btn = $('#verify');
  btn.setAttribute('disabled', '');
  btn.textContent = 'Vérification…';
  try {
    const texts: Partial<Translations> = {};
    for (const l of LANGS) texts[l.code] = current.cards[l.code]?.text;
    const id = current.id;
    const r = await verifyOnline(current.fr, texts);
    if (current?.id !== id) return;
    for (const v of r.verdicts) {
      const c = current.cards[v.lang];
      if (c) c.verdict = { ok: v.ok, probleme: v.probleme, correction: v.correction };
    }
    current.notes = r.resume || current.notes;
    renderCards();
  } catch (e) {
    toast((e as Error).message);
  } finally {
    btn.textContent = '🔍 Vérifier en ligne';
    refreshNet();
  }
}

// ---------- Explication d'un mot ----------
async function openWord(word: string, lang: AnyLang, sentence: string, original: string) {
  const sheet = $('#sheet');
  const box = $('#sheet-content');
  sheet.hidden = false;
  box.innerHTML = '';
  const title = h('div', 'sheet-title');
  title.append(h('h2', '', `${FLAG[lang]} ${word}`));
  box.append(title);
  const pre: SavePrefill = { word, sentence };
  if (lang !== 'fr') { const s = saveWordUI(lang, pre); title.append(s.button); box.append(s.form); }
  // L'explication en contexte (Gemini) passe en premier ; le dictionnaire, sous elle.
  const ctx = h('section', 'in-context');
  box.append(ctx);
  const off = h('section', 'offline');
  off.append(h('p', 'muted', 'Recherche dans le dictionnaire…'));
  box.append(off);
  const on = h('section', 'online');
  box.append(on);
  const lookup = dictCall({ type: 'lookup', lang, word });
  // Gemini part tout de suite : il ne doit pas attendre un dictionnaire encore en installation.
  if (onlineAvailable()) {
    const explained = explainInSheet(word, lang, sentence, original, lookup, ctx, on);
    explained.then((x) => { if (x) Object.assign(pre, { lemma: x.lemme, groupe: x.groupe, sensMot: x.sens_mot, sensGroupe: x.sens_groupe }); });
    box.append(followUp(word, lang, sentence, original, explained));
  } else on.append(h('p', 'muted', navigator.onLine ? 'Ajoute une clé d’IA (Gemini, Mistral, Groq ou OpenRouter) dans les réglages pour l’explication grammaticale détaillée.' : 'Explication détaillée disponible quand tu seras en ligne.'));

  try {
    const d = await lookup;
    if (d.french?.length) pre.dictFr = d.french.slice(0, 3).join(', ');
    off.innerHTML = '';
    if (d.forms.length) {
      const f = h('div', 'block');
      f.append(h('h3', '', 'Forme'));
      for (const x of d.forms) f.append(h('p', '', `${x.info ? x.info : 'Forme de'} → ${x.lemma}`));
      off.append(f);
    }
    for (const e of d.entries) {
      const b = h('div', 'block');
      b.append(h('h3', '', `${e.word} · ${e.pos}${e.gender ? ` (${e.gender.replace('masculine', 'masc.').replace('feminine', 'fém.').replace('neuter', 'neutre')})` : ''}${e.ipa ? `  ${e.ipa}` : ''}`));
      const ol = h('ol');
      for (const g of e.glosses) ol.append(h('li', '', g));
      b.append(ol);
      if (e.etym) b.append(h('p', 'etym', `🌱 ${e.etym}`));
      off.append(b);
    }
    if (d.french.length) off.append(h('p', '', `${FLAG.fr} ${d.french.join(', ')}`));
    const eq = Object.entries(d.equivalents as Record<string, string[]>).filter(([l]) => l !== lang);
    if (eq.length) {
      const b = h('div', 'block');
      b.append(h('h3', '', 'Dans tes autres langues'));
      for (const [l, ws] of eq) b.append(h('p', '', `${FLAG[l as AnyLang]} ${ws.join(', ')}`));
      off.append(b);
    }
    if (d.cognates.length) {
      const b = h('div', 'block');
      b.append(h('h3', '', 'Même racine'));
      for (const c of d.cognates) {
        const p = h('p');
        p.append(h('b', '', `${FLAG[c.lang as AnyLang]} ${c.word}`), document.createTextNode(c.gloss ? ` — ${c.gloss}` : ''));
        b.append(p);
      }
      off.append(b);
    }
    if (!d.forms.length && !d.entries.length) off.append(h('p', 'muted', 'Mot absent du dictionnaire hors ligne.'));
  } catch (e) {
    off.innerHTML = '';
    off.append(h('p', 'muted', `Dictionnaire indisponible : ${(e as Error).message}`));
  }

}

/** Données du dictionnaire transmises à Gemini pour fiabiliser l'explication. */
function dictHint(d: any): string {
  let hint = d.forms.map((x: any) => `Forme : ${x.info ?? ''} (lemme ${x.lemma})`).join('\n') + '\n';
  for (const e of d.entries) {
    hint += `${e.word} (${e.pos}) : ${e.glosses.join(' / ')}\n`;
    if (e.etym) hint += `Étymologie de ${e.word} : ${e.etym}\n`;
  }
  return hint;
}

async function explainInSheet(word: string, lang: AnyLang, sentence: string, original: string, lookup: Promise<any>, ctx: HTMLElement, on: HTMLElement) {
  ctx.append(h('p', 'muted', 'Explication dans cette phrase en cours…'));
  const d = await Promise.race([lookup.catch(() => null), new Promise((r) => setTimeout(() => r(null), 1500))]);
  const hint = d ? dictHint(d) : '';
  try {
    const x = await explainOnline(word, lang, sentence, original, hint.slice(0, 2500));
    ctx.innerHTML = '';
    const c = h('div', 'block context');
    c.append(h('h3', '', `Dans cette phrase · ${x.groupe || word}`), h('p', '', x.construction));
    if (x.piege) c.append(h('p', 'piege', `⚠️ ${x.piege}`));
    ctx.append(c);
    on.append(h('h3', '', `Explication · ${x.lemme}`));
    on.append(h('p', 'nature', x.nature));
    on.append(h('p', '', `🧩 ${x.role}`));
    on.append(h('p', 'etym', `🌱 ${x.racine}`));
    if (x.liens?.length) {
      const ul = h('ul', 'equiv');
      for (const li of x.liens) ul.append(h('li', '', `${FLAG[li.lang as AnyLang] ?? li.lang} ${li.mot} — ${li.note}`));
      on.append(ul);
    }
    on.append(h('p', 'note', 'Explication générée par l’IA : peut contenir des erreurs.'));
    return x;
  } catch (e) {
    ctx.innerHTML = '';
    ctx.append(h('p', 'muted', `Explication dans cette phrase indisponible : ${(e as Error).message}`));
    return null;
  }
}

/** Fil de questions libres sur le mot, en bas de la fiche. */
function followUp(word: string, lang: AnyLang, sentence: string, original: string, explained: Promise<any>) {
  const sec = h('section', 'qa');
  sec.append(h('h3', '', '💬 Une question sur ce mot ?'));
  const list = h('div', 'qa-list');
  const form = h('form', 'qa-form') as HTMLFormElement;
  const input = h('input') as HTMLInputElement;
  input.placeholder = 'Ex. : pourquoi pas « avere » ici ?';
  input.lang = 'fr';
  const send = h('button', '', 'Demander') as HTMLButtonElement;
  send.type = 'submit';
  form.append(input, send);
  sec.append(list, form);
  const thread: QA[] = [];
  form.onsubmit = async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q || send.disabled) return;
    input.value = '';
    send.disabled = true;
    list.append(h('p', 'qa-q', q));
    const a = h('p', 'qa-a muted', 'Réflexion…');
    list.append(a);
    try {
      const x = await explained;
      const summary = x ? [x.groupe && `Dans la phrase : ${x.groupe}. ${x.construction}`, x.piege, `${x.lemme} : ${x.nature}. ${x.role}`].filter(Boolean).join('\n') : '';
      const r = await askAboutWord(word, lang, sentence, original, summary, thread, q);
      thread.push({ q, a: r.reponse });
      a.className = 'qa-a';
      a.textContent = r.reponse;
    } catch (err) {
      a.textContent = (err as Error).message;
    } finally {
      send.disabled = false;
      a.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  };
  return sec;
}
$('#sheet').onclick = (e) => {
  if (e.target === $('#sheet') || (e.target as HTMLElement).classList.contains('close')) $('#sheet').hidden = true;
};

// ---------- Historique ----------
async function saveHistory() {
  if (!current) return;
  const list: any[] = (await get('history').catch(() => [])) ?? [];
  const entry = { fr: current.fr, cards: current.cards, notes: current.notes };
  const next = [entry, ...list.filter((x) => x.fr !== current!.fr)].slice(0, 30);
  await set('history', next).catch(() => {});
  renderHistory(next);
}
function renderHistory(list: any[]) {
  const root = $('#history');
  root.innerHTML = '';
  if (!list.length) return;
  root.append(h('h2', '', 'Historique'));
  for (const it of list) {
    const b = h('button', 'hist', it.fr);
    b.onclick = () => {
      current = { fr: it.fr, id: Date.now(), cards: it.cards, notes: it.notes };
      revealed.clear();
      ($('#input') as HTMLTextAreaElement).value = it.fr;
      const src = $('#source');
      src.hidden = false;
      src.innerHTML = '';
      src.append(h('span', 'flag', FLAG.fr), clickable(it.fr, 'fr', it.fr));
      renderCards();
      dictCall({ type: 'idioms', text: it.fr }).then(renderIdioms).catch(() => {});
      scrollTo({ top: 0, behavior: 'smooth' });
    };
    root.append(b);
  }
}

// ---------- Réglages ----------
$('#btn-settings').onclick = () => {
  const s = loadSettings();
  ($('#key') as HTMLInputElement).value = s.geminiKey;
  ($('#mistral-key') as HTMLInputElement).value = s.mistralKey;
  ($('#groq-key') as HTMLInputElement).value = s.groqKey;
  ($('#openrouter-key') as HTMLInputElement).value = s.openrouterKey;
  ($('#model') as HTMLInputElement).value = s.model === DEFAULT_MODEL ? '' : s.model;
  ($('#autoverify') as HTMLInputElement).checked = s.autoVerify;
  ($('#theme') as HTMLSelectElement).value = localStorage.getItem('theme') ?? 'light';
  ($('#settings') as HTMLDialogElement).showModal();
};
$('#save').onclick = () => {
  saveSettings({
    geminiKey: ($('#key') as HTMLInputElement).value.trim(),
    mistralKey: ($('#mistral-key') as HTMLInputElement).value.trim(),
    groqKey: ($('#groq-key') as HTMLInputElement).value.trim(),
    openrouterKey: ($('#openrouter-key') as HTMLInputElement).value.trim(),
    model: ($('#model') as HTMLInputElement).value.trim() || DEFAULT_MODEL,
    autoVerify: ($('#autoverify') as HTMLInputElement).checked,
  });
  const theme = ($('#theme') as HTMLSelectElement).value as Theme;
  localStorage.setItem('theme', theme);
  applyTheme(theme);
  refreshNet();
};

// ---------- Onglets ----------
function showTab(tab: string) {
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  $('#tab-simple').hidden = tab !== 'simple';
  $('#tab-carnet').hidden = tab !== 'carnet';
  if (tab === 'carnet') renderCarnet();
  $('#tab-context').hidden = tab !== 'context';
  $('#tab-origin').hidden = tab !== 'origin';
  localStorage.setItem('tab', tab);
}
for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs [data-tab]')) b.onclick = () => showTab(b.dataset.tab!);

// ---------- Mode quiz (interrupteur dans Traduire) ----------
/** Les traductions restent cachées jusqu'à ce qu'on touche la langue. */
function setQuiz(on: boolean) {
  quiz = on;
  ($('#quiz-toggle') as HTMLInputElement).checked = on;
  localStorage.setItem('quiz', on ? '1' : '');
  $('#idioms').hidden = quiz;
  ($('#input') as HTMLTextAreaElement).placeholder = quiz ? 'Écris une phrase en français, devine sa traduction…' : 'Écris une phrase en français…';
  ($('#go') as HTMLButtonElement).textContent = quiz ? 'Lancer le quiz' : 'Traduire';
  if (current) { revealed.clear(); renderCards(); }
}
($('#quiz-toggle') as HTMLInputElement).onchange = (e) => setQuiz((e.target as HTMLInputElement).checked);

// ---------- Avec contexte ----------
let ctxBusy = false;
async function translateContext(request: string) {
  request = request.trim();
  if (!request) return;
  const status = $('#ctx-status');
  const out = $('#ctx-result');
  if (!onlineAvailable()) {
    status.hidden = false;
    status.textContent = navigator.onLine ? 'Ajoute une clé d’IA (Gemini, Mistral, Groq ou OpenRouter) dans les réglages pour utiliser cet onglet.' : 'Cet onglet a besoin du réseau.';
    return;
  }
  ctxBusy = true;
  refreshNet();
  status.hidden = false;
  status.textContent = 'Je cherche la formulation naturelle…';
  out.innerHTML = '';
  try {
    const r = await translateWithContext(request);
    status.hidden = true;
    const src = h('div', 'source');
    src.append(h('span', 'flag', FLAG.fr), clickable(r.phrase_fr, 'fr', r.phrase_fr));
    out.append(src);
    for (const l of LANGS) {
      const t = r.traductions.find((x) => x.lang === l.code);
      if (!t) continue;
      const card = h('article', 'card');
      card.dataset.lang = l.code;
      const head = h('div', 'card-head');
      head.append(h('span', 'flag', l.flag), h('span', 'lname', l.name), h('span', 'badge gemini', 'en situation'), saveBtn(l.code, t.texte, r.phrase_fr), originLink(t.texte));
      card.append(head, clickable(t.texte, l.code, r.phrase_fr));
      if (t.translit) card.append(h('p', 'note', t.translit));
      if (t.note) card.append(h('p', 'note', `💬 ${t.note}`));
      out.append(card);
    }
    if (r.conseil) out.append(h('p', 'notes', `🧭 ${r.conseil}`));
    out.append(h('p', 'note', 'Formulations proposées par l’IA : peuvent contenir des erreurs. Touche un mot pour son explication.'));
  } catch (e) {
    status.textContent = (e as Error).message;
  } finally {
    ctxBusy = false;
    refreshNet();
  }
}
$('#ctx-form').onsubmit = (e) => { e.preventDefault(); translateContext(($('#ctx-input') as HTMLTextAreaElement).value); };

// ---------- D'où ça vient ? ----------
function originLink(text: string) {
  const b = h('button', 'icon origin-link', '🧬');
  b.title = 'D’où vient cette phrase ?';
  b.setAttribute('aria-label', 'D’où vient cette phrase ?');
  b.onclick = () => {
    ($('#or-input') as HTMLTextAreaElement).value = text;
    showTab('origin');
    scrollTo({ top: 0 });
    explainPhrase(text);
  };
  return b;
}

let orBusy = false;
async function explainPhrase(phrase: string) {
  phrase = phrase.trim();
  if (!phrase) return;
  const status = $('#or-status');
  const out = $('#or-result');
  out.innerHTML = '';
  status.hidden = false;
  if (!onlineAvailable()) {
    status.textContent = navigator.onLine ? 'Ajoute une clé d’IA (Gemini, Mistral, Groq ou OpenRouter) dans les réglages pour utiliser cet onglet.' : 'Cet onglet a besoin du réseau.';
    return;
  }
  orBusy = true;
  refreshNet();
  status.textContent = 'Je décortique la phrase…';
  try {
    const r = await explainOrigin(phrase);
    status.hidden = true;
    const lang = (r.lang in FLAG ? r.lang : 'fr') as AnyLang;
    const src = h('div', 'source');
    src.append(h('span', 'flag', FLAG[lang]), clickable(phrase, lang, r.sens || phrase));
    if (lang !== 'fr') src.append(saveBtn(lang, phrase, r.sens));
    out.append(src, h('p', 'or-sens', `= ${r.sens}`));
    const wbw = h('div', 'block');
    wbw.append(h('h3', '', 'Mot à mot'));
    const tbl = h('table', 'wbw');
    for (const m of r.mot_a_mot) {
      const tr = h('tr');
      tr.append(h('td', 'wbw-mot', m.mot), h('td', '', m.litteral), h('td', 'muted', m.role));
      tbl.append(tr);
    }
    wbw.append(tbl, h('p', 'or-lit', `→ « ${r.litteral} »`));
    out.append(wbw);
    const lg = h('div', 'block context');
    lg.append(h('h3', '', 'Pourquoi ça veut dire ça'), h('p', '', r.logique));
    out.append(lg);
    if (r.origine) {
      const o = h('div', 'block');
      o.append(h('h3', '', 'Origine'), h('p', 'etym', `🌱 ${r.origine}`));
      out.append(o);
    }
    if (r.equivalents?.length) {
      const e = h('div', 'block');
      e.append(h('h3', '', 'Dans tes autres langues'));
      const ul = h('ul', 'equiv');
      for (const q of r.equivalents) ul.append(h('li', '', `${FLAG[q.lang as AnyLang] ?? q.lang} ${q.texte}`));
      e.append(ul);
      out.append(e);
    }
    out.append(h('p', 'note', 'Explication générée par l’IA : peut contenir des erreurs. Touche un mot pour son explication détaillée.'));
  } catch (e) {
    status.textContent = (e as Error).message;
  } finally {
    orBusy = false;
    refreshNet();
  }
}
$('#or-form').onsubmit = (e) => { e.preventDefault(); explainPhrase(($('#or-input') as HTMLTextAreaElement).value); };

// ---------- Carnet : enregistrer ----------
const LANG_BY_CODE = Object.fromEntries(LANGS.map((l) => [l.code, l])) as Record<LangCode, (typeof LANGS)[number]>;

/** Étoile ☆/★ : ajoute ou retire une traduction du carnet. */
function saveBtn(lang: LangCode, text: string, fr: string) {
  const b = h('button', 'icon star');
  b.dataset.lang = lang;
  b.dataset.text = text;
  b.onclick = async (e) => {
    e.stopPropagation();
    const it = findSaved(lang, text);
    if (it) {
      await removeSaved(it.id);
      toast('Retiré du carnet.', { label: 'Annuler', run: () => restoreSaved(it) });
    } else {
      await addSaved(lang, text, fr);
      toast(`${FLAG[lang]} Ajouté au carnet.`);
    }
  };
  paintStar(b);
  return b;
}
function paintStar(b: HTMLElement) {
  const on = !!findSaved(b.dataset.lang as LangCode, b.dataset.text!);
  b.textContent = on ? '★' : '☆';
  b.classList.toggle('on', on);
  b.setAttribute('aria-label', on ? 'Retirer du carnet' : 'Ajouter au carnet');
  b.title = b.getAttribute('aria-label')!;
}
function refreshStars() { for (const b of document.querySelectorAll<HTMLElement>('.star')) paintStar(b); }

interface SavePrefill { word: string; sentence: string; lemma?: string; groupe?: string; sensMot?: string; sensGroupe?: string; dictFr?: string }
/** Dans la fiche d'un mot : enregistrer le mot, sa forme de dictionnaire ou l'expression entière. */
function saveWordUI(lang: LangCode, pre: SavePrefill) {
  const button = h('button', 'secondary small save-word') as HTMLButtonElement;
  const paint = () => { button.textContent = findSaved(lang, pre.word) || (pre.lemma && findSaved(lang, pre.lemma)) ? '★ Dans le carnet' : '☆ Enregistrer'; };
  paint();
  const form = h('form', 'block save-form') as HTMLFormElement;
  form.hidden = true;
  button.onclick = () => {
    form.hidden = !form.hidden;
    if (form.hidden) return;
    form.innerHTML = '';
    const choices: { label: string; text: string; fr: string }[] = [];
    const push = (label: string, text?: string, fr?: string) => {
      if (text && !choices.some((c) => c.text.toLocaleLowerCase() === text.toLocaleLowerCase())) choices.push({ label, text, fr: fr ?? '' });
    };
    push('Dictionnaire', pre.lemma, pre.sensMot || pre.dictFr);
    push('Tel quel', pre.word, pre.sensMot || pre.dictFr);
    if (pre.groupe && pre.groupe.trim().includes(' ')) push('Expression', pre.groupe, pre.sensGroupe);
    const text = h('input') as HTMLInputElement;
    text.lang = lang;
    text.placeholder = 'Mot ou expression';
    const fr = h('input') as HTMLInputElement;
    fr.lang = 'fr';
    fr.placeholder = 'Sens en français';
    const pick = (c: (typeof choices)[number], chip?: HTMLElement) => {
      text.value = c.text;
      fr.value = c.fr;
      for (const x of form.querySelectorAll('.chip')) x.setAttribute('aria-pressed', String(x === chip));
    };
    if (choices.length > 1) {
      const row = h('div', 'chips');
      for (const c of choices) {
        const chip = h('button', 'chip');
        chip.setAttribute('type', 'button');
        chip.append(h('small', '', c.label), document.createTextNode(` ${c.text}`));
        chip.onclick = () => pick(c, chip);
        row.append(chip);
      }
      form.append(row);
      pick(choices[0], row.firstElementChild as HTMLElement);
    } else if (choices[0]) pick(choices[0]);
    if (!pre.lemma && onlineAvailable()) form.append(h('p', 'note', 'L’explication en cours proposera aussi la forme de dictionnaire et l’expression.'));
    const ok = h('button', '', 'Ajouter au carnet') as HTMLButtonElement;
    ok.type = 'submit';
    form.append(text, fr, ok);
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (!text.value.trim()) return text.focus();
      if (!fr.value.trim()) { fr.focus(); return toast('Indique le sens en français, pour pouvoir t’interroger dessus.'); }
      await addSaved(lang, text.value, fr.value);
      form.hidden = true;
      paint();
      button.textContent = '★ Dans le carnet';
      toast(`${FLAG[lang]} « ${text.value.trim()} » ajouté au carnet.`);
    };
    fr.focus({ preventScroll: true });
  };
  return { button, form };
}

// ---------- Carnet : liste et révision ----------
let cnView: 'list' | 'review' = 'list';
let cnLang: LangCode | 'all' = (localStorage.getItem('cnLang') as LangCode | 'all' | null) ?? 'all';
let cnDir: Dir = (localStorage.getItem('cnDir') as Dir | null) ?? 'theme';
interface Review { queue: SavedItem[]; dir: Dir; free: boolean; total: number; done: number; firstOk: number; missed: Set<string>; flipped: boolean }
let rv: Review | null = null;

function updateDueBadge() {
  const n = dueCount();
  const b = $('#due-badge');
  b.hidden = n === 0;
  b.textContent = n > 99 ? '99+' : String(n);
  b.title = `${n} à réviser`;
}

function pool() { return allSaved().filter((x) => cnLang === 'all' || x.lang === cnLang); }

function renderCarnet() {
  const items = allSaved();
  if (cnLang !== 'all' && !items.some((x) => x.lang === cnLang)) cnLang = 'all';
  for (const b of document.querySelectorAll<HTMLButtonElement>('#cn-view [data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === cnView));
  for (const b of document.querySelectorAll<HTMLButtonElement>('#cn-dir [data-dir]')) b.setAttribute('aria-pressed', String(b.dataset.dir === cnDir));
  // Filtre par langue, commun à la liste et à la révision.
  const chips = $('#cn-langs');
  chips.innerHTML = '';
  const used = LANGS.filter((l) => items.some((x) => x.lang === l.code));
  chips.hidden = used.length < 2;
  const chip = (value: LangCode | 'all', label: string, n: number) => {
    const c = h('button', 'chip', `${label} ${n}`);
    c.setAttribute('aria-pressed', String(cnLang === value));
    c.onclick = () => { cnLang = value; localStorage.setItem('cnLang', value); rv = null; renderCarnet(); };
    chips.append(c);
  };
  if (cnLang !== 'all') ($('#cn-add-lang') as HTMLSelectElement).value = cnLang;
  chip('all', 'Toutes', items.length);
  for (const l of used) chip(l.code, l.flag, items.filter((x) => x.lang === l.code).length);
  $('#cn-list').hidden = cnView !== 'list';
  $('#cn-review').hidden = cnView !== 'review';
  if (cnView === 'list') renderSavedList(); else renderReview();
}

function renderSavedList() {
  const root = $('#cn-items');
  root.innerHTML = '';
  const items = pool();
  if (!allSaved().length) {
    root.append(h('p', 'empty', 'Ton carnet est vide. Touche ☆ sur une traduction, ou « Enregistrer » dans la fiche d’un mot, pour l’ajouter ici.'));
    ($('#cn-add') as HTMLDetailsElement).open = false;
    return;
  }
  for (const l of LANGS) {
    const group = items.filter((x) => x.lang === l.code);
    if (!group.length) continue;
    if (cnLang === 'all') root.append(h('h2', 'cn-group', `${l.flag} ${l.name} · ${group.length}`));
    for (const it of group) root.append(savedRow(it));
  }
}

function savedRow(it: SavedItem) {
  const card = h('article', 'card saved');
  card.dataset.lang = it.lang;
  const main = h('div', 'saved-main');
  main.append(clickable(it.text, it.lang, it.fr || it.text));
  const fr = h('p', 'saved-fr', it.fr ? `${FLAG.fr} ${it.fr}` : `${FLAG.fr} + ajouter le sens`);
  fr.onclick = () => {
    const v = prompt(`Sens en français de « ${it.text} »`, it.fr);
    if (v != null) updateSaved(it.id, { fr: v.trim() });
  };
  main.append(fr);
  const side = h('div', 'saved-side');
  const lvl = Math.min(it.srs.theme.box, it.srs.version.box);
  const dots = h('span', 'lvl', '●'.repeat(lvl) + '○'.repeat(MAX_BOX - lvl));
  dots.title = `Thème : niveau ${it.srs.theme.box}/${MAX_BOX} · Version : niveau ${it.srs.version.box}/${MAX_BOX}`;
  const del = h('button', 'icon del', '✕');
  del.setAttribute('aria-label', 'Supprimer');
  del.onclick = async () => {
    await removeSaved(it.id);
    toast(`« ${it.text} » supprimé.`, { label: 'Annuler', run: () => restoreSaved(it) });
  };
  side.append(del, dots);
  card.append(main, side);
  return card;
}

const shuffle = <T,>(a: T[]) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const SESSION = 20;

function startReview(free: boolean) {
  const usable = pool().filter((x) => x.fr.trim());
  const list = free ? usable : usable.filter((x) => isDue(x, cnDir));
  const queue = shuffle(list).slice(0, SESSION);
  rv = { queue, dir: cnDir, free, total: queue.length, done: 0, firstOk: 0, missed: new Set(), flipped: false };
  renderReview();
}

function renderReview() {
  const root = $('#rv');
  root.innerHTML = '';
  const usable = pool().filter((x) => x.fr.trim());
  if (!rv) {
    if (!usable.length) {
      root.append(h('p', 'empty', allSaved().length ? 'Ajoute le sens en français de tes mots (dans « Mes mots ») pour pouvoir t’interroger.' : 'Enregistre d’abord des mots ou des expressions : touche ☆ sur une traduction.'));
      return;
    }
    const due = usable.filter((x) => isDue(x, cnDir)).length;
    const box = h('div', 'rv-start');
    const where = cnLang === 'all' ? '' : ` en ${LANG_BY_CODE[cnLang].name.toLowerCase()}`;
    if (due) {
      box.append(h('p', 'rv-big', String(due)), h('p', 'muted', `${due > 1 ? 'cartes' : 'carte'} à réviser${where}`));
      const go = h('button', '', due > SESSION ? `Réviser ${SESSION} cartes` : 'Commencer');
      go.onclick = () => startReview(false);
      box.append(go);
    } else {
      box.append(h('p', 'rv-big', '🎉'), h('p', 'muted', `Rien à réviser${where} aujourd’hui. Les cartes reviennent au bout de 1, 3, 7, 16 jours… tant que tu les connais.`));
      const go = h('button', 'secondary', 'S’entraîner quand même');
      go.onclick = () => startReview(true);
      box.append(go);
    }
    root.append(box);
    return;
  }
  const r = rv;
  const it = r.queue[0];
  if (!it) {
    const box = h('div', 'rv-start');
    box.append(h('p', 'rv-big', `${r.firstOk}/${r.total}`), h('p', 'muted', r.free ? 'trouvées du premier coup (entraînement libre, sans effet sur les révisions).' : 'trouvées du premier coup. Les cartes ratées reviendront plus tôt.'));
    const again = h('button', '', 'Terminer');
    again.onclick = () => { rv = null; renderCarnet(); };
    box.append(again);
    root.append(box);
    return;
  }
  const l = LANG_BY_CODE[it.lang];
  const card = h('article', `card flash${r.flipped ? ' flipped' : ''}`);
  card.dataset.lang = it.lang;
  const head = h('div', 'card-head');
  head.append(h('span', 'flag', l.flag), h('span', 'lname', l.name), h('span', 'badge', `${Math.min(r.done + 1, r.total)} / ${r.total}${r.queue.length > r.total - r.done ? ' +' : ''}`));
  card.append(head);
  const theme = r.dir === 'theme';
  const q = h('p', 'flash-q');
  if (theme) q.textContent = it.fr; else { q.lang = it.lang; q.textContent = it.text; }
  card.append(q);
  if (!r.flipped) {
    card.append(h('p', 'flash-hint', theme ? `Comment le dit-on en ${l.name.toLowerCase()} ? Touche pour voir.` : 'Que veut dire ceci ? Touche pour voir.'));
    card.onclick = () => { r.flipped = true; renderReview(); };
    root.append(card);
    return;
  }
  const a = h('div', 'flash-a');
  if (theme) a.append(clickable(it.text, it.lang, it.fr)); else a.append(h('p', 'text', `${FLAG.fr} ${it.fr}`));
  card.append(a);
  root.append(card);
  const btns = h('div', 'flash-btns');
  const ko = h('button', 'ko', '✗ À revoir');
  const ok = h('button', 'ok', '✓ Je savais');
  const answer = async (good: boolean) => {
    r.queue.shift();
    r.flipped = false;
    if (good) { r.done++; if (!r.missed.has(it.id)) r.firstOk++; }
    else { r.missed.add(it.id); r.queue.push(it); }
    renderReview();
    if (!r.free) await grade(it, r.dir, good);
  };
  ko.onclick = () => answer(false);
  ok.onclick = () => answer(true);
  btns.append(ko, ok);
  root.append(btns);
  const stop = h('button', 'link', 'Arrêter la révision');
  stop.onclick = () => { rv = null; renderCarnet(); };
  root.append(stop);
}

for (const b of document.querySelectorAll<HTMLButtonElement>('#cn-view [data-view]')) b.onclick = () => { cnView = b.dataset.view as typeof cnView; renderCarnet(); };
for (const b of document.querySelectorAll<HTMLButtonElement>('#cn-dir [data-dir]')) b.onclick = () => { cnDir = b.dataset.dir as Dir; localStorage.setItem('cnDir', cnDir); rv = null; renderCarnet(); };
$('#cn-add-form').onsubmit = async (e) => {
  e.preventDefault();
  const lang = ($('#cn-add-lang') as HTMLSelectElement).value as LangCode;
  const text = $('#cn-add-text') as HTMLInputElement;
  const fr = $('#cn-add-fr') as HTMLInputElement;
  if (!text.value.trim()) return text.focus();
  if (!fr.value.trim()) return fr.focus();
  await addSaved(lang, text.value, fr.value);
  toast(`${FLAG[lang]} « ${text.value.trim()} » ajouté au carnet.`);
  text.value = fr.value = '';
  text.focus();
};
($('#cn-add-lang') as HTMLSelectElement).onchange = (e) => { ($('#cn-add-text') as HTMLInputElement).lang = (e.target as HTMLSelectElement).value; };

function toast(msg: string, action?: { label: string; run: () => void }) {
  document.querySelector('.toast')?.remove();
  const t = h('div', 'toast');
  t.append(h('span', '', msg));
  if (action) {
    const b = h('button', 'toast-action', action.label);
    b.onclick = () => { t.remove(); action.run(); };
    t.append(b);
  }
  document.body.append(t);
  setTimeout(() => t.remove(), 5000);
}

// ---------- Démarrage ----------
$('#form').onsubmit = (e) => { e.preventDefault(); translate(($('#input') as HTMLTextAreaElement).value); };
$('#verify').onclick = verify;
refreshNet();
// Ancienne version : le quiz était un onglet à part.
if (localStorage.getItem('tab') === 'quiz') { localStorage.setItem('tab', 'simple'); localStorage.setItem('quiz', '1'); }
setQuiz(!!localStorage.getItem('quiz'));
showTab(['context', 'origin', 'carnet'].includes(localStorage.getItem('tab') ?? '') ? localStorage.getItem('tab')! : 'simple');
onSavedChange(() => { refreshStars(); updateDueBadge(); if (!$('#tab-carnet').hidden && !rv) renderCarnet(); });
loadSaved();
renderSetup();
navigator.storage?.persist?.().catch(() => {});
tr.postMessage({ type: 'init' });
dictCall({ type: 'init' }).then(() => { dictReady = true; renderSetup(); }).catch((e) => { dictError = e.message; renderSetup(); });
get('history').then((l) => renderHistory(l ?? [])).catch(() => {});
