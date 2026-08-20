/**
 * src/render/materials.ts — the handful of materials §9 actually specifies.
 *
 * "Everything else is emissive strips and cheap ambient", and "handrails get a
 * high-contrast material from day one because they're the movement grammar and
 * must be readable in the dark."
 *
 * These are factories, not a registry: the station subsystem owns the geometry
 * and decides how many instances share one material. Every material here has
 * `fog: true` so the two-hop cull boundary stays buried in the fog (§2).
 */

import * as THREE from 'three';

/**
 * Unlit strip light. The colour is pushed above 1.0 in the working (linear)
 * colour space so it clears the bloom threshold while lit surfaces do not —
 * that is what "bloom on emissives" means in a scene with no other bright
 * pixels. Unlit is deliberate: a strip does not need to be shaded, and
 * MeshBasicMaterial costs nothing in the light budget.
 */
export function createEmissiveStripMaterial(
  color: THREE.ColorRepresentation = 0x7fe6ff,
  intensity = 2.4,
): THREE.MeshBasicMaterial {
  const c = new THREE.Color(color);
  c.multiplyScalar(Math.max(0, intensity));
  return new THREE.MeshBasicMaterial({ color: c, fog: true, toneMapped: true });
}

/**
 * Handrail material: pale, slightly self-lit so a rail is legible at the edge of
 * the flashlight cone, and rough enough not to read as chrome. Movement grammar
 * must never disappear into the dark (§9).
 */
export function createHandrailMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xd9d3a6,
    roughness: 0.55,
    metalness: 0.08,
    emissive: new THREE.Color(0x4a4526).multiplyScalar(0.55),
    emissiveIntensity: 1,
    fog: true,
  });
}

/** Generic hull / bulkhead surface: mid-grey, matte, takes the flashlight well. */
export function createHullMaterial(color: THREE.ColorRepresentation = 0x7c8288): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.82,
    metalness: 0.06,
    fog: true,
  });
}

/** Darker equipment / panel body, so instrument faces read against it. */
export function createPanelMaterial(color: THREE.ColorRepresentation = 0x2b3136): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.7,
    metalness: 0.15,
    fog: true,
  });
}

/**
 * Wrapper for a `CanvasTexture` puzzle panel (§6). Unlit and lightly emissive so
 * the gauge is readable without spending a light on it; `map.needsUpdate = true`
 * after each 10 Hz canvas redraw.
 */
export function createCanvasPanelMaterial(canvas: HTMLCanvasElement, glow = 1.15): THREE.MeshBasicMaterial {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  const material = new THREE.MeshBasicMaterial({ map: texture, fog: true, toneMapped: true });
  material.color.setScalar(Math.max(0, glow));
  return material;
}
