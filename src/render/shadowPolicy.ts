/**
 * src/render/shadowPolicy.ts — who is allowed into the one shadow map (§9).
 *
 * §9 budgets ONE shadow map: the flashlight's 1024². It does not say every mesh
 * in the two-hop cull set belongs in it, and measurement says several classes of
 * mesh do not:
 *
 *   • the emissive light strips and hatch indicators are LIGHT SOURCES. They are
 *     authored above 1.0 in linear space with `toneMapped = false` so the bloom
 *     threshold finds them; a lamp casting a shadow of itself is nonsense, and
 *     it is nonsense that costs a draw call and a re-rasterisation every frame;
 *   • unlit `MeshBasicMaterial` faces (the §6 CanvasTexture puzzle panels) are
 *     screens for the same reason;
 *   • anything already flagged `userData.noShadow` — the instanced handrails and
 *     props (`src/station/instancing.ts`) and the invisible collision hull
 *     (`src/station/collision.ts`) — has opted out at the point of creation and
 *     must stay out.
 *
 * This is a policy, not a traverse-and-forget: `Renderer` re-applies it whenever
 * the cull set changes, so a blanket `group.traverse(o => o.castShadow = true)`
 * elsewhere is corrected at the next module transition instead of quietly
 * doubling the shadow pass for the rest of the round. The instanced meshes go
 * further and latch the flag outright, because they are the ones that hurt.
 *
 * Pass your own `casts` predicate to tighten it further — the measured shadow
 * pass in the worst two-hop view is 34 draw calls and ~9,950 triangles, of which
 * the module hull and trim meshes alone are ~10 calls and ~6,800 triangles.
 */

import * as THREE from 'three';

export interface ShadowPolicyOptions {
  /**
   * Decides whether one mesh MAY cast. Defaults to {@link castsShadowByDefault},
   * which rejects see-through surfaces and anything that is itself a light.
   * `userData.noShadow` is honoured before this is consulted, always.
   */
  casts?: (mesh: THREE.Mesh) => boolean;
}

export interface ShadowPolicyStats {
  /** Meshes visited. */
  meshes: number;
  /** Meshes left casting after the pass. */
  casters: number;
  /** Meshes skipped because they had opted out at creation. */
  optedOut: number;
  /** Meshes the predicate rejected. */
  rejected: number;
  /** Meshes this pass actually switched off (a blanket setter had been through). */
  cleared: number;
}

function isLightSource(material: THREE.Material): boolean {
  // Unlit: a screen, a strip, a decal. It emits, it does not occlude.
  if ((material as THREE.MeshBasicMaterial).isMeshBasicMaterial === true) return true;
  // Authored above 1.0 in linear space so bloom finds it — same story.
  if (material.toneMapped === false) return true;
  return false;
}

/**
 * The default rule. A mesh casts unless it is see-through or is itself a light.
 * Deliberately material-driven rather than name-driven: the render subsystem
 * never imports `station/`, and a material already carries the intent.
 */
export function castsShadowByDefault(mesh: THREE.Mesh): boolean {
  const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
  if (!material) return false;
  const list = Array.isArray(material) ? material : [material];
  for (const m of list) {
    if (!m) continue;
    if (m.transparent === true && m.opacity < 1) return false;
    if (m.visible === false) return false;
    if (isLightSource(m)) return false;
  }
  return true;
}

/**
 * Apply the policy to a subtree. Idempotent and allocation-free; call it
 * whenever the contents of the scene change (a module transition is the natural
 * beat — `Renderer.setModules` does exactly that).
 *
 * SUBTRACTIVE ON PURPOSE. It only ever clears `castShadow`, never sets it. §9's
 * rule is that geometry opts IN to the one shadow map, so a subsystem that
 * decided its mesh should not cast — the invisible collision hull does — keeps
 * that decision, and this pass can never resurrect it. What it does undo is the
 * opposite mistake: a blanket `traverse(o => o.castShadow = true)` sweeping up
 * light strips and screens.
 *
 * The two subsystems that opt IN are `RemoteCrewViews` and `AlienView`: a
 * character is a moving occluder, and a shadow arriving through a hatchway
 * before the body does is the cheapest scare in the project. Both ride opaque
 * `MeshStandardMaterial`s, so `castsShadowByDefault` keeps them and this pass
 * leaves them alone.
 */
export function applyShadowPolicy(
  root: THREE.Object3D,
  opts: ShadowPolicyOptions = {},
): ShadowPolicyStats {
  const casts = opts.casts ?? castsShadowByDefault;
  const stats: ShadowPolicyStats = { meshes: 0, casters: 0, optedOut: 0, rejected: 0, cleared: 0 };

  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh !== true) return;
    stats.meshes++;

    if (mesh.userData.noShadow === true) {
      stats.optedOut++;
      // The flag is the owner's decision; do not write over a latched property.
      return;
    }

    if (casts(mesh)) {
      if (mesh.castShadow) stats.casters++;
      return;
    }

    stats.rejected++;
    if (mesh.castShadow) {
      // Assignment, not defineProperty: a subsystem that creates a mesh may
      // still latch its own flag (and set `userData.noShadow` to say so), but a
      // policy that hard-locks meshes it did not create makes every later
      // change spooky. Re-running the pass is what makes this stick instead.
      mesh.castShadow = false;
      stats.cleared++;
    }
  });

  return stats;
}
