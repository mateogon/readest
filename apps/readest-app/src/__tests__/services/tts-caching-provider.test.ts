import { beforeEach, describe, expect, test, vi } from 'vitest';
import { md5 } from 'js-md5';

import { CachingProvider, computeTTSCacheKey, TTSCacheStore } from '@/services/tts/providers/cache';
import type { TTSCacheEntry } from '@/services/tts/providers/cache';
import {
  SpeechProvider,
  SpeechSynthesisPermanentError,
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
} from '@/services/tts/providers/types';

const BOUNDARIES = [{ offset: 0, duration: 1_000_000, text: 'hello' }];

const makeInner = (overrides: Partial<SpeechProvider> = {}): SpeechProvider => ({
  id: 'fake',
  label: 'Fake',
  cacheable: true,
  init: vi.fn().mockResolvedValue(true),
  getAllVoices: vi.fn().mockResolvedValue([]),
  synthesize: vi.fn().mockImplementation(
    async (): Promise<SpeechSynthesisResult> => ({
      audio: new ArrayBuffer(8),
      boundaries: BOUNDARIES,
    }),
  ),
  ...overrides,
});

class MemoryStore implements TTSCacheStore {
  map = new Map<string, TTSCacheEntry>();
  get = vi.fn().mockImplementation(async (key: string) => this.map.get(key) ?? null);
  put = vi.fn().mockImplementation(async (key: string, entry: never) => {
    this.map.set(key, entry);
  });
  recordMarkKey = vi.fn().mockResolvedValue(undefined);
}

const req = (text = 'hello') => ({ lang: 'en', text, voice: 'v1', pitch: 1.0 });
const signal = () => new AbortController().signal;
const computeLegacyV1Key = (providerId: string, request: SpeechSynthesisRequest): string =>
  md5(
    JSON.stringify([
      'tts-v1',
      providerId,
      request.lang,
      request.voice,
      request.pitch,
      request.text,
    ]),
  );

describe('CachingProvider', () => {
  let inner: SpeechProvider;
  let store: MemoryStore;
  let provider: CachingProvider;

  beforeEach(() => {
    inner = makeInner();
    store = new MemoryStore();
    provider = new CachingProvider(inner, store);
  });

  test('mirrors the inner provider identity', () => {
    expect(provider.id).toBe('fake');
    expect(provider.label).toBe('Fake');
  });

  test('delegates the inner provider synthesis concurrency', () => {
    inner = makeInner({ synthesisConcurrency: 4 });
    provider = new CachingProvider(inner, store);

    expect(provider.synthesisConcurrency).toBe(4);
  });

  test('delegates whether the inner provider permits persistent caching', () => {
    inner = makeInner({ cacheable: false });
    provider = new CachingProvider(inner, store);

    expect(provider.cacheable).toBe(false);
  });

  test('cache miss synthesizes once and stores the result', async () => {
    const result = await provider.synthesize(req(), signal());
    expect(result.boundaries).toEqual(BOUNDARIES);
    expect(inner.synthesize).toHaveBeenCalledTimes(1);
    expect(store.put).toHaveBeenCalledTimes(1);
  });

  test('cache hit never reaches the inner provider', async () => {
    await provider.synthesize(req(), signal());
    const result = await provider.synthesize(req(), signal());
    expect(result.audio.byteLength).toBe(8);
    expect(result.boundaries).toEqual(BOUNDARIES);
    expect(inner.synthesize).toHaveBeenCalledTimes(1);
  });

  test('preserves exact duration metadata across persistent cache hits', async () => {
    inner = makeInner({
      synthesize: vi.fn(async () => ({
        audio: new ArrayBuffer(176_444),
        boundaries: [],
        durationSec: 2,
      })),
    });
    provider = new CachingProvider(inner, store);

    await provider.synthesize(req(), signal());
    const cached = await provider.synthesize(req(), signal());

    expect(cached.durationSec).toBe(2);
    expect([...store.map.values()][0]?.durationMs).toBe(2000);
    expect(inner.synthesize).toHaveBeenCalledTimes(1);
  });

  test('hits hand out an independent buffer per call', async () => {
    // decodeAudioData detaches its input; a shared cached buffer would break
    // the second playback of the same sentence.
    await provider.synthesize(req(), signal());
    const a = await provider.synthesize(req(), signal());
    const b = await provider.synthesize(req(), signal());
    expect(a.audio).not.toBe(b.audio);
    new Uint8Array(a.audio); // touching one must not affect the other
    expect(b.audio.byteLength).toBe(8);
  });

  test('the key covers voice, pitch, and text but never rate', async () => {
    await provider.synthesize(req('one'), signal());
    await provider.synthesize(req('two'), signal());
    await provider.synthesize({ lang: 'en', text: 'one', voice: 'v2', pitch: 1.0 }, signal());
    await provider.synthesize({ lang: 'en', text: 'one', voice: 'v1', pitch: 1.2 }, signal());
    expect(inner.synthesize).toHaveBeenCalledTimes(4);
    await provider.synthesize(req('one'), signal());
    expect(inner.synthesize).toHaveBeenCalledTimes(4);
  });

  test('canonicalizes locale aliases for both cached audio and manifest keys', async () => {
    const underscored = { ...req(), lang: 'en_US' };
    const canonical = { ...req(), lang: 'en-US' };

    await provider.synthesize(underscored, signal());
    await provider.synthesize(canonical, signal());
    provider.recordMark(4, 0, canonical);

    const storedKey = store.put.mock.calls[0]?.[0];
    expect(inner.synthesize).toHaveBeenCalledTimes(1);
    expect(store.put).toHaveBeenCalledTimes(1);
    expect(store.recordMarkKey).toHaveBeenCalledWith(4, 0, storedKey);
  });

  test('does not reuse persisted audio after the synthesis identity changes', async () => {
    let identity = 'engine-a@1';
    Object.defineProperty(inner, 'synthesisIdentity', { get: () => identity });
    provider = new CachingProvider(inner, store);

    await provider.synthesize(req(), signal());
    provider.recordMark(7, 0, req());
    const firstKey = store.put.mock.calls[0]?.[0];

    identity = 'engine-a@2';
    await provider.synthesize(req(), signal());
    provider.recordMark(7, 1, req());
    const secondKey = store.put.mock.calls[1]?.[0];

    expect(inner.synthesize).toHaveBeenCalledTimes(2);
    expect(store.put).toHaveBeenCalledTimes(2);
    expect(secondKey).not.toBe(firstKey);
    expect(store.recordMarkKey).toHaveBeenNthCalledWith(1, 7, 0, firstKey);
    expect(store.recordMarkKey).toHaveBeenNthCalledWith(2, 7, 1, secondKey);
  });

  test('opt-in legacy reads play offline and migrate the exact v1 entry to v2', async () => {
    const legacyRequest = { ...req(), lang: 'en_US' };
    const legacyKey = computeLegacyV1Key(inner.id, legacyRequest);
    const currentKey = computeTTSCacheKey(inner.id, legacyRequest, inner.synthesisIdentity);
    const legacyEntry: TTSCacheEntry = {
      audio: new Uint8Array([7, 8, 9]).buffer,
      boundaries: [{ offset: 0, duration: 25_000_000, text: 'legacy' }],
      durationMs: 2500,
    };
    store.map.set(legacyKey, legacyEntry);
    inner.synthesize = vi.fn().mockRejectedValue(new Error('offline'));
    provider = new CachingProvider(inner, store, { readLegacyV1: true });

    const result = await provider.synthesize(legacyRequest, signal());
    provider.recordMark(8, 0, legacyRequest);

    expect(new Uint8Array(result.audio)).toEqual(new Uint8Array([7, 8, 9]));
    expect(result.audio).not.toBe(legacyEntry.audio);
    expect(result.boundaries).toEqual(legacyEntry.boundaries);
    expect(result.durationSec).toBe(2.5);
    expect(inner.synthesize).not.toHaveBeenCalled();
    expect(store.get).toHaveBeenNthCalledWith(1, currentKey);
    expect(store.get).toHaveBeenNthCalledWith(2, legacyKey);
    expect(store.map.get(currentKey)).toEqual(legacyEntry);
    expect(store.recordMarkKey).toHaveBeenCalledWith(8, 0, currentKey);
  });

  test('does not consult a legacy v1 entry unless compatibility is explicitly enabled', async () => {
    const legacyRequest = req('legacy default off');
    const legacyKey = computeLegacyV1Key(inner.id, legacyRequest);
    const currentKey = computeTTSCacheKey(inner.id, legacyRequest, inner.synthesisIdentity);
    store.map.set(legacyKey, {
      audio: new Uint8Array([99]).buffer,
      boundaries: [],
      durationMs: 1000,
    });

    const result = await provider.synthesize(legacyRequest, signal());

    expect(result.audio.byteLength).toBe(8);
    expect(store.get).toHaveBeenCalledTimes(1);
    expect(store.get).toHaveBeenCalledWith(currentKey);
    expect(inner.synthesize).toHaveBeenCalledTimes(1);
  });

  test('leaves concurrent single-flight ownership to the synthesis coordinator', async () => {
    provider = new CachingProvider(inner, store);
    const p1 = provider.synthesize(req(), signal());
    const p2 = provider.synthesize(req(), signal());

    await Promise.all([p1, p2]);

    expect(inner.synthesize).toHaveBeenCalledTimes(2);
  });

  test('a non-cacheable inner provider bypasses the store entirely', async () => {
    inner = makeInner({ cacheable: false });
    provider = new CachingProvider(inner, store);
    await provider.synthesize(req(), signal());
    expect(store.get).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
    expect(inner.synthesize).toHaveBeenCalledTimes(1);
  });

  test('synthesis failures propagate and are never cached', async () => {
    inner = makeInner({
      synthesize: vi.fn().mockRejectedValue(new SpeechSynthesisPermanentError('no audio')),
    });
    provider = new CachingProvider(inner, store);
    await expect(provider.synthesize(req(), signal())).rejects.toBeInstanceOf(
      SpeechSynthesisPermanentError,
    );
    expect(store.put).not.toHaveBeenCalled();
    // The failed in-flight slot must not poison retries.
    await expect(provider.synthesize(req(), signal())).rejects.toBeInstanceOf(
      SpeechSynthesisPermanentError,
    );
    expect(inner.synthesize).toHaveBeenCalledTimes(2);
  });

  test('store failures degrade to synthesis instead of breaking playback', async () => {
    store.get.mockRejectedValue(new Error('disk gone'));
    store.put.mockRejectedValue(new Error('disk full'));
    const result = await provider.synthesize(req(), signal());
    expect(result.boundaries).toEqual(BOUNDARIES);
    expect(inner.synthesize).toHaveBeenCalledTimes(1);
  });

  test('shutdown closes the store and chains the inner provider', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const innerShutdown = vi.fn().mockResolvedValue(undefined);
    inner = makeInner({ shutdown: innerShutdown });
    const closableStore = Object.assign(new MemoryStore(), { close });
    provider = new CachingProvider(inner, closableStore);
    await provider.shutdown();
    expect(close).toHaveBeenCalledTimes(1);
    expect(innerShutdown).toHaveBeenCalledTimes(1);
  });

  test('delegates init, voices, and default-voice policy to the inner provider', async () => {
    inner = makeInner({
      pickDefaultVoice: () => 'v-picked',
      fallbackVoiceId: 'v-fallback',
    });
    provider = new CachingProvider(inner, store);
    await expect(provider.init()).resolves.toBe(true);
    expect(provider.pickDefaultVoice?.([])).toBe('v-picked');
    expect(provider.fallbackVoiceId).toBe('v-fallback');
  });
});
