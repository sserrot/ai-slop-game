/**
 * shared/graph — the core simulation primitives, used identically on client and
 * server (DESIGN.md §1).
 *
 * Import either the barrel (`@shared/graph`) or the individual modules
 * (`@shared/graph/noise`). Both resolve on both sides.
 *
 *   math       plain-object vector / quaternion maths, renderer-free
 *   moduleGraph  §2 station graph, hatch attenuation, A*, AND per-module gravity
 *   railGraph    §2 handrails — gravity-scoped, since rails only carry a body
 *                in a module with no floor
 *   noise        §3 propagation, listener resolution, coalescing
 *   gravity      the walking pivot: one global DOWN, fall maths, transitions
 *   gait         crouch / walk / sprint and the distance-based stride model
 *   hideSpots    lockers, bays and bunks — geometry the alien will not sweep
 */

export * from '@shared/graph/math';
export * from '@shared/graph/moduleGraph';
export * from '@shared/graph/railGraph';
export * from '@shared/graph/noise';
export * from '@shared/graph/gravity';
export * from '@shared/graph/gait';
export * from '@shared/graph/hideSpots';
