/**
 * src/noise — the client-side noise runtime (DESIGN.md §3).
 *
 * The maths lives in `@shared/graph/noise` and is used by both sides. This
 * directory is the client half: it knows who is listening, resolves every event
 * against the station graph, and publishes the stream `src/audio` (§8) and
 * `src/ui` (§6) consume.
 *
 *   const runtime = new NoiseRuntime({ graph, localPlayerId: sessionId });
 *   runtime.attach();
 *   const emitter = new NoiseEmitter(runtime, { network, actor: sessionId });
 *   emitter.attach();
 *
 *   // every frame, from the player controller
 *   runtime.setListener(camera.position, currentModuleId);
 *
 *   // from src/net, on a server 'noise' broadcast
 *   runtime.ingestMessage(msg);
 */

export * from './types';
export * from './carry';
export * from './runtime';
export * from './emitter';
