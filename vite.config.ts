import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Start.bat waits on this file, then opens whatever URL Vite actually bound. */
const DEV_URL_FILE = path.join(os.tmpdir(), 'reverie-ui-url.txt');

function writeDevUrlPlugin(): Plugin {
  return {
    name: 'reverie-write-dev-url',
    configureServer(server: ViteDevServer) {
      const write = () => {
        const addr = server.httpServer?.address();
        if (!addr || typeof addr === 'string') return;
        fs.writeFileSync(DEV_URL_FILE, `http://127.0.0.1:${addr.port}`, 'utf8');
      };
      if (server.httpServer?.listening) write();
      else server.httpServer?.once('listening', write);
    },
  };
}

export default defineConfig({
  plugins: [react(), writeDevUrlPlugin()],
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
    // If 5173 is taken, use 5174, 5175, … Start.bat opens the bound URL.
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
