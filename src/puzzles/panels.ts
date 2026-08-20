/**
 * In-world puzzle panels (DESIGN.md §6, §11).
 *
 * "Puzzle panels rendered in-world — but as `CanvasTexture` … These are gauges,
 * needles and breakers: draw them with the 2D canvas API and update at 10 Hz
 * only while a player is in the module."
 *
 * The UI agent owns the housing, the throttle and the texture upload
 * (`src/ui/panel.ts`); this file owns what is printed on the glass. Seven panels
 * for six puzzles — the coolant valve gets two, in two different modules, and
 * the fact that they can never be read at the same time is the entire puzzle.
 *
 * Every panel doubles as the tutorial for its own noise cost: the loudness of
 * each control is stencilled next to it, because "the player must always be
 * able to answer 'was that loud?'" (pillar 1) and the alternative is a wiki.
 */

import type { ModuleId, PuzzleId, Quat, StationLayout, Vec3 } from '@shared/types';
import {
  BREAKER_COUNT,
  BREAKER_OVERRIDE_TIME_S,
  FUSE_COUNT,
  LOUDNESS,
  SYSTEMS_TO_ESCAPE,
  UNDOCK_HOLD_S,
} from '@shared/constants';
import { localToWorld } from '@shared/graph/math';
import {
  Panel,
  PanelSystem,
  UI_COLORS,
  panelBar,
  panelGauge,
  panelLamp,
  panelSwitch,
  panelText,
  type PanelFrame,
} from '../ui';
import {
  cargoSlotIndex,
  jamProgress01,
  keyswitchSide,
  puzzlePropRole,
  PUZZLE_PROP_KINDS,
  VALVE_WHEEL_TURNS,
} from './logic/index';
import { puzzleStore, type PuzzleStore } from './store';
import type {
  BreakerPanelState,
  CargoPanelState,
  CoolantPanelState,
  FusePanelState,
  KeyswitchPanelState,
  UndockPanelState,
} from './types';

// ---------------------------------------------------------------------------
// Shared drawing helpers
// ---------------------------------------------------------------------------

type Nullable<T> = T | null;

const OFF = 'rgba(255,255,255,0.06)';

function inset(frame: PanelFrame): { x: number; y: number; w: number; h: number } {
  const pad = Math.round(frame.width * 0.055);
  const top = Math.round(frame.height * 0.16); // clear of the bezel's title
  return { x: pad, y: top, w: frame.width - pad * 2, h: frame.height - top - pad };
}

/** No snapshot yet — the panel is powered but the bus has not reached it. */
function drawOffline(ctx: CanvasRenderingContext2D, frame: PanelFrame, label: string): void {
  const box = inset(frame);
  panelText(ctx, label, frame.width / 2, box.y + box.h * 0.42, {
    size: Math.max(11, frame.height * 0.06),
    color: UI_COLORS.textDim,
    align: 'center',
    baseline: 'middle',
  });
  panelText(ctx, 'NO SIGNAL', frame.width / 2, box.y + box.h * 0.62, {
    size: Math.max(9, frame.height * 0.045),
    color: UI_COLORS.amberDim,
    align: 'center',
    baseline: 'middle',
  });
}

/** Stencil a loudness number next to a control. Pillar 1, in three words. */
function loudTag(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  loudness: number,
  size: number,
): void {
  panelText(ctx, `${text} ${loudness}`, x, y, {
    size,
    color: loudness >= 45 ? UI_COLORS.red : loudness >= 15 ? UI_COLORS.amber : UI_COLORS.green,
    align: 'center',
    baseline: 'middle',
  });
}

function solvedStamp(ctx: CanvasRenderingContext2D, frame: PanelFrame, text = 'ONLINE'): void {
  const box = inset(frame);
  ctx.save();
  ctx.globalAlpha = 0.9;
  panelText(ctx, text, frame.width / 2, box.y + box.h * 0.5, {
    size: Math.max(16, frame.height * 0.11),
    color: UI_COLORS.green,
    align: 'center',
    baseline: 'middle',
    bold: true,
    glow: true,
  });
  ctx.restore();
}

// ---------------------------------------------------------------------------
// 1 · Breaker sequence
// ---------------------------------------------------------------------------

export function drawBreakerPanel(
  ctx: CanvasRenderingContext2D,
  state: Nullable<BreakerPanelState>,
  frame: PanelFrame,
): void {
  if (!state) return drawOffline(ctx, frame, 'MAIN BUS');
  const box = inset(frame);
  const small = Math.max(9, frame.height * 0.042);

  // --- the card line: the whole puzzle, in one sentence ---------------------
  if (state.sequence) {
    panelText(ctx, `ORDER  ${state.sequence.map((n) => n + 1).join(' · ')}`, box.x, box.y, {
      size: small,
      color: UI_COLORS.green,
      baseline: 'top',
      glow: true,
    });
  } else {
    const where = state.card.module ? `LOCKER · ${state.card.module.toUpperCase()}` : 'LOCKER UNKNOWN';
    panelText(ctx, `ORDER CARD MISSING — ${where}`, box.x, box.y, {
      size: small,
      color: UI_COLORS.amber,
      baseline: 'top',
    });
  }

  // --- six breakers --------------------------------------------------------
  const n = state.switches.length || BREAKER_COUNT;
  const gap = box.w * 0.02;
  const sw = (box.w - gap * (n - 1)) / n;
  const sh = box.h * 0.34;
  const sy = box.y + box.h * 0.16;
  for (let i = 0; i < n; i++) {
    panelSwitch(ctx, {
      x: box.x + i * (sw + gap),
      y: sy,
      w: sw,
      h: sh,
      on: state.switches[i] === true,
      label: String(i + 1),
    });
  }

  // --- progress and faults -------------------------------------------------
  const rowY = sy + sh + box.h * 0.14;
  for (let i = 0; i < n; i++) {
    panelLamp(
      ctx,
      box.x + sw / 2 + i * (sw + gap),
      rowY,
      Math.max(2.5, box.w * 0.012),
      i < state.progress,
      UI_COLORS.green,
    );
  }
  const faulted = state.faultUntilMs > Date.now();
  panelText(
    ctx,
    faulted ? 'SEQUENCE FAULT' : `${state.progress}/${n}   FAULTS ${state.faults}`,
    box.x + box.w,
    rowY,
    {
      size: small,
      color: faulted ? UI_COLORS.red : UI_COLORS.textDim,
      align: 'right',
      baseline: 'middle',
      glow: faulted,
    },
  );
  loudTag(ctx, 'THROW', box.x + box.w * 0.16, rowY, LOUDNESS.BREAKER, small);
  loudTag(ctx, 'FAULT', box.x + box.w * 0.46, rowY, LOUDNESS.BREAKER_RESET, small);

  // --- the quiet path ------------------------------------------------------
  const barY = box.y + box.h * 0.78;
  const barH = box.h * 0.14;
  panelBar(ctx, {
    x: box.x,
    y: barY,
    w: box.w,
    h: barH,
    value: state.override.progress01,
    color: state.override.holder ? UI_COLORS.green : UI_COLORS.greenDim,
    segments: BREAKER_OVERRIDE_TIME_S,
  });
  const held = state.override.holder !== null;
  panelText(
    ctx,
    held
      ? `MANUAL OVERRIDE  ${(state.override.required - state.override.seconds).toFixed(0)} s`
      : `MANUAL OVERRIDE  HOLD ${BREAKER_OVERRIDE_TIME_S} s  ·  ${LOUDNESS.HAND_PUMP}`,
    box.x + box.w / 2,
    barY + barH + small * 0.9,
    { size: small, color: UI_COLORS.textDim, align: 'center', baseline: 'middle' },
  );

  if (state.solved) solvedStamp(ctx, frame, 'MAIN BUS ONLINE');
}

// ---------------------------------------------------------------------------
// 2 · Coolant valve — the gauge half (module A, no valve)
// ---------------------------------------------------------------------------

/** Needle 0–1 → the kPa a human reads out loud over voice comms. */
export function coolantPressure(needle: number): number {
  return 40 + needle * 260;
}

export function drawCoolantGaugePanel(
  ctx: CanvasRenderingContext2D,
  state: Nullable<CoolantPanelState>,
  frame: PanelFrame,
): void {
  if (!state) return drawOffline(ctx, frame, 'COOLANT LOOP');
  const box = inset(frame);
  const small = Math.max(9, frame.height * 0.042);
  const radius = Math.min(box.w * 0.3, box.h * 0.42);

  panelGauge(ctx, {
    x: box.x + box.w * 0.34,
    y: box.y + box.h * 0.46,
    radius,
    value: state.needle,
    min: 0,
    max: 1,
    band: [state.target - state.bandHalf, state.target + state.bandHalf],
    label: 'LOOP PRESSURE',
    readout: `${coolantPressure(state.needle).toFixed(0)} kPa`,
  });

  // --- what to shout through the bulkhead ----------------------------------
  const delta = state.target - state.needle;
  const call = state.inBand ? 'HOLD' : delta > 0 ? 'OPEN' : 'CLOSE';
  const callColor = state.inBand ? UI_COLORS.green : UI_COLORS.amber;
  const cx = box.x + box.w * 0.78;
  panelText(ctx, 'CALL', cx, box.y + box.h * 0.16, {
    size: small,
    color: UI_COLORS.textDim,
    align: 'center',
    baseline: 'middle',
  });
  panelText(ctx, call, cx, box.y + box.h * 0.34, {
    size: Math.max(16, frame.height * 0.11),
    color: callColor,
    align: 'center',
    baseline: 'middle',
    bold: true,
    glow: true,
  });

  // --- the two-second lock -------------------------------------------------
  const barY = box.y + box.h * 0.58;
  panelBar(ctx, {
    x: box.x + box.w * 0.6,
    y: barY,
    w: box.w * 0.36,
    h: box.h * 0.1,
    value: state.holdRequired > 0 ? state.holdSeconds / state.holdRequired : 0,
    color: UI_COLORS.green,
    label: 'SEAL',
  });
  panelText(ctx, 'HOLD IN GREEN', cx, barY + box.h * 0.2, {
    size: small,
    color: UI_COLORS.textDim,
    align: 'center',
    baseline: 'middle',
  });

  panelText(ctx, 'NO VALVE FITTED — VALVE IS IN ANOTHER MODULE', frame.width / 2, box.y + box.h, {
    size: small,
    color: UI_COLORS.amberDim,
    align: 'center',
    baseline: 'bottom',
  });

  if (state.solved) solvedStamp(ctx, frame, 'COOLANT ONLINE');
}

// ---------------------------------------------------------------------------
// 2 · Coolant valve — the wheel half (module B, no gauge)
// ---------------------------------------------------------------------------

export function drawCoolantValvePanel(
  ctx: CanvasRenderingContext2D,
  state: Nullable<CoolantPanelState>,
  frame: PanelFrame,
): void {
  if (!state) return drawOffline(ctx, frame, 'COOLANT VALVE');
  const box = inset(frame);
  const small = Math.max(9, frame.height * 0.042);

  // --- the wheel -----------------------------------------------------------
  const cx = box.x + box.w * 0.3;
  const cy = box.y + box.h * 0.45;
  const r = Math.min(box.w * 0.26, box.h * 0.38);
  const angle = state.value * VALVE_WHEEL_TURNS * Math.PI * 2;
  const spinning = state.turnDir !== 0 && state.turnFast;
  const colour = spinning ? UI_COLORS.red : state.turnDir !== 0 ? UI_COLORS.amber : UI_COLORS.green;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(2, r * 0.1);
  if (spinning) {
    ctx.shadowColor = colour;
    ctx.shadowBlur = r * 0.5;
  }
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  ctx.stroke();
  ctx.restore();

  panelText(ctx, `${(state.value * VALVE_WHEEL_TURNS).toFixed(1)} TURNS`, cx, cy + r + small * 1.4, {
    size: small,
    color: UI_COLORS.textDim,
    align: 'center',
    baseline: 'middle',
  });

  // --- the four buttons: the loud-fast / quiet-slow rule as hardware --------
  const bx = box.x + box.w * 0.6;
  const bw = box.w * 0.36;
  const bh = box.h * 0.15;
  const rows: Array<[string, number, boolean]> = [
    ['OPEN  FAST', LOUDNESS.VALVE_FAST, state.turnDir === 1 && state.turnFast],
    ['OPEN  SLOW', LOUDNESS.VALVE_SLOW, state.turnDir === 1 && !state.turnFast],
    ['CLOSE SLOW', LOUDNESS.VALVE_SLOW, state.turnDir === -1 && !state.turnFast],
    ['CLOSE FAST', LOUDNESS.VALVE_FAST, state.turnDir === -1 && state.turnFast],
  ];
  rows.forEach(([label, loud, active], i) => {
    const y = box.y + box.h * 0.06 + i * (bh + box.h * 0.04);
    ctx.save();
    ctx.fillStyle = active ? 'rgba(77,255,155,0.14)' : 'rgba(0,0,0,0.5)';
    ctx.fillRect(bx, y, bw, bh);
    ctx.strokeStyle = active ? UI_COLORS.green : UI_COLORS.line;
    ctx.lineWidth = active ? 2 : 1;
    ctx.strokeRect(bx, y, bw, bh);
    ctx.restore();
    panelText(ctx, label, bx + bw * 0.06, y + bh / 2, {
      size: small,
      color: active ? UI_COLORS.green : UI_COLORS.text,
      baseline: 'middle',
    });
    panelText(ctx, String(loud), bx + bw * 0.94, y + bh / 2, {
      size: small,
      color: loud >= 40 ? UI_COLORS.red : UI_COLORS.green,
      align: 'right',
      baseline: 'middle',
    });
  });

  panelText(ctx, 'NO GAUGE FITTED — ASK THEM', frame.width / 2, box.y + box.h, {
    size: small,
    color: UI_COLORS.amberDim,
    align: 'center',
    baseline: 'bottom',
  });

  if (state.solved) solvedStamp(ctx, frame, 'COOLANT ONLINE');
}

// ---------------------------------------------------------------------------
// 3 · Cargo stow
// ---------------------------------------------------------------------------

export function drawCargoPanel(
  ctx: CanvasRenderingContext2D,
  state: Nullable<CargoPanelState>,
  frame: PanelFrame,
): void {
  if (!state) return drawOffline(ctx, frame, 'BALLAST TRIM');
  const box = inset(frame);
  const small = Math.max(9, frame.height * 0.042);

  panelText(ctx, 'RACK MANIFEST', box.x, box.y, {
    size: small,
    color: UI_COLORS.textDim,
    baseline: 'top',
  });

  const n = state.bags.length || 5;
  const slotW = box.w / n;
  const slotY = box.y + box.h * 0.22;
  const slotH = box.h * 0.4;
  state.bags.forEach((bag, i) => {
    const x = box.x + i * slotW + slotW * 0.1;
    const w = slotW * 0.8;
    ctx.save();
    ctx.fillStyle = bag.stowed ? 'rgba(77,255,155,0.16)' : OFF;
    ctx.fillRect(x, slotY, w, slotH);
    ctx.strokeStyle = bag.stowed ? UI_COLORS.green : UI_COLORS.line;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, slotY, w, slotH);
    ctx.restore();
    panelText(ctx, String(i + 1), x + w / 2, slotY + slotH / 2, {
      size: Math.max(12, slotH * 0.4),
      color: bag.stowed ? UI_COLORS.green : UI_COLORS.textDim,
      align: 'center',
      baseline: 'middle',
      bold: true,
    });
  });

  panelBar(ctx, {
    x: box.x,
    y: box.y + box.h * 0.7,
    w: box.w,
    h: box.h * 0.12,
    value: state.required > 0 ? state.stowedCount / state.required : 0,
    color: UI_COLORS.green,
    label: `${state.stowedCount}/${state.required}`,
  });

  panelText(
    ctx,
    `MOVE THEM GENTLY — EVERY BOUNCE IS ${LOUDNESS.CARGO_BOUNCE}`,
    frame.width / 2,
    box.y + box.h,
    { size: small, color: UI_COLORS.amber, align: 'center', baseline: 'bottom' },
  );

  if (state.solved) solvedStamp(ctx, frame, 'BALLAST ONLINE');
}

// ---------------------------------------------------------------------------
// 4 · Fuse hunt
// ---------------------------------------------------------------------------

export function drawFusePanel(
  ctx: CanvasRenderingContext2D,
  state: Nullable<FusePanelState>,
  frame: PanelFrame,
): void {
  if (!state) return drawOffline(ctx, frame, 'COMMS ARRAY');
  const box = inset(frame);
  const small = Math.max(9, frame.height * 0.042);

  // --- three sockets -------------------------------------------------------
  const n = state.sockets.length || FUSE_COUNT;
  const sw = box.w / n;
  const sy = box.y + box.h * 0.06;
  const sh = box.h * 0.3;
  state.sockets.forEach((socket, i) => {
    const x = box.x + i * sw + sw * 0.15;
    const w = sw * 0.7;
    ctx.save();
    ctx.fillStyle = socket.filled ? 'rgba(77,255,155,0.18)' : OFF;
    ctx.fillRect(x, sy, w, sh);
    ctx.strokeStyle = socket.filled ? UI_COLORS.green : UI_COLORS.amberDim;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, sy, w, sh);
    ctx.restore();
    panelText(ctx, socket.filled ? 'OK' : 'BLOWN', x + w / 2, sy + sh / 2, {
      size: small,
      color: socket.filled ? UI_COLORS.green : UI_COLORS.amber,
      align: 'center',
      baseline: 'middle',
      bold: true,
    });
  });

  // --- the manifest: where the spares are, which is the whole puzzle --------
  panelText(ctx, 'SPARES', box.x, sy + sh + box.h * 0.08, {
    size: small,
    color: UI_COLORS.textDim,
    baseline: 'middle',
  });
  state.fuses.forEach((fuse, i) => {
    const y = sy + sh + box.h * (0.2 + i * 0.14);
    const status = fuse.installed
      ? 'SEATED'
      : fuse.carriedBy
        ? 'CARRIED'
        : fuse.jam.jammed
          ? `JAMMED ${(jamProgress01(fuse.jam) * 100).toFixed(0)}%`
          : fuse.module.toUpperCase();
    panelText(ctx, `${i + 1}·${fuse.locker}`, box.x, y, {
      size: small,
      color: UI_COLORS.text,
      baseline: 'middle',
    });
    panelText(ctx, status, box.x + box.w, y, {
      size: small,
      color: fuse.installed ? UI_COLORS.green : fuse.jam.jammed ? UI_COLORS.red : UI_COLORS.amber,
      align: 'right',
      baseline: 'middle',
    });
  });

  if (state.solved) solvedStamp(ctx, frame, 'COMMS ONLINE');
}

// ---------------------------------------------------------------------------
// 5 · Airlock keyswitch
// ---------------------------------------------------------------------------

export function drawKeyswitchPanel(
  ctx: CanvasRenderingContext2D,
  state: Nullable<KeyswitchPanelState>,
  frame: PanelFrame,
): void {
  if (!state) return drawOffline(ctx, frame, 'AIRLOCK CTRL');
  const box = inset(frame);
  const small = Math.max(9, frame.height * 0.042);
  const now = Date.now();
  const windowMs = state.windowS * 1000;

  state.switches.forEach((key, i) => {
    const cx = box.x + box.w * (i === 0 ? 0.25 : 0.75);
    const cy = box.y + box.h * 0.34;
    const live = key.turnedAtMs !== null && now - key.turnedAtMs <= windowMs;
    panelLamp(ctx, cx, cy, Math.min(box.w, box.h) * 0.09, live, UI_COLORS.green);
    panelText(ctx, `KEY ${key.id.toUpperCase()}`, cx, cy + box.h * 0.2, {
      size: small,
      color: live ? UI_COLORS.green : UI_COLORS.textDim,
      align: 'center',
      baseline: 'middle',
      bold: true,
    });
    if (live && key.turnedAtMs !== null) {
      const left = Math.max(0, (windowMs - (now - key.turnedAtMs)) / 1000);
      panelText(ctx, `${left.toFixed(1)} s`, cx, cy + box.h * 0.32, {
        size: small,
        color: UI_COLORS.amber,
        align: 'center',
        baseline: 'middle',
      });
    }
  });

  panelText(
    ctx,
    `BOTH KEYS WITHIN ${state.windowS.toFixed(1)} s  ·  ${state.separationM} m APART`,
    frame.width / 2,
    box.y + box.h * 0.72,
    { size: small, color: UI_COLORS.text, align: 'center', baseline: 'middle' },
  );
  loudTag(ctx, 'ACTIVATION', frame.width / 2, box.y + box.h * 0.86, LOUDNESS.KEYSWITCH, small);
  if (state.misses > 0 && !state.solved) {
    panelText(ctx, `MISSED ${state.misses}`, box.x + box.w, box.y, {
      size: small,
      color: UI_COLORS.amberDim,
      align: 'right',
      baseline: 'top',
    });
  }

  if (state.solved) solvedStamp(ctx, frame, 'AIRLOCK ONLINE');
}

// ---------------------------------------------------------------------------
// 6 · Undock sequence
// ---------------------------------------------------------------------------

export function drawUndockPanel(
  ctx: CanvasRenderingContext2D,
  state: Nullable<UndockPanelState>,
  frame: PanelFrame,
): void {
  if (!state) return drawOffline(ctx, frame, 'UNDOCK');
  const box = inset(frame);
  const small = Math.max(9, frame.height * 0.042);

  panelText(
    ctx,
    state.armed ? 'LEVERS ARMED' : `SAFE — ${state.systemsRequired} SYSTEMS REQUIRED`,
    box.x,
    box.y,
    {
      size: small,
      color: state.armed ? UI_COLORS.green : UI_COLORS.amber,
      baseline: 'top',
      glow: state.armed,
    },
  );

  state.levers.forEach((lever, i) => {
    const cx = box.x + box.w * (0.18 + i * 0.32);
    const cy = box.y + box.h * 0.36;
    panelLamp(ctx, cx, cy, Math.min(box.w, box.h) * 0.075, lever.engaged, UI_COLORS.green);
    panelText(ctx, lever.module.toUpperCase(), cx, cy + box.h * 0.19, {
      size: small,
      color: lever.engaged ? UI_COLORS.green : UI_COLORS.textDim,
      align: 'center',
      baseline: 'middle',
    });
  });

  panelBar(ctx, {
    x: box.x,
    y: box.y + box.h * 0.62,
    w: box.w,
    h: box.h * 0.14,
    value: state.required > 0 ? state.progress / state.required : 0,
    color: state.progress > 0 ? UI_COLORS.red : UI_COLORS.greenDim,
    segments: UNDOCK_HOLD_S,
    label: `${state.engagedCount}/${state.levers.length}`,
  });

  panelText(
    ctx,
    state.undocked
      ? 'UNDOCKED — GET TO THE CAPSULE'
      : `ALL THREE, ${UNDOCK_HOLD_S} SECONDS  ·  ${LOUDNESS.UNDOCK_LEVER}`,
    frame.width / 2,
    box.y + box.h,
    {
      size: small,
      color: state.undocked ? UI_COLORS.green : UI_COLORS.red,
      align: 'center',
      baseline: 'bottom',
      bold: state.undocked,
    },
  );
}

// ---------------------------------------------------------------------------
// Panel specs — which panel, in which module, drawing which puzzle
// ---------------------------------------------------------------------------

export interface PuzzlePanelSpec {
  /** Panel id, unique station-wide. Also the key in the returned map. */
  key: string;
  puzzle: PuzzleId;
  title: string;
  module: ModuleId;
  /** Plane size in metres. Defaults to 0.7 × 0.5. */
  width?: number;
  height?: number;
  position?: Vec3;
  quaternion?: Quat;
  draw: (ctx: CanvasRenderingContext2D, state: never, frame: PanelFrame) => void;
  /** Clickable rects, in fractions of the canvas — resolved after creation. */
  regions?: Array<{ id: string; x: number; y: number; w: number; h: number }>;
}

/** Puzzle roles → panels. Resolved with `puzzlePropRole()`, the same function
 *  `server/sim/puzzles.ts` places and routes with, so both sides agree about
 *  which panel is which regardless of how the layout tags its props. */
const PANEL_PROP_KINDS: Record<string, { puzzle: PuzzleId; suffix: string }> = {
  'panel-breaker': { puzzle: 'breaker-sequence', suffix: '' },
  'panel-gauge': { puzzle: 'coolant-valve', suffix: 'gauge' },
  'panel-valve': { puzzle: 'coolant-valve', suffix: 'wheel' },
  'cargo-rack': { puzzle: 'cargo-stow', suffix: '' },
  'panel-fusebox': { puzzle: 'fuse-hunt', suffix: '' },
  'panel-keyswitch': { puzzle: 'airlock-keyswitch', suffix: '' },
  'panel-undock': { puzzle: 'undock-sequence', suffix: '' },
};

/** Region layouts, in canvas fractions, keyed by the drawing used. */
const REGIONS: Record<string, PuzzlePanelSpec['regions']> = {
  'breaker-sequence': [
    ...Array.from({ length: BREAKER_COUNT }, (_, i) => ({
      id: `breaker-${i}`,
      x: 0.055 + i * (0.89 / BREAKER_COUNT),
      y: 0.29,
      w: 0.89 / BREAKER_COUNT - 0.01,
      h: 0.29,
    })),
    { id: 'override', x: 0.055, y: 0.78, w: 0.89, h: 0.12 },
  ],
  'coolant-valve:gauge': [{ id: 'valve-lock', x: 0.6, y: 0.62, w: 0.36, h: 0.09 }],
  'coolant-valve:wheel': [
    { id: 'valve-open-fast', x: 0.6, y: 0.2, w: 0.36, h: 0.12 },
    { id: 'valve-open-slow', x: 0.6, y: 0.35, w: 0.36, h: 0.12 },
    { id: 'valve-close-slow', x: 0.6, y: 0.5, w: 0.36, h: 0.12 },
    { id: 'valve-close-fast', x: 0.6, y: 0.65, w: 0.36, h: 0.12 },
  ],
  'airlock-keyswitch:a': [{ id: 'key-a', x: 0.08, y: 0.24, w: 0.38, h: 0.34 }],
  'airlock-keyswitch:b': [{ id: 'key-b', x: 0.54, y: 0.24, w: 0.38, h: 0.34 }],
  'airlock-keyswitch': [
    { id: 'key-a', x: 0.08, y: 0.24, w: 0.38, h: 0.34 },
    { id: 'key-b', x: 0.54, y: 0.24, w: 0.38, h: 0.34 },
  ],
  'fuse-hunt': [{ id: 'install', x: 0.055, y: 0.16, w: 0.89, h: 0.3 }],
  'undock-sequence': [{ id: 'lever', x: 0.055, y: 0.24, w: 0.89, h: 0.4 }],
  'cargo-stow': [],
};

const DRAWERS: Record<string, PuzzlePanelSpec['draw']> = {
  'breaker-sequence': drawBreakerPanel as PuzzlePanelSpec['draw'],
  'coolant-valve:gauge': drawCoolantGaugePanel as PuzzlePanelSpec['draw'],
  'coolant-valve:wheel': drawCoolantValvePanel as PuzzlePanelSpec['draw'],
  'cargo-stow': drawCargoPanel as PuzzlePanelSpec['draw'],
  'fuse-hunt': drawFusePanel as PuzzlePanelSpec['draw'],
  'airlock-keyswitch': drawKeyswitchPanel as PuzzlePanelSpec['draw'],
  'undock-sequence': drawUndockPanel as PuzzlePanelSpec['draw'],
};

const TITLES: Record<string, string> = {
  'breaker-sequence': 'MAIN BUS',
  'coolant-valve:gauge': 'COOLANT · GAUGE',
  'coolant-valve:wheel': 'COOLANT · VALVE',
  'cargo-stow': 'BALLAST TRIM',
  'fuse-hunt': 'COMMS ARRAY',
  'airlock-keyswitch': 'AIRLOCK CTRL',
  'undock-sequence': 'UNDOCK',
};

/**
 * Derive one panel per authored panel prop. The station layout is the source of
 * truth for where the hardware is (§2 "authoring is then a JSON file"), exactly
 * as it is for the server's placement.
 */
export function panelSpecsFromLayout(layout: StationLayout): PuzzlePanelSpec[] {
  const specs: PuzzlePanelSpec[] = [];
  /** `${module}:${propId}` of the one prop that carries the rack manifest. */
  const cargoPanelProp = chooseCargoPanelProps(layout);
  for (const module of layout.modules) {
    for (const prop of module.props) {
      const role = puzzlePropRole(prop);
      const hit = role ? PANEL_PROP_KINDS[role] : undefined;
      if (!hit) continue;
      const drawKey = hit.suffix ? `${hit.puzzle}:${hit.suffix}` : hit.puzzle;
      const draw = DRAWERS[drawKey];
      if (!draw) continue;
      // One rack, one manifest. A rack authored as five numbered slot markers
      // (`levels/station.json`) resolves to five CARGO_RACK props, and the
      // readout that says "3/5 STOWED" is a property of the rack, not of each
      // slot in it — five copies of it would just be five copies. Every other
      // puzzle wants one panel per prop: the coolant valve's two are in two
      // different modules and that separation IS the puzzle, and the airlock's
      // two are in one module but carry different key regions.
      if (hit.puzzle === 'cargo-stow' && cargoPanelProp.get(module.id) !== prop.id) continue;
      // Two keyswitch props in one module: each gets only its own key region.
      let regionKey = drawKey;
      if (hit.puzzle === 'airlock-keyswitch') {
        regionKey = `airlock-keyswitch:${keyswitchSide(prop.id) === 'key-b' ? 'b' : 'a'}`;
      }
      specs.push({
        key: `${module.id}:${prop.id}`,
        puzzle: hit.puzzle,
        title: TITLES[drawKey] ?? hit.puzzle.toUpperCase(),
        module: module.id,
        position: localToWorld(prop.localPos, module.transform),
        // The prop's pose is authored in MODULE space; compose it with the
        // module's own transform or every panel faces the wrong way.
        quaternion: composeQuat(module.transform.quat, prop.localQuat),
        draw,
        regions: REGIONS[regionKey] ?? REGIONS[drawKey] ?? [],
      });
    }
  }
  return specs;
}

/**
 * One prop per module to hang the rack manifest on: the MIDDLE slot.
 *
 * The manifest is a readout for the whole rack, so it belongs at the middle of
 * it rather than at whichever end the level happened to author first — you read
 * "3/5 STOWED" while facing the rack, and the middle is where you are standing.
 * A layout that tags a real `cargo-rack` prop has exactly one and gets it.
 */
function chooseCargoPanelProps(layout: StationLayout): Map<ModuleId, string> {
  const chosen = new Map<ModuleId, string>();
  for (const module of layout.modules) {
    const props = module.props.filter(
      (prop) => puzzlePropRole(prop) === PUZZLE_PROP_KINDS.CARGO_RACK,
    );
    if (props.length === 0) continue;
    const numbered = props
      .map((prop) => ({ prop, index: cargoSlotIndex(prop.id) }))
      .sort((a, b) => (a.index ?? -1) - (b.index ?? -1));
    chosen.set(module.id, numbered[Math.floor((numbered.length - 1) / 2)].prop.id);
  }
  return chosen;
}

/** Hamilton product — module quaternion ∘ prop quaternion. */
function composeQuat(module: Quat, local: Quat | undefined): Quat {
  if (!local) return { ...module };
  return {
    x: module.w * local.x + module.x * local.w + module.y * local.z - module.z * local.y,
    y: module.w * local.y - module.x * local.z + module.y * local.w + module.z * local.x,
    z: module.w * local.z + module.x * local.y - module.y * local.x + module.z * local.w,
    w: module.w * local.w - module.x * local.x - module.y * local.y - module.z * local.z,
  };
}

// ---------------------------------------------------------------------------
// Wiring the panels to the store
// ---------------------------------------------------------------------------

export interface PuzzlePanelsOptions {
  /** Defaults to the shared store. */
  store?: PuzzleStore;
  /** Plane size in metres when a spec does not say. */
  width?: number;
  height?: number;
}

/**
 * Create every puzzle panel and keep it fed from the store.
 *
 * ```ts
 * const panels = createPuzzlePanels(ui.panels, panelSpecsFromLayout(layout));
 * // ui.panels.group is already in the scene; nothing else to do.
 * ```
 */
export class PuzzlePanels {
  readonly panels = new Map<string, Panel<unknown>>();
  private readonly byPuzzle = new Map<PuzzleId, Panel<unknown>[]>();
  private readonly store: PuzzleStore;
  private readonly unsubscribe: () => void;

  constructor(
    system: PanelSystem,
    specs: readonly PuzzlePanelSpec[],
    opts: PuzzlePanelsOptions = {},
  ) {
    this.store = opts.store ?? puzzleStore;

    for (const spec of specs) {
      const width = spec.width ?? opts.width ?? 0.7;
      const height = spec.height ?? opts.height ?? 0.5;
      const panel = system.create<unknown>({
        id: spec.key,
        module: spec.module,
        width,
        height,
        title: spec.title,
        state: this.store.get(spec.puzzle)?.state ?? null,
        draw: spec.draw as (ctx: CanvasRenderingContext2D, s: unknown, f: PanelFrame) => void,
        position: spec.position,
        quaternion: spec.quaternion,
      });
      for (const region of spec.regions ?? []) {
        panel.addRegion(
          region.id,
          region.x * panel.width,
          region.y * panel.height,
          region.w * panel.width,
          region.h * panel.height,
        );
      }
      this.panels.set(spec.key, panel);
      const list = this.byPuzzle.get(spec.puzzle) ?? [];
      list.push(panel);
      this.byPuzzle.set(spec.puzzle, list);
    }

    this.unsubscribe = this.store.subscribe((id, snapshot) => {
      for (const panel of this.byPuzzle.get(id) ?? []) panel.setState(snapshot.state);
    });

    // Anything already known before the panels existed.
    for (const snapshot of this.store.all()) {
      for (const panel of this.byPuzzle.get(snapshot.id) ?? []) panel.setState(snapshot.state);
    }
  }

  /** Every panel showing this puzzle — both halves of the coolant loop. */
  forPuzzle(id: PuzzleId): Panel<unknown>[] {
    return this.byPuzzle.get(id) ?? [];
  }

  dispose(): void {
    this.unsubscribe();
    this.panels.clear();
    this.byPuzzle.clear();
  }
}

export function createPuzzlePanels(
  system: PanelSystem,
  specs: readonly PuzzlePanelSpec[],
  opts: PuzzlePanelsOptions = {},
): PuzzlePanels {
  return new PuzzlePanels(system, specs, opts);
}

/** Systems online out of four, for anything that wants a one-line readout. */
export function systemsReadout(store: PuzzleStore = puzzleStore): string {
  return `${store.countSystems()}/${SYSTEMS_TO_ESCAPE} SYSTEMS`;
}
