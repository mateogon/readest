import { md5 } from 'js-md5';
import {
  normalizeSynthesisLocale,
  SpeechProvider,
  SpeechSynthesisContext,
  SpeechSynthesisPermanentError,
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
} from './providers/types';

export type SynthesisPriority = 'playback' | 'next' | 'prefetch' | 'warmup';

export interface SynthesisLease {
  readonly result: Promise<SpeechSynthesisResult | undefined>;
  cancel(): void;
}

export interface SynthesisCoordinatorMetrics {
  hits: number;
  misses: number;
  joins: number;
  evictions: number;
  regenerations: number;
  attempts: number;
  retries: number;
  cancellations: number;
}

interface SynthesisCoordinatorOptions {
  maxCacheBytes?: number;
  maxCacheDurationSec?: number;
  maxHistoryEntries?: number;
  concurrency?: number;
}

interface Consumer {
  resolve: (result: SpeechSynthesisResult | undefined) => void;
  reject: (error: unknown) => void;
  detachSignal?: () => void;
}

interface SynthesisJob {
  key: string;
  request: SpeechSynthesisRequest;
  generation: number;
  priority: number;
  sequence: number;
  context: SpeechSynthesisContext;
  controller: AbortController;
  consumers: Map<number, Consumer>;
  state: 'queued' | 'active';
}

interface CacheEntry {
  result: SpeechSynthesisResult;
  bytes: number;
  durationSec: number;
}

const PRIORITY_RANK: Record<SynthesisPriority, number> = {
  playback: 0,
  next: 1,
  prefetch: 2,
  warmup: 3,
};

const DEFAULT_MAX_CACHE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_CACHE_DURATION_SEC = 60;
const DEFAULT_MAX_HISTORY_ENTRIES = 1024;
// Unknown-duration entries still consume a bounded slot without deriving time
// from encoded byte size (which would badly overcount uncompressed PCM WAV).
// Providers producing such audio should report SpeechSynthesisResult.durationSec.
const UNKNOWN_DURATION_FALLBACK_SEC = 1;
const TICKS_PER_SECOND = 10_000_000;
let nextCoordinatorSessionId = 0;

const cloneResult = (result: SpeechSynthesisResult): SpeechSynthesisResult => ({
  ...result,
  audio: result.audio.slice(0),
  boundaries: result.boundaries.map((boundary) => ({ ...boundary })),
});

const resultDurationSec = (result: SpeechSynthesisResult): number => {
  if (
    typeof result.durationSec === 'number' &&
    Number.isFinite(result.durationSec) &&
    result.durationSec > 0
  ) {
    return result.durationSec;
  }
  const boundaryDurationSec = result.boundaries.reduce(
    (max, boundary) => Math.max(max, (boundary.offset + boundary.duration) / TICKS_PER_SECOND),
    0,
  );
  if (Number.isFinite(boundaryDurationSec) && boundaryDurationSec > 0) {
    return boundaryDurationSec;
  }
  return UNKNOWN_DURATION_FALLBACK_SEC;
};

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';

// One owner for synthesis scheduling above every provider. It deliberately
// combines queueing, single-flight leases, navigation generations, retry and
// short-lived retention: splitting those responsibilities would reintroduce
// races between preload and playback.
export class SynthesisCoordinator {
  readonly #provider: SpeechProvider;
  readonly #sessionId = `tts-coordinator-${++nextCoordinatorSessionId}`;
  readonly #maxCacheBytes: number;
  readonly #maxCacheDurationSec: number;
  readonly #maxHistoryEntries: number;
  readonly #concurrency: number;
  readonly #jobs = new Map<string, SynthesisJob>();
  readonly #queue: SynthesisJob[] = [];
  readonly #cache = new Map<string, CacheEntry>();
  // Metrics-only history: bounded fingerprints rather than request keys that
  // contain raw book text. It never participates in synthesis correctness.
  readonly #history = new Set<string>();
  readonly #metrics: SynthesisCoordinatorMetrics = {
    hits: 0,
    misses: 0,
    joins: 0,
    evictions: 0,
    regenerations: 0,
    attempts: 0,
    retries: 0,
    cancellations: 0,
  };

  #generation = 0;
  #sequence = 0;
  #consumerId = 0;
  #activeCount = 0;
  #cacheBytes = 0;
  #cacheDurationSec = 0;

  constructor(provider: SpeechProvider, options: SynthesisCoordinatorOptions = {}) {
    this.#provider = provider;
    this.#maxCacheBytes = Math.max(0, options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES);
    this.#maxCacheDurationSec = Math.max(
      0,
      options.maxCacheDurationSec ?? DEFAULT_MAX_CACHE_DURATION_SEC,
    );
    this.#maxHistoryEntries = Math.max(
      0,
      Math.floor(options.maxHistoryEntries ?? DEFAULT_MAX_HISTORY_ENTRIES),
    );
    this.#concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  }

  get generation(): number {
    return this.#generation;
  }

  acquire(
    request: SpeechSynthesisRequest,
    options: {
      priority: SynthesisPriority;
      generation?: number;
      signal?: AbortSignal;
    },
  ): SynthesisLease {
    const generation = options.generation ?? this.#generation;
    if (generation !== this.#generation || options.signal?.aborted) {
      return { result: Promise.resolve(undefined), cancel: () => undefined };
    }

    const normalizedRequest = { ...request, lang: normalizeSynthesisLocale(request.lang) };
    const key = this.#jobKey(generation, normalizedRequest);
    const cached = this.#takeCached(key);
    if (cached) {
      this.#metrics.hits += 1;
      return { result: Promise.resolve(cloneResult(cached)), cancel: () => undefined };
    }

    let job = this.#jobs.get(key);
    const priority = PRIORITY_RANK[options.priority];
    if (job) {
      this.#metrics.joins += 1;
      if (priority < job.priority) {
        job.priority = priority;
        this.#sortQueue();
      }
    } else {
      this.#metrics.misses += 1;
      this.#rememberForMetrics(key);
      const sequence = this.#sequence++;
      job = {
        key,
        request: normalizedRequest,
        generation,
        priority,
        sequence,
        context: {
          sessionId: this.#sessionId,
          requestId: `${this.#sessionId}:${generation}:${sequence}`,
          generation,
        },
        controller: new AbortController(),
        consumers: new Map(),
        state: 'queued',
      };
      this.#jobs.set(key, job);
      this.#queue.push(job);
      this.#sortQueue();
    }

    const consumerId = this.#consumerId++;
    let cancelled = false;
    let consumer!: Consumer;
    const result = new Promise<SpeechSynthesisResult | undefined>((resolve, reject) => {
      consumer = { resolve, reject };
      job.consumers.set(consumerId, consumer);
    });

    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      this.#cancelConsumer(job, consumerId);
    };
    if (options.signal) {
      const onAbort = () => cancel();
      options.signal.addEventListener('abort', onAbort, { once: true });
      consumer.detachSignal = () => options.signal?.removeEventListener('abort', onAbort);
    }

    this.#pump();
    return { result, cancel };
  }

  advanceGeneration(): number {
    this.#generation += 1;
    for (const job of this.#jobs.values()) {
      job.controller.abort();
      this.#settleConsumers(job, undefined);
    }
    this.#jobs.clear();
    this.#queue.length = 0;
    this.#cache.clear();
    this.#cacheBytes = 0;
    this.#cacheDurationSec = 0;
    this.#history.clear();
    return this.#generation;
  }

  getMetrics(): SynthesisCoordinatorMetrics {
    return { ...this.#metrics };
  }

  shutdown(): void {
    this.advanceGeneration();
  }

  #jobKey(generation: number, request: SpeechSynthesisRequest): string {
    return JSON.stringify([
      'tts-prepared-v1',
      generation,
      this.#provider.id,
      this.#provider.synthesisIdentity ?? '',
      request.voice,
      normalizeSynthesisLocale(request.lang),
      request.pitch,
      request.text,
    ]);
  }

  #takeCached(key: string): SpeechSynthesisResult | undefined {
    const entry = this.#cache.get(key);
    if (!entry) return undefined;
    // Map insertion order is the LRU list.
    this.#cache.delete(key);
    this.#cache.set(key, entry);
    return entry.result;
  }

  #rememberForMetrics(key: string): void {
    if (this.#maxHistoryEntries === 0) return;
    const fingerprint = md5(key);
    if (this.#history.delete(fingerprint)) this.#metrics.regenerations += 1;
    this.#history.add(fingerprint);
    while (this.#history.size > this.#maxHistoryEntries) {
      const oldest = this.#history.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#history.delete(oldest);
    }
  }

  #storeCached(key: string, result: SpeechSynthesisResult): void {
    const entry: CacheEntry = {
      result: cloneResult(result),
      bytes: result.audio.byteLength,
      durationSec: resultDurationSec(result),
    };
    if (
      entry.bytes > this.#maxCacheBytes ||
      entry.durationSec > this.#maxCacheDurationSec ||
      this.#maxCacheBytes === 0 ||
      this.#maxCacheDurationSec === 0
    ) {
      return;
    }
    this.#cache.set(key, entry);
    this.#cacheBytes += entry.bytes;
    this.#cacheDurationSec += entry.durationSec;
    while (
      this.#cacheBytes > this.#maxCacheBytes ||
      this.#cacheDurationSec > this.#maxCacheDurationSec
    ) {
      const oldest = this.#cache.entries().next().value as [string, CacheEntry] | undefined;
      if (!oldest) break;
      this.#cache.delete(oldest[0]);
      this.#cacheBytes -= oldest[1].bytes;
      this.#cacheDurationSec -= oldest[1].durationSec;
      this.#metrics.evictions += 1;
    }
  }

  #sortQueue(): void {
    this.#queue.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
  }

  #pump(): void {
    while (this.#activeCount < this.#concurrency) {
      const job = this.#queue.shift();
      if (!job) return;
      if (
        job.state !== 'queued' ||
        job.generation !== this.#generation ||
        job.consumers.size === 0 ||
        this.#jobs.get(job.key) !== job
      ) {
        continue;
      }
      job.state = 'active';
      this.#activeCount += 1;
      void this.#run(job).finally(() => {
        this.#activeCount -= 1;
        this.#pump();
      });
    }
  }

  async #run(job: SynthesisJob): Promise<void> {
    try {
      const synthesized = await this.#synthesizeWithRetry(job);
      if (
        job.generation !== this.#generation ||
        job.controller.signal.aborted ||
        job.consumers.size === 0 ||
        this.#jobs.get(job.key) !== job
      ) {
        return;
      }
      this.#storeCached(job.key, synthesized);
      this.#settleConsumers(job, synthesized);
    } catch (error) {
      if (
        job.generation === this.#generation &&
        !job.controller.signal.aborted &&
        job.consumers.size > 0 &&
        this.#jobs.get(job.key) === job
      ) {
        this.#rejectConsumers(job, error);
      }
    } finally {
      if (this.#jobs.get(job.key) === job) this.#jobs.delete(job.key);
    }
  }

  async #synthesizeWithRetry(job: SynthesisJob): Promise<SpeechSynthesisResult> {
    const policy = this.#provider.retryPolicy;
    const maxAttempts = Math.max(1, Math.floor(policy?.maxAttempts ?? 1));
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (job.controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      this.#metrics.attempts += 1;
      try {
        return await this.#provider.synthesize(job.request, job.controller.signal, job.context);
      } catch (error) {
        lastError = error;
        const retryable =
          !job.controller.signal.aborted &&
          !isAbortError(error) &&
          !(error instanceof SpeechSynthesisPermanentError) &&
          (policy?.shouldRetry?.(error) ?? true);
        if (!retryable || attempt >= maxAttempts) throw error;
        this.#metrics.retries += 1;
        const delayMs = Math.max(0, policy?.delayMs?.(attempt, error) ?? 0);
        await this.#wait(delayMs, job.controller.signal);
      }
    }
    throw lastError;
  }

  #wait(delayMs: number, signal: AbortSignal): Promise<void> {
    if (delayMs === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, delayMs);
      const onAbort = () => {
        clearTimeout(timeout);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  #cancelConsumer(job: SynthesisJob, consumerId: number): void {
    const consumer = job.consumers.get(consumerId);
    if (!consumer) return;
    job.consumers.delete(consumerId);
    consumer.detachSignal?.();
    consumer.resolve(undefined);
    this.#metrics.cancellations += 1;
    if (job.consumers.size === 0) {
      job.controller.abort();
      if (this.#jobs.get(job.key) === job) this.#jobs.delete(job.key);
    }
  }

  #settleConsumers(job: SynthesisJob, result: SpeechSynthesisResult | undefined): void {
    for (const consumer of job.consumers.values()) {
      consumer.detachSignal?.();
      consumer.resolve(result ? cloneResult(result) : undefined);
    }
    job.consumers.clear();
  }

  #rejectConsumers(job: SynthesisJob, error: unknown): void {
    for (const consumer of job.consumers.values()) {
      consumer.detachSignal?.();
      consumer.reject(error);
    }
    job.consumers.clear();
  }
}
