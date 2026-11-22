import { defineConfig } from 'vite';

export default defineConfig({
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});
