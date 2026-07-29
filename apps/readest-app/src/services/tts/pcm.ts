// Pure PCM helpers for the Web Audio TTS pipeline.
//
// Decoded MP3 "silence" is dithered ringing (roughly 1e-4 to 1e-3 amplitude),
// not zeros, so speech detection uses an amplitude threshold rather than an
// exact-zero test.

export interface SpeechBounds {
  startSec: number;
  endSec: number;
}

// ~-46 dBFS: above decoder dither/ringing, below any audible speech onset.
const DEFAULT_SILENCE_THRESHOLD = 0.005;
// Pads keep a natural attack/release around the detected speech.
const HEAD_PAD_SEC = 0.02;
const TAIL_PAD_SEC = 0.05;

const TICKS_PER_SECOND = 10_000_000;
const CUT_SEARCH_BACK_SEC = 0.4;
const MAX_SILENCE_TO_SEED_SEC = 0.05;
const MIN_SAFE_SILENCE_SEC = 0.03;
const CUT_GUARD_SEC = 0.006;
const MIN_SLICE_SEC = 0.03;
// A peak-only gate can mistake sustained weak speech for silence. Until a
// captured engine fixture justifies a looser value, require near-noise-floor
// RMS across the guarded interior of every accepted quiet run.
const MAX_SAFE_SILENCE_RMS = 0.0015;

export type PcmCutFailure =
  | 'invalid-audio'
  | 'invalid-seeds'
  | 'no-safe-silence'
  | 'conflicting-cuts'
  | 'silent-slice';

export type PcmCutPlan =
  | { ok: true; cutFrames: readonly number[] }
  | { ok: false; reason: PcmCutFailure; cutIndex?: number };

export const findSpeechBounds = (
  samples: Float32Array,
  sampleRate: number,
  threshold = DEFAULT_SILENCE_THRESHOLD,
): SpeechBounds => {
  if (samples.length === 0 || sampleRate <= 0) {
    return { startSec: 0, endSec: 0 };
  }
  let first = -1;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]!) > threshold) {
      first = i;
      break;
    }
  }
  if (first === -1) {
    // All silence: play as-is rather than scheduling a zero-length chunk.
    return { startSec: 0, endSec: samples.length / sampleRate };
  }
  let last = first;
  for (let i = samples.length - 1; i >= first; i--) {
    if (Math.abs(samples[i]!) > threshold) {
      last = i;
      break;
    }
  }
  const startSec = Math.max(0, first / sampleRate - HEAD_PAD_SEC);
  const endSec = Math.min(samples.length / sampleRate, (last + 1) / sampleRate + TAIL_PAD_SEC);
  return { startSec, endSec };
};

// Converts estimated Android word-boundary timestamps into conservative PCM
// split points. A timestamp is only a search anchor: a cut is accepted solely
// inside a sustained quiet run, never at an isolated low-energy sample or zero
// crossing. The function returns no partial plan, so callers can fall back to
// individual synthesis before scheduling any part of a composite request.
export const planSafePcmCuts = (
  samples: Float32Array,
  sampleRate: number,
  seedOffsetsTicks: readonly number[],
): PcmCutPlan => {
  if (samples.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return { ok: false, reason: 'invalid-audio' };
  }

  let hasVoice = false;
  for (const sample of samples) {
    if (!Number.isFinite(sample)) return { ok: false, reason: 'invalid-audio' };
    if (Math.abs(sample) > DEFAULT_SILENCE_THRESHOLD) hasVoice = true;
  }
  if (!hasVoice) return { ok: false, reason: 'silent-slice' };

  const seedFrames: number[] = [];
  let previousTicks = 0;
  let previousFrame = 0;
  for (const ticks of seedOffsetsTicks) {
    if (!Number.isSafeInteger(ticks) || ticks <= previousTicks) {
      return { ok: false, reason: 'invalid-seeds' };
    }
    const frame = Math.round((ticks / TICKS_PER_SECOND) * sampleRate);
    if (frame <= previousFrame || frame >= samples.length) {
      return { ok: false, reason: 'invalid-seeds' };
    }
    seedFrames.push(frame);
    previousTicks = ticks;
    previousFrame = frame;
  }

  const searchBackFrames = Math.ceil(CUT_SEARCH_BACK_SEC * sampleRate);
  const maximumSilenceToSeedFrames = Math.floor(MAX_SILENCE_TO_SEED_SEC * sampleRate);
  const minimumSilenceFrames = Math.ceil(MIN_SAFE_SILENCE_SEC * sampleRate);
  const guardFrames = Math.ceil(CUT_GUARD_SEC * sampleRate);
  const minimumSliceFrames = Math.ceil(MIN_SLICE_SEC * sampleRate);
  const cutFrames: number[] = [];

  for (let cutIndex = 0; cutIndex < seedFrames.length; cutIndex++) {
    const seedFrame = seedFrames[cutIndex]!;
    const precedingSeedFrame = cutIndex === 0 ? 0 : seedFrames[cutIndex - 1]!;
    // Partition neighbouring searches at their seed midpoint. This prevents
    // two short logical marks from claiming the same quiet run.
    const cellStart = Math.floor((precedingSeedFrame + seedFrame) / 2);
    const searchStart = Math.max(0, seedFrame - searchBackFrames, cellStart);
    const searchEndExclusive = seedFrame + 1;

    let quietRunStart = -1;
    let candidateStart = -1;
    let candidateEnd = -1;
    let candidateDistance = Number.POSITIVE_INFINITY;

    const considerQuietRun = (runStart: number, runEndExclusive: number) => {
      if (runEndExclusive - runStart < minimumSilenceFrames) return;
      const safeStart = runStart + guardFrames;
      const safeEndExclusive = runEndExclusive - guardFrames;
      if (safeStart >= safeEndExclusive) return;
      const distance = Math.max(0, seedFrame - runEndExclusive);
      if (distance > maximumSilenceToSeedFrames) return;
      let squareSum = 0;
      for (let frame = safeStart; frame < safeEndExclusive; frame++) {
        squareSum += samples[frame]! * samples[frame]!;
      }
      const rms = Math.sqrt(squareSum / (safeEndExclusive - safeStart));
      if (rms > MAX_SAFE_SILENCE_RMS) return;
      if (distance < candidateDistance) {
        candidateStart = safeStart;
        candidateEnd = safeEndExclusive;
        candidateDistance = distance;
      }
    };

    for (let frame = searchStart; frame < searchEndExclusive; frame++) {
      if (Math.abs(samples[frame]!) <= DEFAULT_SILENCE_THRESHOLD) {
        if (quietRunStart < 0) quietRunStart = frame;
      } else if (quietRunStart >= 0) {
        considerQuietRun(quietRunStart, frame);
        quietRunStart = -1;
      }
    }
    if (quietRunStart >= 0) considerQuietRun(quietRunStart, searchEndExclusive);

    if (candidateStart < 0 || candidateEnd <= candidateStart) {
      return { ok: false, reason: 'no-safe-silence', cutIndex };
    }
    cutFrames.push(Math.floor((candidateStart + candidateEnd) / 2));
  }

  const sliceEdges = [0, ...cutFrames, samples.length];
  for (let index = 1; index < sliceEdges.length; index++) {
    const start = sliceEdges[index - 1]!;
    const end = sliceEdges[index]!;
    if (end <= start || end - start < minimumSliceFrames) {
      return { ok: false, reason: 'conflicting-cuts', cutIndex: Math.max(0, index - 1) };
    }
    let sliceHasVoice = false;
    for (let frame = start; frame < end; frame++) {
      if (Math.abs(samples[frame]!) > DEFAULT_SILENCE_THRESHOLD) {
        sliceHasVoice = true;
        break;
      }
    }
    if (!sliceHasVoice) {
      return { ok: false, reason: 'silent-slice', cutIndex: Math.max(0, index - 1) };
    }
  }

  for (let cutIndex = 0; cutIndex < cutFrames.length; cutIndex++) {
    const cut = cutFrames[cutIndex]!;
    const previousCut = cutIndex === 0 ? 0 : cutFrames[cutIndex - 1]!;
    if (cut <= previousCut) {
      return { ok: false, reason: 'conflicting-cuts', cutIndex };
    }
    for (let frame = cut - guardFrames; frame < cut + guardFrames; frame++) {
      if (
        frame < 0 ||
        frame >= samples.length ||
        Math.abs(samples[frame]!) > DEFAULT_SILENCE_THRESHOLD
      ) {
        return { ok: false, reason: 'conflicting-cuts', cutIndex };
      }
    }
  }

  return { ok: true, cutFrames };
};

// ~3ms: below one syllable so it is inaudible on speech, but far longer than a
// single sample so the ramp is smooth.
const EDGE_FADE_SEC = 0.003;

// Ramp the first and last samples to zero, in place.
//
// Speech buffers are cut at an amplitude threshold, not a zero crossing, so
// each begins and ends on a non-zero sample. An AudioBufferSourceNode steps
// straight from/to silence at its edges, and that discontinuity clicks/pops
// between sentences. A short linear fade removes the step without audibly
// touching the speech. Mutates the passed array, so callers pass a buffer they
// own (never a subarray view of the decoded audio).
export const applyEdgeFade = (
  samples: Float32Array,
  sampleRate: number,
  fadeSec = EDGE_FADE_SEC,
): void => {
  const n = Math.min(Math.floor(fadeSec * sampleRate), Math.floor(samples.length / 2));
  if (n <= 0) return;
  const last = samples.length - 1;
  for (let i = 0; i < n; i++) {
    const gain = i / n;
    samples[i]! *= gain;
    samples[last - i]! *= gain;
  }
};
