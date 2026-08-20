/**
 * Mic calibration (DESIGN.md §7 — "**Non-negotiable**").
 *
 * "Raw RMS is dominated by per-player gain differences — one friend's hot mic
 * sits at loudness 55 while breathing." Voice is the loudest thing you own and
 * the alien hears it; if a headset's gain decides how loud a player is, the
 * mechanic dies in session one.
 *
 * So: a short join-time calibration. Measure the room in silence, then measure
 * the player speaking normally, and map everything between onto a normalised
 * 0–1 scale where **normal speech sits at 0.55** — leaving genuine headroom
 * above it for a shout, which is what reaches VOICE_MAX (55) and five modules.
 *
 * Everything is done in dBFS rather than linear RMS because microphone
 * differences are multiplicative: in dB they are an offset, and an offset is
 * exactly what a two-point calibration removes.
 */

import { clamp } from '@shared/constants';

export interface MicCalibration {
  /** dBFS of the room with nobody talking. */
  floorDb: number;
  /** dBFS of the player speaking normally. */
  speechDb: number;
  /** Wall clock ms the calibration was taken. */
  at: number;
  version: number;
}

export const CALIBRATION_VERSION = 1;
export const CALIBRATION_STORAGE_KEY = 'iss.mic.calibration.v1';

/** Where normal speech lands on the 0–1 scale. Shouting has to go somewhere. */
export const SPEECH_ANCHOR = 0.55;
/**
 * Below this fraction of the way from the floor to normal speech, treat it as
 * silence rather than a whisper. Phase one of the calibration deliberately
 * measures the room with the player wearing their headset and breathing, so
 * their own breath sits at the floor and gates out here — otherwise a hot mic
 * emits a 16-loudness NoiseEvent every four seconds and the alien lives in
 * their module.
 */
export const NOISE_GATE = 0.15;

/** A sane starting point for a mid-gain headset with browser AGC on. */
export const DEFAULT_CALIBRATION: MicCalibration = {
  floorDb: -58,
  speechDb: -28,
  at: 0,
  version: CALIBRATION_VERSION,
};

export function dbfs(rms: number): number {
  return 20 * Math.log10(Math.max(rms, 1e-7));
}

/** RMS of one analyser frame, 0–1. */
export function analyserRms(analyser: AnalyserNode, scratch: Float32Array): number {
  // Float32Array<ArrayBuffer> vs ArrayBufferLike: the DOM lib wants the former.
  analyser.getFloatTimeDomainData(scratch as Float32Array<ArrayBuffer>);
  let sum = 0;
  for (let i = 0; i < scratch.length; i++) {
    const v = scratch[i];
    sum += v * v;
  }
  return Math.sqrt(sum / scratch.length);
}

/**
 * Calibrated speaking level, 0–1. Feed it to `voiceNoise()` (§14) to get the
 * 10–55 loudness the alien reacts to.
 */
export function calibratedLevel(rms: number, cal: MicCalibration): number {
  const span = Math.max(cal.speechDb - cal.floorDb, 6);
  const t = (dbfs(rms) - cal.floorDb) / span;
  if (t < NOISE_GATE) return 0;
  return clamp(t * SPEECH_ANCHOR, 0, 1);
}

export function loadCalibration(key: string = CALIBRATION_STORAGE_KEY): MicCalibration | null {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MicCalibration>;
    if (
      typeof parsed.floorDb !== 'number' ||
      typeof parsed.speechDb !== 'number' ||
      parsed.version !== CALIBRATION_VERSION
    ) {
      return null;
    }
    return {
      floorDb: parsed.floorDb,
      speechDb: parsed.speechDb,
      at: parsed.at ?? 0,
      version: CALIBRATION_VERSION,
    };
  } catch {
    return null;
  }
}

export function saveCalibration(cal: MicCalibration, key: string = CALIBRATION_STORAGE_KEY): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(cal));
  } catch {
    /* private mode, or no storage. Calibration just does not persist. */
  }
}

export type CalibrationPhase = 'silence' | 'speech' | 'done';

export interface CalibrationProgress {
  phase: CalibrationPhase;
  /** 0–1 through the current phase. */
  progress: number;
  /** Live level, for a meter in the menu. */
  rms: number;
}

export interface CalibrationOptions {
  /** Seconds of "say nothing". */
  silenceSeconds?: number;
  /** Seconds of "speak normally". */
  speechSeconds?: number;
  /** Sampling rate of the measurement loop, Hz. */
  sampleHz?: number;
  onProgress?: (progress: CalibrationProgress) => void;
  /** Persist the result. Default true. */
  persist?: boolean;
  storageKey?: string;
}

export interface CalibrationResult extends MicCalibration {
  /** False when the two phases were too close together to trust — a muted mic,
   *  or a player who did not speak. The defaults are used instead. */
  confident: boolean;
  /** dB between silence and speech. Under ~8 dB is not a usable calibration. */
  headroomDb: number;
}

/**
 * Run the two-phase calibration against a live analyser.
 *
 * Both phases take the 80th percentile rather than the mean: a mean is dragged
 * down by the gaps between words and up by one cough.
 */
export async function calibrateMic(
  analyser: AnalyserNode,
  opts: CalibrationOptions = {},
): Promise<CalibrationResult> {
  const silenceSeconds = opts.silenceSeconds ?? 1.5;
  const speechSeconds = opts.speechSeconds ?? 4;
  const sampleHz = opts.sampleHz ?? 50;
  const period = 1000 / sampleHz;
  const scratch = new Float32Array(analyser.fftSize);

  const collect = (phase: CalibrationPhase, seconds: number): Promise<number[]> =>
    new Promise((resolve) => {
      const samples: number[] = [];
      const started = Date.now();
      const timer = setInterval(() => {
        const rms = analyserRms(analyser, scratch);
        samples.push(rms);
        const elapsed = (Date.now() - started) / 1000;
        opts.onProgress?.({ phase, progress: clamp(elapsed / seconds, 0, 1), rms });
        if (elapsed >= seconds) {
          clearInterval(timer);
          resolve(samples);
        }
      }, period);
    });

  const quiet = await collect('silence', silenceSeconds);
  const loud = await collect('speech', speechSeconds);

  const floorDb = dbfs(percentile(quiet, 0.8));
  const speechDb = dbfs(percentile(loud, 0.8));
  const headroomDb = speechDb - floorDb;
  const confident = headroomDb >= 8;

  const result: CalibrationResult = confident
    ? {
        floorDb,
        // A little margin under the measured speech level so ordinary speech
        // reliably clears the noise gate.
        speechDb: speechDb - 1.5,
        at: Date.now(),
        version: CALIBRATION_VERSION,
        confident,
        headroomDb,
      }
    : { ...DEFAULT_CALIBRATION, at: Date.now(), confident, headroomDb };

  if (opts.persist !== false) {
    saveCalibration(
      {
        floorDb: result.floorDb,
        speechDb: result.speechDb,
        at: result.at,
        version: CALIBRATION_VERSION,
      },
      opts.storageKey,
    );
  }
  opts.onProgress?.({ phase: 'done', progress: 1, rms: 0 });
  return result;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = clamp(Math.floor(sorted.length * p), 0, sorted.length - 1);
  return sorted[index];
}

/**
 * Attack/release envelope over the raw RMS. The level goes out at 10 Hz (§7)
 * and a bare frame RMS at that rate is jittery enough to make the noise ring
 * flicker and the alien twitch.
 */
export class LevelFollower {
  private value = 0;
  constructor(
    private readonly attackS = 0.03,
    private readonly releaseS = 0.22,
  ) {}

  push(rms: number, dt: number): number {
    const tau = rms > this.value ? this.attackS : this.releaseS;
    const k = 1 - Math.exp(-dt / Math.max(tau, 1e-3));
    this.value += (rms - this.value) * k;
    return this.value;
  }

  get level(): number {
    return this.value;
  }

  reset(): void {
    this.value = 0;
  }
}
