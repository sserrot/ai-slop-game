/**
 * src/station/fixtures.ts — the §11 puzzle hardware, installed.
 *
 * `puzzleProps.ts` is the geometry and the joint model; this is the assembly that
 * reads `levels/station.json`, works out which of the five fixtures belongs on
 * each authored panel, and puts it there. It is the file `main.ts` drives.
 *
 * THE DRAW-CALL ARITHMETIC, which is the whole shape of this file.
 *
 * Thirteen panels, spread over eight of the nine modules, and two-hop culling
 * reaches seven of them — so "module-culled" saves almost nothing and every mesh
 * added here is a permanent draw call. Hence:
 *
 *   • the STATIC half of every fixture, plus the panel shell itself, is merged
 *     into ONE vertex-coloured mesh PER MODULE on `materials.hazard`. That
 *     REPLACES the thirteen plain panel-body meshes `panels.ts` used to draw
 *     (`StationPanels` is constructed with `body: false` by `Station`), so the
 *     static half of this feature lands at NEGATIVE five draw calls;
 *   • parts that REPEAT — six breaker levers, three undock covers, three undock
 *     throw levers — are one `FixturePartSet` each, animated by `setMatrixAt`;
 *   • parts that exist ONCE (the override, the handwheel, the needle, the green
 *     band, two keys) stay plain meshes on a two-node pivot, exactly as
 *     `puzzleProps.ts` recommends: an `InstancedMesh` of one costs the same draw
 *     call and an extra shader permutation;
 *   • all thirteen accents are ONE `InstancedSet`.
 *
 * Net: +5 draw calls in the worst case, 0 new shader programs, and every gram of
 * it created at load time so `Renderer.prewarm()` can pay for it behind the menu.
 *
 * WHY A TWO-NODE PIVOT for the single parts. `Object3D.applyMatrix4` decomposes
 * into position/quaternion/scale, so writing `rotation.z` on the same node
 * afterwards would throw the installed orientation away. The mount carries the
 * fixture-to-world transform and the joint carries nothing but the angle, which
 * also means the sink is a one-line closure over a number.
 *
 * WHY THE ROTATION AXIS DIFFERS PER PART. `FixturePartSet` rotates about local X
 * and that is right for every arm modelled along +Y off a horizontal hinge (the
 * levers, the covers, the throws, the override). The wheel, the needle, the band
 * and the key are all modelled in the fixture's XY plane and turn about +Z — the
 * face of the panel. Getting that wrong is not subtle: a handwheel on the X axis
 * tumbles out of the wall instead of turning.
 */

import * as THREE from 'three';
import type { ModuleId, StationLayout } from '@shared/types';
import { accentMatrix, buildAccentInstances, mergeParts } from './artKit';
import type { AccentPlacement } from './artKit';
import type { InstancedSet } from './instancing';
import type { StationMaterials } from './materials';
import { moduleMatrix, propMatrix } from './threeUtil';
import {
  BREAKER,
  FixturePartSet,
  GAUGE,
  KEYSWITCH,
  PuzzleFixture,
  UNDOCK,
  VALVE,
  breakerLeverGeometry,
  breakerLeverPivot,
  breakerOverrideGeometry,
  fixtureAccent,
  fixtureBasis,
  fixtureRoleOf,
  fixtureStaticGeometry,
  gaugeBandGeometry,
  gaugeNeedleGeometry,
  keyswitchKeyGeometry,
  panelShellGeometry,
  undockCoverGeometry,
  undockLeverGeometry,
  valveWheelGeometry,
} from './puzzleProps';
import type {
  BreakerFixtureState,
  FixtureKind,
  FixtureSlot,
  GaugeFixtureState,
  ValveFixtureState,
} from './puzzleProps';

/**
 * Half-width of the gauge's green target band, as a fraction of the dial sweep.
 *
 * The band never animates — `PuzzleFixture.applyGauge` sets it once from the
 * first snapshot — but its GEOMETRY has to exist before that snapshot arrives, or
 * the arc would be built on first sight of the puzzle and hitch the frame it
 * appeared in. `CoolantState.bandHalf` is a constant of the puzzle (0.05); the
 * geometry is baked to it here and the snapshot only ever moves the arc.
 */
const BAND_HALF = 0.05;

export interface FixtureInstall {
  /** Authored panel prop id, e.g. `node-beta-panel-breaker`. */
  readonly propId: string;
  readonly module: ModuleId;
  readonly kind: FixtureKind;
  /** Keyswitch a/b → 0/1, undock lever 1..3 → 0..2, otherwise 0. */
  readonly index: number;
  /** Fixture frame → world. +X across the wall, +Y up, +Z out of the wall. */
  readonly world: THREE.Matrix4;
  readonly fixture: PuzzleFixture;
}

/** One plain-mesh part: a mount holding the install transform, a joint holding
 *  the angle, and the module it is culled with. */
interface Pivot {
  readonly module: ModuleId;
  readonly mount: THREE.Object3D;
  readonly joint: THREE.Object3D;
}

export class StationFixtures {
  /** Add to the station group. Everything inside is in WORLD space. */
  readonly group = new THREE.Group();
  readonly installs: FixtureInstall[] = [];

  private readonly byProp = new Map<string, FixtureInstall>();
  private readonly byKind = new Map<FixtureKind, FixtureInstall[]>();
  private readonly statics: Array<{ module: ModuleId; mesh: THREE.Mesh }> = [];
  private readonly partSets: FixturePartSet[] = [];
  private readonly pivots: Pivot[] = [];
  private readonly accents: InstancedSet | null;

  constructor(layout: StationLayout, materials: StationMaterials) {
    this.group.name = 'station-fixtures';

    // Per-module static geometry, in MODULE space: the merged mesh then carries
    // the module transform, which keeps vertex coordinates small and lets the
    // culler switch one object rather than walk a subtree.
    const staticParts = new Map<ModuleId, THREE.BufferGeometry[]>();
    const accentSpots: AccentPlacement[] = [];

    // Slot lists for the three parts that repeat. Collected first, because a
    // `FixturePartSet` is sized by how many slots it will ever have.
    const leverSlots: FixtureSlot[] = [];
    const coverSlots: FixtureSlot[] = [];
    const throwSlots: FixtureSlot[] = [];
    /** install → its first lever slot; the six are contiguous. */
    const leverBase = new Map<FixtureInstall, number>();
    const coverSlotOf = new Map<FixtureInstall, number>();
    const throwSlotOf = new Map<FixtureInstall, number>();

    for (const module of layout.modules) {
      const mMatrix = moduleMatrix(module);
      for (const prop of module.props) {
        if (prop.kind !== 'panel') continue;
        const role = fixtureRoleOf(prop.id);

        // The fixture frame is RECOVERED from world up rather than assumed from
        // the authoring convention — see `fixtureBasis`. Two panels in this level
        // are authored with their prop-local +X pointing down, and a comb of
        // levers installed upside down is the bug that buys.
        const panelLocal = propMatrix(prop);
        const panelWorld = new THREE.Matrix4().multiplyMatrices(mMatrix, panelLocal);
        const basis = new THREE.Matrix4().makeRotationFromQuaternion(fixtureBasis(panelWorld));
        const fixtureLocal = new THREE.Matrix4().multiplyMatrices(panelLocal, basis);
        const world = new THREE.Matrix4().multiplyMatrices(mMatrix, fixtureLocal);

        let parts = staticParts.get(module.id);
        if (!parts) {
          parts = [];
          staticParts.set(module.id, parts);
        }
        parts.push(panelShellGeometry(role.labelBars).applyMatrix4(fixtureLocal));
        const hardware = fixtureStaticGeometry(role.kind);
        if (hardware) parts.push(hardware.applyMatrix4(fixtureLocal));

        const spot = fixtureAccent(role.kind);
        accentSpots.push({
          module: module.id,
          interact: role.interact,
          matrix: accentMatrix(spot.at, spot.normal, world),
        });

        const install: FixtureInstall = {
          propId: prop.id,
          module: module.id,
          kind: role.kind,
          index: role.index,
          world,
          fixture: new PuzzleFixture(role.kind, role.index, module.id),
        };
        this.installs.push(install);
        this.byProp.set(prop.id, install);
        const kin = this.byKind.get(role.kind);
        if (kin) kin.push(install);
        else this.byKind.set(role.kind, [install]);

        switch (role.kind) {
          case 'breaker':
            leverBase.set(install, leverSlots.length);
            for (let i = 0; i < BREAKER.leverCount; i++) {
              leverSlots.push({ module: module.id, base: at(world, breakerLeverPivot(i)) });
            }
            break;
          case 'undock':
            coverSlotOf.set(install, coverSlots.length);
            coverSlots.push({ module: module.id, base: at(world, UNDOCK.coverPivot) });
            throwSlotOf.set(install, throwSlots.length);
            throwSlots.push({ module: module.id, base: at(world, UNDOCK.leverPivot) });
            break;
          default:
            break;
        }
      }
    }

    // -- the static half, one mesh per module -------------------------------
    for (const module of layout.modules) {
      const parts = staticParts.get(module.id);
      if (!parts || parts.length === 0) continue;
      const mesh = new THREE.Mesh(mergeParts(parts), materials.hazard);
      mesh.name = `fixtures-${module.id}`;
      mesh.applyMatrix4(moduleMatrix(module));
      mesh.receiveShadow = true;
      this.statics.push({ module: module.id, mesh });
      this.group.add(mesh);
    }

    // -- the parts that repeat ---------------------------------------------
    const levers = this.addSet('fixture-breaker-levers', breakerLeverGeometry(), materials.aluminium, leverSlots);
    const covers = this.addSet('fixture-undock-covers', undockCoverGeometry(), materials.hazard, coverSlots);
    const throws = this.addSet('fixture-undock-levers', undockLeverGeometry(), materials.aluminium, throwSlots);

    // -- the parts that exist once, plus every joint's sink -----------------
    for (const install of this.installs) {
      const f = install.fixture;
      switch (install.kind) {
        case 'breaker': {
          const base = leverBase.get(install) ?? 0;
          for (let i = 0; i < BREAKER.leverCount; i++) {
            const slot = base + i;
            f.addLever((angle) => levers?.setAngle(slot, angle));
          }
          const override = this.addPivot(install, BREAKER.overridePivot, breakerOverrideGeometry(), materials.aluminium, 'fixture-breaker-override');
          f.addOverride((angle) => {
            override.joint.rotation.x = angle;
          });
          break;
        }
        case 'valve': {
          const wheel = this.addPivot(install, VALVE.centre, valveWheelGeometry(), materials.brass, 'fixture-valve-wheel');
          f.addWheel((angle) => {
            wheel.joint.rotation.z = angle;
          });
          break;
        }
        case 'gauge': {
          const needle = this.addPivot(
            install,
            { x: GAUGE.centre.x, y: GAUGE.centre.y, z: GAUGE.needleZ },
            gaugeNeedleGeometry(),
            materials.aluminium,
            'fixture-gauge-needle',
          );
          f.addNeedle((angle) => {
            needle.joint.rotation.z = angle;
          });
          const band = this.addPivot(
            install,
            { x: GAUGE.centre.x, y: GAUGE.centre.y, z: GAUGE.bandZ },
            gaugeBandGeometry(BAND_HALF),
            materials.indicatorFor('green'),
            'fixture-gauge-band',
          );
          f.addBand((angle) => {
            band.joint.rotation.z = angle;
          });
          break;
        }
        case 'keyswitch': {
          const key = this.addPivot(install, KEYSWITCH.keyAt, keyswitchKeyGeometry(), materials.brass, 'fixture-keyswitch-key');
          f.addKey((angle) => {
            key.joint.rotation.z = angle;
          });
          break;
        }
        case 'undock': {
          const cover = coverSlotOf.get(install) ?? 0;
          f.addCover((angle) => covers?.setAngle(cover, angle));
          const thrown = throwSlotOf.get(install) ?? 0;
          f.addThrow((angle) => throws?.setAngle(thrown, angle));
          break;
        }
        default:
          break;
      }
    }

    this.accents =
      accentSpots.length > 0
        ? buildAccentInstances(materials, accentSpots, { shape: 'dot', name: 'fixture-accents' })
        : null;
    if (this.accents) this.group.add(this.accents.mesh);

    // Pose everything to its rest state before the first frame, and flush the
    // instance buffers the joints just wrote into.
    for (const install of this.installs) install.fixture.tick(1);
    this.flush();
  }

  /** Draw calls this subsystem can submit. */
  get meshCount(): number {
    return this.statics.length + this.partSets.length + this.pivots.length + (this.accents ? 1 : 0);
  }

  fixture(propId: string): PuzzleFixture | null {
    return this.byProp.get(propId)?.fixture ?? null;
  }

  ofKind(kind: FixtureKind): readonly FixtureInstall[] {
    return this.byKind.get(kind) ?? EMPTY;
  }

  // -- state in ------------------------------------------------------------
  //
  // The state shapes are the structural ones `puzzleProps.ts` declares, so
  // `src/station` still knows nothing about `src/puzzles` — the caller hands us
  // the fields and nothing else crosses.

  setBreaker(state: BreakerFixtureState, nowMs: number): void {
    for (const install of this.ofKind('breaker')) install.fixture.applyBreaker(state, nowMs);
  }

  setValve(state: ValveFixtureState): void {
    for (const install of this.ofKind('valve')) install.fixture.applyValve(state);
  }

  setGauge(state: GaugeFixtureState): void {
    for (const install of this.ofKind('gauge')) install.fixture.applyGauge(state);
  }

  /** `index` is 0 for keyswitch a, 1 for b — `FixtureRole.index`. */
  setKeyswitch(index: number, turned: boolean): void {
    for (const install of this.ofKind('keyswitch')) {
      if (install.index === index) install.fixture.applyKeyswitch(turned);
    }
  }

  /**
   * The finale (§11 puzzle 6). `armed` opens all three red covers at once —
   * that is the station announcing four systems are online — and `engaged` is
   * per lever, indexed by `FixtureRole.index`.
   */
  setUndock(armed: boolean, engaged: readonly boolean[]): void {
    for (const install of this.ofKind('undock')) {
      install.fixture.applyUndock(armed, engaged[install.index] === true);
    }
  }

  /** Every joint back to its rest pose — a new round, or a disconnect. */
  reset(): void {
    for (const install of this.installs) install.fixture.reset();
  }

  // -- per-frame -----------------------------------------------------------

  /** Advance every joint. Call once a frame with real seconds. */
  tick(dt: number): void {
    if (dt <= 0) return;
    let moved = false;
    for (const install of this.installs) {
      if (install.fixture.tick(dt)) moved = true;
    }
    if (moved) this.flush();
  }

  setVisible(visible: ReadonlySet<ModuleId>): void {
    for (const entry of this.statics) entry.mesh.visible = visible.has(entry.module);
    for (const pivot of this.pivots) pivot.mount.visible = visible.has(pivot.module);
    for (const set of this.partSets) set.setVisibleModules(visible);
    this.accents?.setVisible(visible);
    this.flush();
  }

  dispose(): void {
    for (const entry of this.statics) {
      this.group.remove(entry.mesh);
      entry.mesh.geometry.dispose();
    }
    for (const pivot of this.pivots) {
      this.group.remove(pivot.mount);
      pivot.mount.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.geometry.dispose();
      });
    }
    for (const set of this.partSets) {
      this.group.remove(set.mesh);
      set.dispose();
    }
    if (this.accents) {
      this.group.remove(this.accents.mesh);
      this.accents.dispose();
    }
    this.statics.length = 0;
    this.pivots.length = 0;
    this.partSets.length = 0;
    this.installs.length = 0;
    this.byProp.clear();
    this.byKind.clear();
  }

  // -- internals -----------------------------------------------------------

  private flush(): void {
    for (const set of this.partSets) set.flush();
  }

  /** A `FixturePartSet`, or null when this level has none of that fixture. */
  private addSet(
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    slots: readonly FixtureSlot[],
  ): FixturePartSet | null {
    if (slots.length === 0) {
      geometry.dispose();
      return null;
    }
    const set = new FixturePartSet(name, geometry, material, slots);
    this.partSets.push(set);
    this.group.add(set.mesh);
    return set;
  }

  private addPivot(
    install: FixtureInstall,
    localPivot: { x: number; y: number; z: number },
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    name: string,
  ): Pivot {
    const mount = new THREE.Object3D();
    mount.name = `${name}-${install.propId}`;
    mount.applyMatrix4(at(install.world, localPivot));
    const joint = new THREE.Object3D();
    joint.name = 'joint';
    mount.add(joint);

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    // §9 budgets ONE shadow map. A 15 cm lever arm is not what it is for, and
    // `applyShadowPolicy` is subtractive — it will never put this back.
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.userData.noShadow = true;
    mesh.userData.noCollide = true;
    joint.add(mesh);

    this.group.add(mount);
    const pivot: Pivot = { module: install.module, mount, joint };
    this.pivots.push(pivot);
    return pivot;
  }
}

const EMPTY: readonly FixtureInstall[] = Object.freeze([]);

/** `parent` translated by a fixture-frame offset. Fresh matrix — these are all
 *  built once, at load. */
function at(parent: THREE.Matrix4, offset: { x: number; y: number; z: number }): THREE.Matrix4 {
  return new THREE.Matrix4()
    .multiplyMatrices(parent, new THREE.Matrix4().makeTranslation(offset.x, offset.y, offset.z));
}
