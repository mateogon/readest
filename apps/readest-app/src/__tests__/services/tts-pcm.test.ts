import { describe, expect, test } from 'vitest';

import { applyEdgeFade, findSpeechBounds, planSafePcmCuts } from '@/services/tts/pcm';

const SR = 24000;
const TICKS_PER_SECOND = 10_000_000;

const makeSignal = (
  leadingSilenceSec: number,
  speechSec: number,
  trailingSilenceSec: number,
  noiseFloor = 0,
) => {
  const total = Math.round((leadingSilenceSec + speechSec + trailingSilenceSec) * SR);
  const samples = new Float32Array(total);
  const speechStart = Math.round(leadingSilenceSec * SR);
  const speechEnd = speechStart + Math.round(speechSec * SR);
  for (let i = 0; i < total; i++) {
    if (i >= speechStart && i < speechEnd) {
      samples[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR);
    } else if (noiseFloor > 0) {
      // Deterministic pseudo-noise below the detection threshold, emulating
      // MP3 decoder dither/ringing in "silent" passages.
      samples[i] = noiseFloor * Math.sin((2 * Math.PI * 1731 * i) / SR + i * 0.7);
    }
  }
  return samples;
};

describe('findSpeechBounds', () => {
  test('trims leading and trailing silence with head/tail pads', () => {
    const samples = makeSignal(0.5, 1.0, 0.8);
    const { startSec, endSec } = findSpeechBounds(samples, SR);
    expect(startSec).toBeGreaterThan(0.47 - 1e-6);
    expect(startSec).toBeLessThan(0.53);
    expect(endSec).toBeGreaterThan(1.44);
    expect(endSec).toBeLessThan(1.56 + 1e-6);
    expect(endSec).toBeGreaterThan(startSec);
  });

  test('ignores a realistic decoder noise floor in silent passages', () => {
    const samples = makeSignal(0.5, 1.0, 0.8, 0.0008);
    const { startSec, endSec } = findSpeechBounds(samples, SR);
    expect(startSec).toBeGreaterThan(0.4);
    expect(startSec).toBeLessThan(0.53);
    expect(endSec).toBeGreaterThan(1.44);
    expect(endSec).toBeLessThan(1.6);
  });

  test('all-silence input returns the full range', () => {
    const samples = new Float32Array(SR); // 1s of zeros
    const { startSec, endSec } = findSpeechBounds(samples, SR);
    expect(startSec).toBe(0);
    expect(endSec).toBeCloseTo(1, 5);
  });

  test('empty input returns zero bounds', () => {
    const { startSec, endSec } = findSpeechBounds(new Float32Array(0), SR);
    expect(startSec).toBe(0);
    expect(endSec).toBe(0);
  });

  test('speech reaching the buffer edges clamps to the buffer', () => {
    const samples = makeSignal(0, 0.5, 0);
    const { startSec, endSec } = findSpeechBounds(samples, SR);
    expect(startSec).toBe(0);
    expect(endSec).toBeCloseTo(0.5, 2);
  });
});

describe('applyEdgeFade', () => {
  test('ramps the first and last samples to zero, leaving the interior intact', () => {
    const sr = 48000;
    const fadeSec = 0.003;
    const n = Math.floor(fadeSec * sr);
    const samples = new Float32Array(sr).fill(1); // 1s of DC, edges are the clicks
    applyEdgeFade(samples, sr, fadeSec);

    // Both edges land exactly on zero, so there is no step from/to silence.
    expect(samples[0]).toBe(0);
    expect(samples[samples.length - 1]).toBe(0);
    // Everything past the fade window is untouched.
    expect(samples[n]).toBe(1);
    expect(samples[samples.length - 1 - n]).toBe(1);
    expect(samples[samples.length >> 1]).toBe(1);
    // The fade-in is a monotonic ramp.
    for (let i = 1; i < n; i++) {
      expect(samples[i]!).toBeGreaterThan(samples[i - 1]!);
    }
  });

  test('clamps the ramp so the two ends never overlap on a short buffer', () => {
    const samples = new Float32Array([1, 1, 1, 1]); // fade window would exceed length
    applyEdgeFade(samples, 48000, 0.003);
    expect(samples[0]).toBe(0);
    expect(samples[3]).toBe(0);
    // No sample double-scaled or amplified.
    for (const v of samples) expect(Math.abs(v)).toBeLessThanOrEqual(1);
  });

  test('is a no-op on buffers too small to fade', () => {
    expect(() => applyEdgeFade(new Float32Array(0), 48000)).not.toThrow();
    const one = new Float32Array([0.5]);
    applyEdgeFade(one, 48000);
    expect(one[0]).toBe(0.5);
  });
});

const makeCutSignal = (
  sampleRate: number,
  durationSec: number,
  silences: Array<{ startSec: number; endSec: number; amplitude?: number }> = [],
) => {
  const samples = new Float32Array(Math.round(durationSec * sampleRate)).fill(0.2);
  for (const silence of silences) {
    const start = Math.round(silence.startSec * sampleRate);
    const end = Math.round(silence.endSec * sampleRate);
    samples.fill(silence.amplitude ?? 0, start, end);
  }
  return samples;
};

const ticksAt = (seconds: number) => Math.round(seconds * TICKS_PER_SECOND);

describe('planSafePcmCuts', () => {
  test('maps ticks with the decoded sample rate and cuts at the center of sustained silence', () => {
    const decodedSampleRate = 48_000;
    const samples = makeCutSignal(decodedSampleRate, 2, [
      { startSec: 0.92, endSec: 0.98, amplitude: 0.0008 },
    ]);

    const result = planSafePcmCuts(samples, decodedSampleRate, [ticksAt(1)]);

    expect(result).toEqual({ ok: true, cutFrames: [Math.round(0.95 * decodedSampleRate)] });
  });

  test('accepts exactly 30ms of quiet audio but rejects a shorter amplitude valley', () => {
    const exact = makeCutSignal(SR, 2, [{ startSec: 0.95, endSec: 0.98 }]);
    const short = makeCutSignal(SR, 2, [{ startSec: 0.96, endSec: 0.98 }]);

    expect(planSafePcmCuts(exact, SR, [ticksAt(1)])).toEqual({
      ok: true,
      cutFrames: [Math.round(0.965 * SR)],
    });
    expect(planSafePcmCuts(short, SR, [ticksAt(1)])).toMatchObject({
      ok: false,
      reason: 'no-safe-silence',
    });
  });

  test('does not reach a silence more than 400ms before the estimated boundary', () => {
    const samples = makeCutSignal(SR, 2, [{ startSec: 0.5, endSec: 0.56 }]);

    expect(planSafePcmCuts(samples, SR, [ticksAt(1)])).toMatchObject({
      ok: false,
      reason: 'no-safe-silence',
    });
  });

  test('rejects a quiet run that ends more than 50ms before the estimated boundary', () => {
    const samples = makeCutSignal(SR, 2, [{ startSec: 0.61, endSec: 0.65 }]);

    expect(planSafePcmCuts(samples, SR, [ticksAt(1)])).toMatchObject({
      ok: false,
      reason: 'no-safe-silence',
    });
  });

  test('rejects sustained weak signal even when every sample is below the peak threshold', () => {
    const samples = makeCutSignal(SR, 2, [{ startSec: 0.94, endSec: 0.99, amplitude: 0.0049 }]);

    expect(planSafePcmCuts(samples, SR, [ticksAt(1)])).toMatchObject({
      ok: false,
      reason: 'no-safe-silence',
    });
  });

  test('does not mistake waveform zero crossings for a safe cut', () => {
    const samples = new Float32Array(2 * SR);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR);
    }

    expect(planSafePcmCuts(samples, SR, [ticksAt(1)])).toMatchObject({
      ok: false,
      reason: 'no-safe-silence',
    });
  });

  test('returns multiple strictly increasing cuts from distinct quiet runs', () => {
    const samples = makeCutSignal(SR, 3, [
      { startSec: 0.94, endSec: 1.0 },
      { startSec: 1.94, endSec: 2.0 },
    ]);

    const result = planSafePcmCuts(samples, SR, [ticksAt(1.04), ticksAt(2.04)]);

    expect(result).toEqual({
      ok: true,
      cutFrames: [Math.round(0.97 * SR), Math.round(1.97 * SR)],
    });
    if (result.ok) expect(result.cutFrames[1]!).toBeGreaterThan(result.cutFrames[0]!);
  });

  test('fails atomically when adjacent seed windows cannot produce distinct cuts', () => {
    const samples = makeCutSignal(SR, 2, [{ startSec: 0.95, endSec: 1.05 }]);

    const result = planSafePcmCuts(samples, SR, [ticksAt(1.06), ticksAt(1.08)]);

    expect(result).toMatchObject({ ok: false });
    expect('cutFrames' in result).toBe(false);
  });

  test('rejects a cut that would leave a logical slice shorter than 30ms', () => {
    const samples = makeCutSignal(SR, 1, [{ startSec: 0.96, endSec: 0.99 }]);

    expect(planSafePcmCuts(samples, SR, [ticksAt(0.995)])).toMatchObject({
      ok: false,
      reason: 'conflicting-cuts',
    });
  });

  test('rejects all-silence and non-finite PCM instead of manufacturing cuts', () => {
    const nonFinite = makeCutSignal(SR, 2, [{ startSec: 0.95, endSec: 1.0 }]);
    nonFinite[100] = Number.NaN;

    expect(planSafePcmCuts(new Float32Array(2 * SR), SR, [ticksAt(1)])).toMatchObject({
      ok: false,
      reason: 'silent-slice',
    });
    expect(planSafePcmCuts(nonFinite, SR, [ticksAt(1)])).toMatchObject({
      ok: false,
      reason: 'invalid-audio',
    });
  });

  test.each([
    { name: 'empty audio', samples: new Float32Array(), sampleRate: SR, seeds: [ticksAt(1)] },
    { name: 'zero sample rate', samples: new Float32Array(SR), sampleRate: 0, seeds: [] },
    {
      name: 'non-finite sample rate',
      samples: new Float32Array(SR),
      sampleRate: Number.NaN,
      seeds: [],
    },
  ])('rejects invalid audio metadata: $name', ({ samples, sampleRate, seeds }) => {
    expect(planSafePcmCuts(samples, sampleRate, seeds)).toMatchObject({
      ok: false,
      reason: 'invalid-audio',
    });
  });

  test.each([
    { name: 'zero', seeds: [0] },
    { name: 'negative', seeds: [-1] },
    { name: 'non-finite', seeds: [Number.POSITIVE_INFINITY] },
    { name: 'outside audio', seeds: [ticksAt(3)] },
    { name: 'non-increasing', seeds: [ticksAt(1), ticksAt(0.9)] },
    { name: 'equal decoded frame', seeds: [1, 2] },
  ])('rejects invalid cut seeds: $name', ({ seeds }) => {
    const samples = makeCutSignal(SR, 2, [{ startSec: 0.95, endSec: 1 }]);

    expect(planSafePcmCuts(samples, SR, seeds)).toMatchObject({
      ok: false,
      reason: 'invalid-seeds',
    });
  });
});
