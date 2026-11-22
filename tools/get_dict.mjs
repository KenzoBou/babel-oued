// Prépare le dictionnaire hors ligne pour le mode développement (npm run dict).
// Télécharge les extractions du Wiktionnaire (~6 Go, temporaires), construit la base
// SQLite avec tools/build_dict.py puis la place dans public/ (dict.pack + dict.version).
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync, createReadStream, renameSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { execFileSync } from 'node:child_process';

const LANGS = ['Français', 'Anglais', 'Espagnol', 'Allemand', 'Italien', 'Russe'];
mkdirSync('build/data', { recursive: true });
mkdirSync('public', { recursive: true });

await Promise.all(LANGS.map(async (l) => {
  const out = `build/data/${l}.jsonl`;
  if (existsSync(out)) return;
  const u = encodeURIComponent(l);
  console.log(`Téléchargement : ${l}…`);
  const res = await fetch(`https://kaikki.org/frwiktionary/${u}/kaikki.org-dictionary-${u}.jsonl`);
  if (!res.ok) throw new Error(`${l} : HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(`${out}.part`));
  renameSync(`${out}.part`, out);
}));

console.log('Construction de la base (quelques minutes)…');
const py = process.platform === 'win32' ? 'python' : 'python3';
execFileSync(py, ['tools/build_dict.py', 'build/data', 'build/dict.sqlite'], { stdio: 'inherit' });
console.log('Compression…');
await pipeline(createReadStream('build/dict.sqlite'), createGzip({ level: 6 }), createWriteStream('public/dict.pack'));
writeFileSync('public/dict.version', `local-${Date.now()}\n`);
rmSync('build/data', { recursive: true, force: true });
console.log('✅ Dictionnaire prêt : public/dict.pack');
