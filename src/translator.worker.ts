/// <reference lib="webworker" />
// Traduction hors ligne : modèles Opus-MT (Marian) exécutés dans le WebView via transformers.js.
import { pipeline, env, type TranslationPipeline } from '@huggingface/transformers';
import { LANGS, type LangCode } from './langs';

env.allowLocalModels = false;
env.useBrowserCache = true; // les modèles restent dans le Cache Storage → hors ligne ensuite
// Note : Vite intègre le fichier WebAssembly d'ONNX Runtime dans l'application (pas de CDN).

const pipes = new Map<LangCode, TranslationPipeline>();
let loading: Promise<void> | null = null;

type Msg =
  | { type: 'init' }
  | { type: 'translate'; id: number; text: string };

function post(m: unknown) {
  (self as unknown as Worker).postMessage(m);
}

async function init() {
  for (const l of LANGS) {
    if (pipes.has(l.code)) continue;
    const p = (await pipeline('translation', l.model, {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (e: any) => {
        if (e.status === 'progress') post({ type: 'progress', lang: l.code, file: e.file, loaded: e.loaded, total: e.total });
      },
    })) as TranslationPipeline;
    pipes.set(l.code, p);
    post({ type: 'loaded', lang: l.code });
  }
  post({ type: 'ready' });
}

function sentences(text: string): string[] {
  const seg = new Intl.Segmenter('fr', { granularity: 'sentence' });
  return [...seg.segment(text)].map((s) => s.segment.trim()).filter(Boolean);
}

async function run(p: TranslationPipeline, parts: string[]): Promise<string> {
  const out: string[] = [];
  for (const s of parts) {
    const r = (await p(s, { max_new_tokens: 256 } as any)) as any;
    out.push((Array.isArray(r) ? r[0] : r).translation_text);
  }
  return out.join(' ');
}

self.onmessage = async (ev: MessageEvent<Msg>) => {
  const m = ev.data;
  try {
    if (m.type === 'init') {
      loading ??= init();
      await loading;
    } else if (m.type === 'translate') {
      loading ??= init();
      await loading;
      const parts = sentences(m.text);
      const done = new Map<LangCode, string>();
      for (const l of LANGS) {
        const t0 = performance.now();
        const src = l.pivot ? sentences(done.get(l.pivot)!) : parts;
        const text = await run(pipes.get(l.code)!, src);
        done.set(l.code, text);
        post({ type: 'result', id: m.id, lang: l.code, text, ms: Math.round(performance.now() - t0) });
      }
      post({ type: 'done', id: m.id });
    }
  } catch (e) {
    post({ type: 'error', id: (m as any).id, message: String((e as Error)?.message ?? e) });
  }
};
