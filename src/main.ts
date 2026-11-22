import './styles.css';
import { get, set } from 'idb-keyval';
import { LANGS, FLAG, NAME, type AnyLang, type LangCode } from './langs';
import {
  explainOnline, loadSettings, onlineAvailable, saveSettings, translateOnline, verifyOnline,
  DEFAULT_MODEL, type Translations,
} from './gemini';

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
let current: { fr: string; id: number; cards: Partial<Record<LangCode, Card>>; notes?: string } | null = null;
let modelsReady = false;
let dictReady = false;

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
  <form id="form">
    <textarea id="input" rows="3" placeholder="Écris une phrase en français…" lang="fr"></textarea>
    <button id="go" type="submit">Traduire</button>
  </form>
  <div id="source" class="source" hidden></div>
  <div id="idioms"></div>
  <div id="cards"></div>
  <div id="actions" class="actions" hidden>
    <button id="verify" class="secondary">🔍 Vérifier en ligne</button>
  </div>
  <p id="warning" class="warning" hidden></p>
  <section id="history"></section>
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
      <div class="row"><button value="cancel" class="secondary">Annuler</button><button id="save" value="ok">Enregistrer</button></div>
    </form>
  </dialog>
`;

// ---------- Réseau ----------
function refreshNet() {
  const el = $('#net');
  if (!navigator.onLine) el.textContent = '● Hors ligne';
  else if (!loadSettings().geminiKey) el.textContent = '● En ligne (sans clé)';
  else el.textContent = '● En ligne';
  el.dataset.on = String(onlineAvailable());
  $('#verify').toggleAttribute('disabled', !onlineAvailable());
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
  el.innerHTML = `<b>Préparation hors ligne</b>
    <p>${modelsReady ? '✅ Modèles de traduction prêts' : `Téléchargement des modèles de traduction (une seule fois, Wi-Fi conseillé) : ${mb(loaded)} / ${total ? mb(total) : '~550'} Mo`}</p>
    <progress max="1" value="${modelsReady ? 1 : total ? loaded / total : 0}"></progress>
    <p>${dictReady ? '✅ Dictionnaire prêt' : `Installation du dictionnaire : ${dictProg.total ? Math.round((100 * dictProg.loaded) / dictProg.total) : 0} %`}</p>`;
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
    const head = h('div', 'card-head');
    head.append(h('span', 'flag', l.flag), h('span', 'lname', l.name));
    if (c) {
      const badge = h('span', `badge ${c.source}`, c.source === 'opus' ? 'hors ligne · littéral' : c.source === 'gemini' ? 'idiomatique' : 'corrigé');
      head.append(badge);
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
  $('#actions').hidden = false;
  const warn = $('#warning');
  warn.hidden = !anyOpus;
  warn.textContent = '⚠️ Traduction automatique hors ligne : les expressions idiomatiques peuvent être traduites mot à mot. Fie-toi à l’encadré 💡 et, si tu as du réseau, au bouton « Vérifier ».';
  if (current.notes) { const n = h('p', 'notes', `💬 ${current.notes}`); root.prepend(n); }
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
    translateOnline(fr).then((t) => {
      if (current?.id !== id) return;
      for (const l of LANGS) if (t[l.code]) current.cards[l.code] = { text: t[l.code], source: 'gemini' };
      current.notes = t.notes || undefined;
      renderCards();
      saveHistory();
    }).catch((e) => toast(e.message));
  }
}

async function verify() {
  if (!current) return;
  const btn = $('#verify');
  btn.setAttribute('disabled', '');
  btn.textContent = 'Vérification…';
  try {
    const texts: Partial<Translations> = {};
    for (const l of LANGS) texts[l.code] = current.cards[l.code]?.text;
    const r = await verifyOnline(current.fr, texts);
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
  box.append(h('h2', '', `${FLAG[lang]} ${word}`));
  const off = h('section', 'offline');
  off.append(h('p', 'muted', 'Recherche dans le dictionnaire…'));
  box.append(off);
  const on = h('section', 'online');
  box.append(on);

  let hint = '';
  try {
    const d = await dictCall({ type: 'lookup', lang, word });
    off.innerHTML = '';
    if (d.forms.length) {
      const f = h('div', 'block');
      f.append(h('h3', '', 'Forme'));
      for (const x of d.forms) f.append(h('p', '', `${x.info ? x.info : 'Forme de'} → ${x.lemma}`));
      off.append(f);
      hint += d.forms.map((x: any) => `Forme : ${x.info ?? ''} (lemme ${x.lemma})`).join('\n') + '\n';
    }
    for (const e of d.entries) {
      const b = h('div', 'block');
      b.append(h('h3', '', `${e.word} · ${e.pos}${e.gender ? ` (${e.gender.replace('masculine', 'masc.').replace('feminine', 'fém.').replace('neuter', 'neutre')})` : ''}${e.ipa ? `  ${e.ipa}` : ''}`));
      const ol = h('ol');
      for (const g of e.glosses) ol.append(h('li', '', g));
      b.append(ol);
      if (e.etym) { b.append(h('p', 'etym', `🌱 ${e.etym}`)); hint += `Étymologie de ${e.word} : ${e.etym}\n`; }
      off.append(b);
      hint += `${e.word} (${e.pos}) : ${e.glosses.join(' / ')}\n`;
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

  if (!onlineAvailable()) {
    on.append(h('p', 'muted', navigator.onLine ? 'Ajoute une clé Gemini dans les réglages pour l’explication grammaticale détaillée.' : 'Explication détaillée disponible quand tu seras en ligne.'));
    return;
  }
  on.append(h('p', 'muted', 'Explication détaillée en cours…'));
  try {
    const x = await explainOnline(word, lang, sentence, original, hint.slice(0, 2500));
    on.innerHTML = '';
    on.append(h('h3', '', `Explication · ${x.lemme}`));
    on.append(h('p', 'nature', x.nature));
    on.append(h('p', '', `🧩 ${x.role}`));
    on.append(h('p', 'etym', `🌱 ${x.racine}`));
    if (x.liens?.length) {
      const ul = h('ul', 'equiv');
      for (const li of x.liens) ul.append(h('li', '', `${FLAG[li.lang as AnyLang] ?? li.lang} ${li.mot} — ${li.note}`));
      on.append(ul);
    }
    on.append(h('p', 'note', 'Explication générée par Gemini : peut contenir des erreurs.'));
  } catch (e) {
    on.innerHTML = '';
    on.append(h('p', 'muted', (e as Error).message));
  }
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
  ($('#model') as HTMLInputElement).value = s.model === DEFAULT_MODEL ? '' : s.model;
  ($('#settings') as HTMLDialogElement).showModal();
};
$('#save').onclick = () => {
  saveSettings({
    geminiKey: ($('#key') as HTMLInputElement).value.trim(),
    model: ($('#model') as HTMLInputElement).value.trim() || DEFAULT_MODEL,
  });
  refreshNet();
};

function toast(msg: string) {
  const t = h('div', 'toast', msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 5000);
}

// ---------- Démarrage ----------
$('#form').onsubmit = (e) => { e.preventDefault(); translate(($('#input') as HTMLTextAreaElement).value); };
$('#verify').onclick = verify;
refreshNet();
renderSetup();
navigator.storage?.persist?.().catch(() => {});
tr.postMessage({ type: 'init' });
dictCall({ type: 'init' }).then(() => { dictReady = true; renderSetup(); }).catch((e) => { toast(e.message); });
get('history').then((l) => renderHistory(l ?? [])).catch(() => {});
