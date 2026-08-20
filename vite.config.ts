import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  // Local Whisper (transformers.js) — avoid pre-bundling WASM/ONNX workers
  optimizeDeps: {
    exclude: ['@huggingface/transformers'],
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    // Start.bat waits on 5173 and opens it in the browser; silently drifting to
    // 5174 would hand the user a dead link instead of an error they can act on.
    strictPort: true,
    proxy: {
      '/api': {
        // IPv4 loopback — matches server bind (avoids Windows localhost → ::1 miss)
        target: 'http://127.0.0.1:6969',
        changeOrigin: true,
        /** When Express is down, Vite would return empty 500 — send a clear JSON reason instead. */
        configure: (proxy) => {
          proxy.on('error', (err, _req, res) => {
            const r = res as import('http').ServerResponse | undefined;
            if (!r || r.headersSent || typeof r.writeHead !== 'function') return;
            console.error('[vite proxy /api]', err.message);
            r.writeHead(502, { 'Content-Type': 'application/json' });
            r.end(JSON.stringify({
              error:
                'Reverie API server is not running (port 6969). Use Start.bat or `npm run dev` so both UI and server start, then refresh.',
              code: 'backend_down',
            }));
          });
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
});
