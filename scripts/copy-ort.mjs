// Copie les fichiers WebAssembly d'ONNX Runtime dans public/ort : sans ça, ils seraient
// chargés depuis un CDN et la traduction ne marcherait pas hors ligne.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
const src = 'node_modules/onnxruntime-web/dist';
mkdirSync('public/ort', { recursive: true });
for (const f of readdirSync(src)) if (/^ort-wasm-simd-threaded\.asyncify\.(mjs|wasm)$/.test(f)) cpSync(`${src}/${f}`, `public/ort/${f}`);
