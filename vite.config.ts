import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Project root serves index.html; the browser client lives in src/, and shared/
// is imported by BOTH src/ and server/ through the '@shared/*' alias. The alias
// is declared here AND in tsconfig.json "paths" — both are required.
export default defineConfig({
  root: '.',
  publicDir: 'public',
  resolve: {
    /**
     * One `three`, whatever asks for it.
     *
     * `three-mesh-bvh` declares three as a PEER dependency, and a peer resolved
     * to a second copy is not a wasted download — it silently breaks
     * `instanceof`. `src/station/collision.ts` installs that package's
     * `acceleratedRaycast` onto `THREE.Mesh.prototype`, and the function
     * branches on `this instanceof Mesh` against the `Mesh` IT imported; two
     * copies makes that false for every mesh the app ever created, and the §4
     * interaction raycast throws `BVH: Fallback raycast function not found`
     * inside the render tick.
     *
     * This is the build-side guarantee. `optimizeDeps.include` below is the
     * dev-server side of the same promise.
     */
    dedupe: ['three'],
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
    /**
     * EVERY three entry point the app touches, declared up front.
     *
     * ─────────────────────────────────────────────────────────────────────────
     * WHAT WAS ACTUALLY OBSERVED, because the honest version is less tidy than
     * the story this list suggests.
     *
     * A long-running dev session — many edits, at least one forced
     * re-optimisation — ended up serving TWO distinct copies of three's core
     * (`three.module-BAp-O8l5.js?v=...` alongside a bare, unversioned
     * `three.module-BEvS_7fE.js`). three's own "Multiple instances of Three.js
     * being imported" warning fired, and the render tick threw
     * `BVH: Fallback raycast function not found` for the reason described on
     * `resolve.dedupe` above.
     *
     * It could NOT be reproduced from a cold `node_modules/.vite`: not with
     * this list removed, not with the pre-existing import specifiers, and not
     * by loading both HTML entry points in either order. The unversioned chunk
     * name is the tell — that is a stale artefact of a re-optimisation landing
     * while a page still referenced the previous bundle, which is a dev-server
     * cache problem and never affects `vite build`.
     *
     * So this list is HARDENING, not a proven cure, and it is worth having on
     * those terms: vite re-optimises when it discovers a dependency the initial
     * crawl missed, and every re-optimisation is another chance to hit that
     * window. Naming all seven entries — including the dynamic one the crawler
     * cannot see — makes the first pass complete, so there is nothing left to
     * discover and no reason to re-optimise.
     *
     * IF IT COMES BACK: delete `node_modules/.vite` and restart. That clears it
     * every time. Add any new `three/addons/*` import to this list when you
     * write it — especially a DYNAMIC one, which the initial crawl cannot see —
     * and spell it `three/addons/*` rather than `three/examples/jsm/*`: they
     * resolve to the same file, but the optimiser keys on the specifier string,
     * so two spellings are two entries.
     */
    include: [
      // rapier3d-compat ships wasm inlined as base64; let Vite prebundle it.
      '@dimforge/rapier3d-compat',
      'three',
      'three-mesh-bvh',
      'three/addons/postprocessing/EffectComposer.js',
      'three/addons/postprocessing/Pass.js',
      'three/addons/postprocessing/RenderPass.js',
      'three/addons/postprocessing/ShaderPass.js',
      'three/addons/utils/BufferGeometryUtils.js',
    ],
  },
});
