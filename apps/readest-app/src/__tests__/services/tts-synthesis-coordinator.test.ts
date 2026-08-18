import { describe, expect, test, vi } from 'vitest';
import { SynthesisCoordinator, type SynthesisLease } from '@/services/tts/SynthesisCoordinator';
import {
  SpeechSynthesisPermanentError,
  type SpeechProvider,
  type SpeechRetryPolicy,
  type SpeechSynthesisRequest,
  type SpeechSynthesisResult,
} from '@/services/tts/providers/types';

const request = (
  text: string,
  overrides: Partial<SpeechSynthesisRequest> = {},
): SpeechSynthesisRequest => ({
  lang: 'en-US',
  text,
  voice: 'voice-a',
  pitch: 1,
  ...overrides,
});

const result = (value: number, durationSec = 1): SpeechSynthesisResult => ({
  audio: new Uint8Array([value, value]).buffer,
  boundaries: [
    {
      text: 'word',
      offset: 0,
      duration: durationSec * 10_000_000,
    },
  ],
});

const makeProvider = (
  synthesize: SpeechProvider['synthesize'],
  options: {
    cacheable?: boolean;
    retryPolicy?: SpeechRetryPolicy;
    synthesisIdentity?: string;
  } = {},
): SpeechProvider => ({
  id: 'fake-provider',
  label: 'Fake provider',
  cacheable: options.cacheable,
  retryPolicy: options.retryPolicy,
  synthesisIdentity: options.synthesisIdentity,
  init: async () => true,
  getAllVoices: async () => [],
  synthesize,
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const waitForCallCount = async (mock: ReturnType<typeof vi.fn>, count: number): Promise<void> => {
  await vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(count));
};

describe('SynthesisCoordinator', () => {
  test('promotes a completed preload to playback without synthesizing twice', async () => {
    const synthesize = vi.fn(async () => result(1));
    const coordinator = new SynthesisCoordinator(makeProvider(synthesize));

    const preload = coordinator.acquire(request('hello'), { priority: 'prefetch' });
    const preloaded = await preload.result;
    const playback = coordinator.acquire(request('hello'), { priority: 'playback' });
    const played = await playback.result;

    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(preloaded?.audio).not.toBe(played?.audio);
    expect(new Uint8Array(played!.audio)).toEqual(new Uint8Array([1, 1]));
    expect(coordinator.getMetrics()).toMatchObject({ misses: 1, hits: 1 });
  });

  test('two consumers share active work and cancelling one lease does not abort the other', async () => {
    const pending = deferred<SpeechSynthesisResult>();
    const observedSignals: AbortSignal[] = [];
    const synthesize = vi.fn(async (_req: SpeechSynthesisRequest, signal: AbortSignal) => {
      observedSignals.push(signal);
      return pending.promise;
    });
    const coordinator = new SynthesisCoordinator(makeProvider(synthesize));

    const prefetch = coordinator.acquire(request('shared'), { priority: 'prefetch' });
    await waitForCallCount(synthesize, 1);
    const playback = coordinator.acquire(request('shared'), { priority: 'playback' });
    prefetch.cancel();
    pending.resolve(result(2));

    await expect(prefetch.result).resolves.toBeUndefined();
    await expect(playback.result).resolves.toMatchObject({ boundaries: expect.any(Array) });
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(observedSignals[0]?.aborted).toBe(false);
    expect(coordinator.getMetrics()).toMatchObject({ joins: 1 });
  });

  test('cancelling the only lease aborts the underlying work', async () => {
    const started = deferred<void>();
    const synthesize = vi.fn(
      (_req: SpeechSynthesisRequest, signal: AbortSignal): Promise<SpeechSynthesisResult> =>
        new Promise((_resolve, reject) => {
          started.resolve();
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            {
              once: true,
            },
          );
        }),
    );
    const coordinator = new SynthesisCoordinator(makeProvider(synthesize));

    const onlyLease = coordinator.acquire(request('cancel me'), { priority: 'prefetch' });
    await started.promise;
    onlyLease.cancel();

    await expect(onlyLease.result).resolves.toBeUndefined();
    expect(synthesize.mock.calls[0]?.[1].aborted).toBe(true);
  });

  test('waitForIdle does not resolve until an aborted native provider has drained', async () => {
    const cancellationFinished = deferred<void>();
    const synthesize = vi.fn(
      (_req: SpeechSynthesisRequest, signal: AbortSignal): Promise<SpeechSynthesisResult> =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              void cancellationFinished.promise.then(() =>
                reject(new DOMException('Aborted', 'AbortError')),
              );
            },
            { once: true },
          );
        }),
    );
    const coordinator = new SynthesisCoordinator(makeProvider(synthesize));
    const lease = coordinator.acquire(request('slow native cancel'), { priority: 'playback' });
    await waitForCallCount(synthesize, 1);

    coordinator.advanceGeneration();
    const idle = coordinator.waitForIdle();
    let drained = false;
    void idle.then(() => {
      drained = true;
    });
    await expect(lease.result).resolves.toBeUndefined();
    await Promise.resolve();
    expect(drained).toBe(false);

    cancellationFinished.resolve();
    await expect(idle).resolves.toBeUndefined();
  });

  test('playback starts before queued warmup work', async () => {
    const pending = new Map<string, Deferred<SpeechSynthesisResult>>();
    const order: string[] = [];
    const synthesize = vi.fn((req: SpeechSynthesisRequest) => {
      order.push(req.text);
      const gate = deferred<SpeechSynthesisResult>();
      pending.set(req.text, gate);
      return gate.promise;
    });
    const coordinator = new SynthesisCoordinator(makeProvider(synthesize));

    const blocker = coordinator.acquire(request('blocker'), { priority: 'warmup' });
    await waitForCallCount(synthesize, 1);
    // Source exhaustion can enqueue the next section before the planner has
    // submitted its final current-section batch. Playback must still win the
    // same coordinator queue when that request arrives afterwards.
    const future = coordinator.acquire(request('future'), { priority: 'warmup' });
    const current = coordinator.acquire(request('current'), { priority: 'playback' });

    pending.get('blocker')!.resolve(result(1));
    await waitForCallCount(synthesize, 2);
    expect(order).toEqual(['blocker', 'current']);
    pending.get('current')!.resolve(result(2));
    await waitForCallCount(synthesize, 3);
    expect(order).toEqual(['blocker', 'current', 'future']);
    pending.get('future')!.resolve(result(3));

    await Promise.all([blocker.result, current.result, future.result]);
  });

  test('bounds provider concurrency while playback still wins the next free slot', async () => {
    const pending = new Map<string, Deferred<SpeechSynthesisResult>>();
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const synthesize = vi.fn(async (req: SpeechSynthesisRequest) => {
      order.push(req.text);
      active += 1;
      maxActive = Math.max(maxActive, active);
      const gate = deferred<SpeechSynthesisResult>();
      pending.set(req.text, gate);
      try {
        return await gate.promise;
      } finally {
        active -= 1;
      }
    });
    const coordinator = new SynthesisCoordinator(makeProvider(synthesize), { concurrency: 2 });

    const first = coordinator.acquire(request('first'), { priority: 'prefetch' });
    const second = coordinator.acquire(request('second'), { priority: 'prefetch' });
    const future = coordinator.acquire(request('future'), { priority: 'prefetch' });
    await waitForCallCount(synthesize, 2);
    const playback = coordinator.acquire(request('playback'), { priority: 'playback' });

    pending.get('first')!.resolve(result(1));
    await waitForCallCount(synthesize, 3);
    expect(order).toEqual(['first', 'second', 'playback']);
    pending.get('second')!.resolve(result(2));
    await waitForCallCount(synthesize, 4);
    expect(order).toEqual(['first', 'second', 'playback', 'future']);
    pending.get('playback')!.resolve(result(3));
    pending.get('future')!.resolve(result(4));

    await Promise.all([first.result, second.result, future.result, playback.result]);
    expect(maxActive).toBe(2);
  });

  test('joining playback promotes queued prefetch without creating a second job', async () => {
    const pending = new Map<string, Deferred<SpeechSynthesisResult>>();
    const order: string[] = [];
    const synthesize = vi.fn((req: SpeechSynthesisRequest) => {
      order.push(req.text);
      const gate = deferred<SpeechSynthesisResult>();
      pending.set(req.text, gate);
      return gate.promise;
    });
    const coordinator = new SynthesisCoordinator(makeProvider(synthesize));

    const blocker = coordinator.acquire(request('blocker'), { priority: 'warmup' });
    await waitForCallCount(synthesize, 1);
    const other = coordinator.acquire(request('other'), { priority: 'prefetch' });
    const prefetched = coordinator.acquire(request('promoted'), { priority: 'prefetch' });
    const playback = coordinator.acquire(request('promoted'), { priority: 'playback' });

    pending.get('blocker')!.resolve(result(1));
    await waitForCallCount(synthesize, 2);
    expect(order).toEqual(['blocker', 'promoted']);
    pending.get('promoted')!.resolve(result(2));
    await waitForCallCount(synthesize, 3);
    pending.get('other')!.resolve(result(3));

    await Promise.all([blocker.result, other.result, prefetched.result, playback.result]);
    expect(order.filter((text) => text === 'promoted')).toHaveLength(1);
  });

  test('advancing generation cancels old leases and discards a late provider result', async () => {
    const first = deferred<SpeechSynthesisResult>();
    const second = deferred<SpeechSynthesisResult>();
    const synthesize = vi
      .fn<SpeechProvider['synthesize']>()
      .mockImplementationOnce(async () => first.promise)
      .mockImplementationOnce(async () => second.promise);
    const coordinator = new SynthesisCoordinator(makeProvider(synthesize));

    const stale = coordinator.acquire(request('same text'), { priority: 'playback' });
    await waitForCallCount(synthesize, 1);
    coordinator.advanceGeneration();
    await expect(stale.result).resolves.toBeUndefined();

    first.resolve(result(1));
    const fresh = coordinator.acquire(request('same text'), { priority: 'playback' });
    await waitForCallCount(synthesize, 2);
    second.resolve(result(2));

    await expect(fresh.result).resolves.toMatchObject({ audio: expect.any(ArrayBuffer) });
    expect(synthesize).toHaveBeenCalledTimes(2);
  });

  test('uses the provider retry policy serially', async () => {
    let active = 0;
    let maxActive = 0;
    const synthesize = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (synthesize.mock.calls.length < 3) throw new Error('temporary');
        return result(4);
      } finally {
        active -= 1;
      }
    });
    const retryPolicy: SpeechRetryPolicy = { maxAttempts: 3, delayMs: () => 0 };
    const coordinator = new SynthesisCoordinator(makeProvider(synthesize, { retryPolicy }));

    const lease = coordinator.acquire(request('retry'), { priority: 'playback' });

    await expect(lease.result).resolves.toMatchObject({ audio: expect.any(ArrayBuffer) });
    expect(synthesize).toHaveBeenCalledTimes(3);
    expect(maxActive).toBe(1);
    expect(coordinator.getMetrics()).toMatchObject({ attempts: 3, retries: 2 });
  });

  test('never retries a permanent synthesis error', async () => {
    const synthesize = vi.fn(async () => {
      throw new SpeechSynthesisPermanentError('bad text');
    });
    const coordinator = new SynthesisCoordinator(
      makeProvider(synthesize, { retryPolicy: { maxAttempts: 3, delayMs: () => 0 } }),
    );

    const lease = coordinator.acquire(request('bad'), { priority: 'playback' });

    await expect(lease.result).rejects.toBeInstanceOf(SpeechSynthesisPermanentError);
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  test('a provider without retry policy gets exactly one attempt', async () => {
    const synthesize = vi.fn(async () => {
      throw new Error('single attempt');
    });
    const coordinator = new SynthesisCoordinator(makeProvider(synthesize));

    const lease = coordinator.acquire(request('once'), { priority: 'playback' });

    await expect(lease.result).rejects.toThrow('single attempt');
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(coordinator.getMetrics()).toMatchObject({ attempts: 1, retries: 0 });
  });

  test('retains ephemeral audio even when persistence is forbidden', async () => {
    const synthesize = vi.fn(async () => result(5));
    const coordinator = new SynthesisCoordinator(makeProvider(synthesize, { cacheable: false }));

    await coordinator.acquire(request('local'), { priority: 'prefetch' }).result;
    await coordinator.acquire(request('local'), { priority: 'playback' }).result;

    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  test('evicts within the byte budget and never reuses an evicted result', async () => {
    const synthesize = vi.fn(async (req: SpeechSynthesisRequest) =>
      result(req.text === 'one' ? 1 : 2),
    );
    const coordinator = new SynthesisCoordinator(makeProvider(synthesize), {
      maxCacheBytes: 2,
      maxCacheDurationSec: 60,
    });

    await coordinator.acquire(request('one'), { priority: 'prefetch' }).result;
    await coordinator.acquire(request('two'), { priority: 'prefetch' }).result;
    await coordinator.acquire(request('one'), { priority: 'playback' }).result;

    expect(synthesize).toHaveBeenCalledTimes(3);
    expect(coordinator.getMetrics()).toMatchObject({ evictions: 2, regenerations: 1 });
  });

  test('bounds regeneration history instead of retaining every request key', async () => {
    const synthesize = vi.fn(async () => result(synthesize.mock.calls.length));
    const coordinator = new SynthesisCoordinator(makeProvider(synthesize), {
      maxCacheBytes: 0,
      maxHistoryEntries: 2,
    });

    await coordinator.acquire(request('one'), { priority: 'playback' }).result;
    await coordinator.acquire(request('two'), { priority: 'playback' }).result;
    await coordinator.acquire(request('three'), { priority: 'playback' }).result;
    // "one" fell out of the two-entry history, while "three" remains recent.
    await coordinator.acquire(request('one'), { priority: 'playback' }).result;
    await coordinator.acquire(request('three'), { priority: 'playback' }).result;

    expect(synthesize).toHaveBeenCalledTimes(5);
    expect(coordinator.getMetrics()).toMatchObject({ regenerations: 1 });
  });

  test('bounds boundaryless audio with validated fallback duration accounting', async () => {
    const invalidDurations: Record<string, number> = {
      one: 0,
      two: Number.NaN,
      three: Number.POSITIVE_INFINITY,
    };
    const synthesize = vi.fn(
      async (req: SpeechSynthesisRequest): Promise<SpeechSynthesisResult> => ({
        audio: new ArrayBuffer(40_000),
        boundaries: [],
        durationSec: invalidDurations[req.text],
      }),
    );
    const coordinator = new SynthesisCoordinator(makeProvider(synthesize), {
      maxCacheBytes: 1_000_000,
      maxCacheDurationSec: 2,
    });

    await coordinator.acquire(request('one'), { priority: 'prefetch' }).result;
    await coordinator.acquire(request('two'), { priority: 'prefetch' }).result;
    await coordinator.acquire(request('three'), { priority: 'prefetch' }).result;
    await coordinator.acquire(request('one'), { priority: 'playback' }).result;

    expect(synthesize).toHaveBeenCalledTimes(4);
    expect(coordinator.getMetrics()).toMatchObject({ evictions: 2, regenerations: 1 });
  });

  test('reuses boundaryless PCM WAV when the provider supplies explicit duration', async () => {
    const durationSec = 2;
    const wavHeaderBytes = 44;
    const pcm16MonoBytes = 44_100 * 2 * durationSec;
    const synthesize = vi.fn(
      async (): Promise<SpeechSynthesisResult> => ({
        audio: new ArrayBuffer(wavHeaderBytes + pcm16MonoBytes),
        boundaries: [],
        durationSec,
      }),
    );
    const coordinator = new SynthesisCoordinator(makeProvider(synthesize), {
      maxCacheBytes: 1_000_000,
      maxCacheDurationSec: 60,
    });

    const preloaded = await coordinator.acquire(request('wav'), { priority: 'prefetch' }).result;
    const played = await coordinator.acquire(request('wav'), { priority: 'playback' }).result;

    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(preloaded?.durationSec).toBe(durationSec);
    expect(played?.durationSec).toBe(durationSec);
    expect(coordinator.getMetrics()).toMatchObject({ misses: 1, hits: 1, evictions: 0 });
  });

  test('normalizes locale but isolates voice, pitch, and engine identity', async () => {
    let identity = 'engine-a@1';
    const synthesize = vi.fn(async () => result(synthesize.mock.calls.length));
    const provider = makeProvider(synthesize);
    Object.defineProperty(provider, 'synthesisIdentity', { get: () => identity });
    const coordinator = new SynthesisCoordinator(provider);

    await coordinator.acquire(request('identity'), { priority: 'prefetch' }).result;
    await coordinator.acquire(request('identity', { lang: 'en-us' }), { priority: 'playback' })
      .result;
    await coordinator.acquire(request('identity', { voice: 'voice-b' }), { priority: 'playback' })
      .result;
    await coordinator.acquire(request('identity', { pitch: 1.1 }), { priority: 'playback' }).result;
    identity = 'engine-a@2';
    await coordinator.acquire(request('identity'), { priority: 'playback' }).result;

    expect(synthesize).toHaveBeenCalledTimes(4);
  });

  test('passes the same normalized locale used for deduplication to the provider', async () => {
    const synthesize = vi.fn(async (_req: SpeechSynthesisRequest) => result(1));
    const coordinator = new SynthesisCoordinator(makeProvider(synthesize));

    await coordinator.acquire(request('locale', { lang: 'en_US' }), { priority: 'prefetch' })
      .result;
    await coordinator.acquire(request('locale', { lang: 'en-US' }), { priority: 'playback' })
      .result;

    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(synthesize.mock.calls[0]![0].lang).toBe('en-US');
  });

  test('namespaces native request ids across coordinator instances', async () => {
    const contexts: Array<{ sessionId: string; requestId: string; generation: number }> = [];
    const provider = makeProvider(async (_req, _signal, context) => {
      contexts.push(context!);
      return result(1);
    });
    const firstCoordinator = new SynthesisCoordinator(provider);
    const secondCoordinator = new SynthesisCoordinator(provider);

    await Promise.all([
      firstCoordinator.acquire(request('first'), { priority: 'playback' }).result,
      secondCoordinator.acquire(request('second'), { priority: 'playback' }).result,
    ]);

    expect(contexts).toHaveLength(2);
    expect(contexts[0]!.sessionId).not.toBe(contexts[1]!.sessionId);
    expect(contexts[0]!.requestId).not.toBe(contexts[1]!.requestId);
  });

  test('rejects a lease for an already stale generation without starting work', async () => {
    const synthesize = vi.fn(async () => result(1));
    const coordinator = new SynthesisCoordinator(makeProvider(synthesize));
    const staleGeneration = coordinator.generation;
    coordinator.advanceGeneration();

    const stale: SynthesisLease = coordinator.acquire(request('stale'), {
      priority: 'playback',
      generation: staleGeneration,
    });

    await expect(stale.result).resolves.toBeUndefined();
    expect(synthesize).not.toHaveBeenCalled();
  });
});
