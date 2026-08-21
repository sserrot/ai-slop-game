import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Project root serves index.html; the browser client lives in src/, and shared/
// is imported by BOTH src/ and server/ through the '@shared/*' alias. The alias
// is declared here AND in tsconfig.json "paths" — both are required.
export default defineConfig({
  root: '.',
  publicDir: 'public',
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
      // simple-peer (§1 voice mesh) drags in readable-stream, which imports
      // Node's 'events'. Without this Vite externalises it and the module throws
      // the first time a peer connects. Point it at the browser shim instead.
      events: fileURLToPath(new URL('./node_modules/events/events.js', import.meta.url)),
    },
  },
  define: {
    // simple-peer and readable-stream both reference the Node `global`.
    global: 'globalThis',
  },
  server: {
    // Honour PORT when the launcher assigns one, else the usual Vite default.
    // Hardcoding it here overrode an assigned port and collided with whatever
    // dev server was already up; nothing depends on a specific port, because the
    // client reaches the game server on its own (ws://127.0.0.1:2567 by default,
    // or VITE_SERVER_URL).
    port: Number(process.env.PORT) || 5173,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    // rapier3d-compat inlines its wasm as base64 (~2.8 MB). Import it
    // dynamically from the physics module so it does not block first paint,
    // and stop the size warning firing on every build.
    chunkSizeWarningLimit: 4000,
  },
  optimizeDeps: {
    // rapier3d-compat ships wasm inlined as base64; let Vite prebundle it.
    include: ['@dimforge/rapier3d-compat'],
  },
});
