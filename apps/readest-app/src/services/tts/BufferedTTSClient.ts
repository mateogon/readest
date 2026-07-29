import { getOSPlatform, getUserLocale } from '@/utils/misc';
import { isTauriAppPlatform } from '@/services/environment';
import { isSameLang } from '@/utils/lang';
import { NativeAudioPlayer } from './NativeAudioPlayer';
import { TTSBlockInput, TTSClient, TTSCapabilities, TTSMessageEvent } from './TTSClient';
import { TTSWordBoundary } from '@/libs/edgeTTS';
import { TTSGranularity, TTSMark, TTSPlaybackTransition, TTSVoice, TTSVoicesGroup } from './types';
import { AppService } from '@/types/system';
import { parseSSMLMarks } from '@/utils/ssml';
import type { TTSController } from './TTSController';
import { TTSUtils } from './TTSUtils';
import { findBoundaryIndexAtTime } from './wordHighlight';
import { applyEdgeFade, findSpeechBounds, PcmCutFailure, planSafePcmCuts } from './pcm';
import { timeStretch } from './timeStretch';
import {
  calibrateVoiceRate,
  estimateSentenceSeconds,
  recordMeasuredDuration,
  recordProvisionalDuration,
} from './ttsDuration';
import { CachingProvider } from './providers/cache';
import {
  SpeechProvider,
  normalizeSynthesisLocale,
  SpeechSynthesisPermanentError,
  SpeechSynthesisRequest,
} from './providers/types';
import { SynthesisCoordinator, SynthesisPriority } from './SynthesisCoordinator';
import { TTSAudioBuffer, WebAudioPlayer, WebAudioPlayerEvent } from './WebAudioPlayer';
import {
  planTTSCompositeBatches,
  TTSCompositeBatch,
  TTSCompositeLogicalUnit,
  TTSCompositeUnit,
} from './ttsComposite';

// The generic buffered TTS client: one SpeechProvider synthesizes compressed
// audio + word boundaries, and everything engine-independent lives here —
// the scheduler with backpressure, decode/trim/WSOLA (web path), native raw
// playout (iOS), word tracking against the player's media clock, preload,
// and duration bookkeeping. A new engine is just a new SpeechProvider.
//
// Playback pipeline: synthesize MP3 (cached at rate 1.0) -> decode -> trim
// silence -> WSOLA time-stretch to the playback rate -> schedule gaplessly on
// the shared AudioContext. Marks are dispatched when a chunk becomes AUDIBLE
// (player chunk-start events ride source onended, which keeps working with
// the screen off), not when it is fetched — schedule-ahead would otherwise
// run foliate's mark cursor ahead of the voice and break prev/next/resume.

// Natural pause between sentences, replacing Edge's baked-in ~300ms trailing
// silence. Divided by the playback rate so pauses shrink with speed (#2033's
// "gaps don't scale" complaint).
export const DEFAULT_SENTENCE_GAP_SEC = 0.15;
const TICKS_PER_SECOND = 10_000_000;

// How many consecutive unreachable sentences (offline with nothing cached, or
// a persistent service failure) to skip before stopping. A cached chapter
// whose heading is uncached still plays: the heading skips, the cached body
// resets the count. A wholly-uncached run stops instead of racing to the end.
const MAX_CONSECUTIVE_SKIPS = 3;

interface ChunkMeta {
  mark: TTSMark;
  logicalBoundary?: { blockOffset: number; mark: TTSMark };
  boundaries: TTSWordBoundary[];
  trimStartSec: number;
  trimmedDurationSec: number;
  // The exact synthesis request, for manifest key recording at chunk-start.
  req?: SpeechSynthesisRequest;
}

interface StreamProgress {
  highestSeenBlockOffset: number;
  sourceExhausted: boolean;
}

interface SchedulerState {
  readonly streamed: boolean;
  readonly streamProgress?: StreamProgress;
  individualFallback: boolean;
  lastScheduledBlockOffset: number | null;
}

type CompositeFallbackReason = 'synthesis' | 'boundaries' | 'decode' | PcmCutFailure | 'prepare';

interface CompositeMetrics {
  compositeRequests: number;
  compositesScheduled: number;
  logicalMarksScheduled: number;
  fallbackSessions: number;
  fallbackIndividualRequests: number;
  maxMarksPerComposite: number;
  fallbackReasons: Record<CompositeFallbackReason, number>;
}

interface PreparedWebChunk {
  buffer: TTSAudioBuffer;
  meta: ChunkMeta;
  transitionAfter: 'sentence' | TTSPlaybackTransition;
}

type CompositePreparation =
  | { ok: true; chunks: PreparedWebChunk[] }
  | { ok: false; reason: Exclude<CompositeFallbackReason, 'synthesis'> };

type CompositeRunResult =
  | { kind: 'scheduled' }
  | { kind: 'fallback'; reason: CompositeFallbackReason }
  | { kind: 'continue' }
  | { kind: 'stop' };

type SpeakQueueEvent =
  | { kind: 'chunk-start'; index: number }
  | { kind: 'chunk-skip'; markName: string }
  | { kind: 'session-end' }
  | { kind: 'error'; message: string };

class AsyncQueue<T> {
  #items: T[] = [];
  #resolvers: Array<(item: T) => void> = [];

  push(item: T): void {
    const resolve = this.#resolvers.shift();
    if (resolve) resolve(item);
    else this.#items.push(item);
  }

  next(): Promise<T> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve) => this.#resolvers.push(resolve));
  }
}

export class BufferedTTSClient implements TTSClient {
  name: string;
  initialized = false;
  controller?: TTSController;
  appService?: AppService | null;

  protected readonly provider: SpeechProvider;
  readonly #synthesisCoordinator: SynthesisCoordinator;
  protected voices: TTSVoice[] = [];
  #primaryLang = 'en';
  #speakingLang = '';
  #currentVoiceId = '';
  #rate = 1.0;
  #pitch = 1.0;
  #sentenceGapSec = DEFAULT_SENTENCE_GAP_SEC;
  #paragraphGapSec = 0;

  // iOS plays natively (app-process AVPlayer): audio in the app's own audio
  // session makes Now Playing, pause-slot retention, AirPods routing, and the
  // mute switch behave like a music app — the WebAudio path renders in
  // WebKit's GPU process under a session the app cannot own. Everywhere else
  // the gapless WSOLA WebAudio pipeline stays.
  #player: WebAudioPlayer | NativeAudioPlayer =
    getOSPlatform() === 'ios' && isTauriAppPlatform()
      ? new NativeAudioPlayer()
      : new WebAudioPlayer();
  #activeGeneration: number | null = null;
  #activeQueue: AsyncQueue<SpeakQueueEvent> | null = null;
  #chunkMeta: Array<ChunkMeta | undefined> = [];
  #firstRetainedChunkMeta = 0;
  #isPlaying = false;
  #wordTrackingRafId: number | null = null;
  readonly #compositeMetrics: CompositeMetrics = {
    compositeRequests: 0,
    compositesScheduled: 0,
    logicalMarksScheduled: 0,
    fallbackSessions: 0,
    fallbackIndividualRequests: 0,
    maxMarksPerComposite: 0,
    fallbackReasons: {
      synthesis: 0,
      boundaries: 0,
      decode: 0,
      'invalid-audio': 0,
      'invalid-seeds': 0,
      'no-safe-silence': 0,
      'conflicting-cuts': 0,
      'silent-slice': 0,
      prepare: 0,
    },
  };
  // Run of consecutive unreachable sentences (offline misses / persistent
  // failures) in the current session. Reset by any successful chunk; persists
  // across auto-advanced sections so a wholly-uncached run stops instead of
  // skipping to the end. A user-initiated restart builds a fresh client, so it
  // starts at 0 there too.
  #consecutiveSkips = 0;

  constructor(
    provider: SpeechProvider,
    controller?: TTSController,
    appService?: AppService | null,
  ) {
    this.provider = provider;
    this.#synthesisCoordinator = new SynthesisCoordinator(provider, {
      concurrency: provider.synthesisConcurrency,
    });
    this.name = provider.id;
    this.controller = controller;
    this.appService = appService;
  }

  async init(): Promise<boolean> {
    this.initialized = await this.provider.init();
    if (!this.initialized) {
      this.voices = [];
      return false;
    }
    this.voices = await this.provider.getAllVoices();
    return this.initialized;
  }

  #synthesize = async (
    req: SpeechSynthesisRequest,
    signal: AbortSignal,
    priority: SynthesisPriority,
    generation: number,
  ): Promise<
    { data: ArrayBuffer; boundaries: TTSWordBoundary[]; durationSec?: number } | undefined
  > => {
    const lease = this.#synthesisCoordinator.acquire(req, { priority, generation, signal });
    const synthesized = await lease.result;
    return synthesized
      ? {
          data: synthesized.audio,
          boundaries: synthesized.boundaries,
          durationSec: synthesized.durationSec,
        }
      : undefined;
  };

  #recordDurations = (
    voiceId: string,
    text: string,
    boundaries: TTSWordBoundary[],
    trimmedDurationSec?: number,
  ) => {
    if (trimmedDurationSec !== undefined) {
      // Canonical: decode-time trimmed duration; also feeds the per-voice
      // speaking-rate calibration used by timeline estimates.
      recordMeasuredDuration(voiceId, text, trimmedDurationSec);
      calibrateVoiceRate(voiceId, text, trimmedDurationSec);
      return;
    }
    const last = boundaries[boundaries.length - 1];
    if (last) {
      recordProvisionalDuration(voiceId, text, (last.offset + last.duration) / TICKS_PER_SECOND);
    }
  };

  getVoiceIdFromLang = async (lang: string) => {
    const preferredVoiceId = TTSUtils.getPreferredVoice(this.name, lang);
    const preferredVoice = this.voices.find((v) => v.id === preferredVoiceId);
    if (preferredVoice) return preferredVoice.id;

    const availableVoices = (await this.getVoices(lang))[0]?.voices || [];
    const picked = this.provider.pickDefaultVoice?.(availableVoices);
    return (
      picked ||
      availableVoices[0]?.id ||
      this.#currentVoiceId ||
      this.provider.fallbackVoiceId ||
      ''
    );
  };

  async *speak(
    ssml: string,
    signal: AbortSignal,
    preload = false,
    preloadPriority: 'next' | 'prefetch' = 'prefetch',
    transitionFromPrevious: TTSPlaybackTransition = null,
  ) {
    const { marks } = parseSSMLMarks(ssml, this.#primaryLang);

    if (preload) {
      yield* this.#preload(marks, signal, preloadPriority);
      return;
    }

    yield* this.#speakSession(
      (generation) => this.#planIndividualMarks(marks, generation),
      signal,
      transitionFromPrevious,
    );
  }

  supportsBlockStreaming(): boolean {
    const capability = this.provider.compositeBoundaries;
    return (
      capability?.textOffsets === 'utf16' &&
      capability.audioTiming === 'estimated' &&
      this.provider.cacheable === false &&
      this.#player instanceof WebAudioPlayer
    );
  }

  async *speakBlocks(
    blocks: AsyncIterable<TTSBlockInput>,
    signal: AbortSignal,
    transitionFromPrevious: TTSPlaybackTransition = null,
  ): AsyncGenerator<TTSMessageEvent> {
    if (!this.supportsBlockStreaming()) {
      yield { code: 'error', message: 'Streamed TTS is not supported' };
      return;
    }

    const progress: StreamProgress = {
      highestSeenBlockOffset: -1,
      sourceExhausted: false,
    };
    yield* this.#speakSession(
      (generation) =>
        planTTSCompositeBatches(this.#streamCompositeUnits(blocks, signal, generation, progress)),
      signal,
      transitionFromPrevious,
      progress,
    );
  }

  async *#speakSession(
    createPlans: (generation: number) => AsyncIterable<TTSCompositeBatch>,
    signal: AbortSignal,
    transitionFromPrevious: TTSPlaybackTransition,
    streamProgress?: StreamProgress,
  ): AsyncGenerator<TTSMessageEvent> {
    await this.stopInternal();

    const queue = new AsyncQueue<SpeakQueueEvent>();
    const chunkMeta: Array<ChunkMeta | undefined> = [];
    this.#activeQueue = queue;
    this.#chunkMeta = chunkMeta;
    this.#firstRetainedChunkMeta = 0;

    // startSession before ensureContext: starting a session declares playback
    // intent, clearing any lingering user-pause so the context may resume.
    const generation = this.#player.startSession(
      (event: WebAudioPlayerEvent) => {
        if (event.type === 'chunk-start') {
          queue.push({ kind: 'chunk-start', index: event.chunkIndex });
        } else if (event.type === 'session-end') {
          queue.push({ kind: 'session-end' });
        } else {
          queue.push({ kind: 'error', message: event.message });
        }
      },
      {
        transitionFromPrevious,
        leadingGapSec: this.#paragraphGapSec / this.#rate,
      },
    );
    this.#activeGeneration = generation;
    await this.#player.ensureContext();
    this.#isPlaying = true;

    const synthesisGeneration = this.#synthesisCoordinator.generation;
    const schedulerState: SchedulerState = {
      streamed: streamProgress !== undefined,
      streamProgress,
      individualFallback: false,
      lastScheduledBlockOffset: null,
    };
    void this.#runScheduler(
      createPlans(synthesisGeneration),
      signal,
      generation,
      synthesisGeneration,
      queue,
      chunkMeta,
      schedulerState,
    );

    let abortHandler: (() => void) | null = null;
    try {
      if (signal.aborted) {
        yield { code: 'error', message: 'Aborted' } as TTSMessageEvent;
        return;
      }
      abortHandler = () => queue.push({ kind: 'error', message: 'Aborted' });
      signal.addEventListener('abort', abortHandler);

      for (;;) {
        const event = await queue.next();
        if (event.kind === 'chunk-start') {
          this.#discardChunkMetaBefore(chunkMeta, event.index);
          const meta = chunkMeta[event.index];
          if (!meta) continue;
          if (meta.logicalBoundary) {
            yield {
              code: 'boundary',
              message: `Start chunk: ${meta.mark.name}`,
              mark: meta.mark.name,
              logicalBoundary: meta.logicalBoundary,
            } as TTSMessageEvent;
            // Async-generator suspension gives TTSController one turn to commit
            // the streamed block and dispatch its mark before word tracking
            // asks that controller to draw words for the new logical sentence.
            if (
              signal.aborted ||
              this.#activeGeneration !== generation ||
              synthesisGeneration !== this.#synthesisCoordinator.generation
            ) {
              return;
            }
            this.#startWordTracking(generation, event.index, meta);
            continue;
          }
          const located = this.controller?.dispatchSpeakMark(meta.mark);
          if (located && meta.req && this.provider instanceof CachingProvider) {
            // The sentence audibly played: record its cache key against the
            // section manifest so a fully covered section can compact.
            this.provider.recordMark(located.sectionIndex, located.sentenceIndex, meta.req);
          }
          this.#startWordTracking(generation, event.index, meta);
          yield {
            code: 'boundary',
            message: `Start chunk: ${meta.mark.name}`,
            mark: meta.mark.name,
          } as TTSMessageEvent;
        } else if (event.kind === 'session-end') {
          yield {
            code: 'end',
            message: 'Speak finished',
            ...(streamProgress?.sourceExhausted && streamProgress.highestSeenBlockOffset >= 0
              ? { consumedBlockOffset: streamProgress.highestSeenBlockOffset }
              : {}),
          } as TTSMessageEvent;
          return;
        } else if (event.kind === 'error') {
          yield { code: 'error', message: event.message } as TTSMessageEvent;
          return;
        }
        // chunk-skip is internal progress only. In particular it must not emit
        // a false public `end` in the middle of a streamed logical section.
      }
    } finally {
      // The controller aborts the signal after every successful paragraph; a
      // lingering listener would push a stale 'Aborted' into a dead queue.
      if (abortHandler) signal.removeEventListener('abort', abortHandler);
      this.#stopWordTracking();
      this.#isPlaying = false;
      if (this.#activeGeneration === generation) {
        this.#activeGeneration = null;
        this.#activeQueue = null;
        this.#player.abortSession();
      }
      if (this.#chunkMeta === chunkMeta) {
        this.#chunkMeta = [];
        this.#firstRetainedChunkMeta = 0;
      }
    }
  }

  #discardChunkMetaBefore(chunkMeta: Array<ChunkMeta | undefined>, retainedIndex: number): void {
    const end = Math.min(retainedIndex, chunkMeta.length);
    for (let index = this.#firstRetainedChunkMeta; index < end; index++) {
      chunkMeta[index] = undefined;
    }
    this.#firstRetainedChunkMeta = Math.max(this.#firstRetainedChunkMeta, end);
  }

  async *#preload(marks: TTSMark[], signal: AbortSignal, priority: 'next' | 'prefetch') {
    // The first audible mark is prepared before returning. Remaining marks
    // are enqueued under the coordinator and return immediately; playback can
    // promote any queued job without re-synthesizing it.
    const generation = this.#synthesisCoordinator.generation;
    for (let i = 0; i < marks.length; i++) {
      if (signal.aborted || generation !== this.#synthesisCoordinator.generation) break;
      const mark = marks[i]!;
      const voiceId = await this.getVoiceIdFromLang(mark.language);
      this.#currentVoiceId = voiceId;
      const req: SpeechSynthesisRequest = {
        lang: mark.language,
        text: mark.text,
        voice: voiceId,
        pitch: this.#pitch,
      };
      const prepared = this.#synthesize(req, signal, priority, generation)
        .then((audio) => {
          if (audio) this.#recordDurations(voiceId, mark.text, audio.boundaries);
        })
        .catch((error) => {
          console.warn('Error preloading TTS mark', mark.name, error);
        });
      if (i === 0) await prepared;
      else void prepared;
    }

    yield {
      code: 'end',
      message: 'Preload finished',
    } as TTSMessageEvent;
  }

  async *#planIndividualMarks(
    marks: TTSMark[],
    generation: number,
  ): AsyncGenerator<TTSCompositeBatch> {
    for (const mark of marks) {
      const voice = await this.getVoiceIdFromLang(mark.language);
      const estimatedDurationSec = estimateSentenceSeconds(mark.text, mark.language, voice);
      yield {
        request: {
          lang: normalizeSynthesisLocale(mark.language),
          text: mark.text,
          voice,
          pitch: this.#pitch,
        },
        generation,
        estimatedDurationSec,
        logicalUnits: [
          {
            blockOffset: 0,
            mark,
            estimatedDurationSec,
            transitionFromPrevious: null,
            textStart: 0,
            textEnd: mark.text.length,
          },
        ],
        transitionAfter: null,
      };
    }
  }

  async *#streamCompositeUnits(
    blocks: AsyncIterable<TTSBlockInput>,
    signal: AbortSignal,
    generation: number,
    progress: StreamProgress,
  ): AsyncGenerator<TTSCompositeUnit> {
    let previousBlockOffset = -1;
    let completed = false;
    try {
      for await (const block of blocks) {
        if (signal.aborted || generation !== this.#synthesisCoordinator.generation) return;
        if (
          !Number.isSafeInteger(block.blockOffset) ||
          (previousBlockOffset < 0
            ? block.blockOffset !== 0
            : block.blockOffset <= previousBlockOffset)
        ) {
          throw new Error(`Invalid streamed TTS block offset: ${block.blockOffset}`);
        }
        previousBlockOffset = block.blockOffset;
        progress.highestSeenBlockOffset = block.blockOffset;
        const { marks } = parseSSMLMarks(block.ssml, this.#primaryLang);
        for (let index = 0; index < marks.length; index++) {
          if (signal.aborted || generation !== this.#synthesisCoordinator.generation) return;
          const mark = marks[index]!;
          const voice = await this.getVoiceIdFromLang(mark.language);
          if (signal.aborted || generation !== this.#synthesisCoordinator.generation) return;
          yield {
            blockOffset: block.blockOffset,
            mark,
            lang: mark.language,
            voice,
            pitch: this.#pitch,
            generation,
            estimatedDurationSec: estimateSentenceSeconds(mark.text, mark.language, voice),
            transitionFromPrevious: block.blockOffset > 0 && index === 0 ? 'paragraph' : null,
          };
        }
      }
      completed = true;
    } finally {
      if (completed) progress.sourceExhausted = true;
    }
  }

  // One detached scheduler owns both established single-mark playback and the
  // opt-in streamed planner. Composite preparation is a different atomic work
  // item, not a second scheduler or lifecycle.
  async #runScheduler(
    plans: AsyncIterable<TTSCompositeBatch>,
    signal: AbortSignal,
    generation: number,
    synthesisGeneration: number,
    queue: AsyncQueue<SpeakQueueEvent>,
    chunkMeta: Array<ChunkMeta | undefined>,
    state: SchedulerState,
  ): Promise<void> {
    const rate = this.#rate;
    try {
      for await (const batch of plans) {
        if (!this.#isSchedulerCurrent(signal, generation, synthesisGeneration)) return;
        this.#speakingLang = batch.request.lang;
        this.#currentVoiceId = batch.request.voice;

        if (state.streamed && !state.individualFallback && batch.logicalUnits.length > 1) {
          const result = await this.#runCompositeBatch(
            batch,
            signal,
            generation,
            synthesisGeneration,
            queue,
            chunkMeta,
            state,
            rate,
          );
          if (result.kind === 'stop') return;
          if (result.kind === 'scheduled' || result.kind === 'continue') continue;
          this.#latchIndividualFallback(state, result.reason);
        }

        for (let index = 0; index < batch.logicalUnits.length; index++) {
          if (!this.#isSchedulerCurrent(signal, generation, synthesisGeneration)) return;
          if (state.streamed && state.individualFallback) {
            this.#compositeMetrics.fallbackIndividualRequests += 1;
          }
          const keepGoing = await this.#runIndividualUnit(
            batch,
            batch.logicalUnits[index]!,
            this.#transitionAfter(batch, index, state),
            signal,
            generation,
            synthesisGeneration,
            queue,
            chunkMeta,
            state,
            rate,
          );
          if (!keepGoing) return;
        }
      }
      if (this.#isSchedulerCurrent(signal, generation, synthesisGeneration)) {
        // Fires synchronously when every logical mark was skipped or the final
        // chunk already ended, preserving exactly one terminal public event.
        this.#player.endSession(generation);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      queue.push({ kind: 'error', message });
    }
  }

  #isSchedulerCurrent(
    signal: AbortSignal,
    generation: number,
    synthesisGeneration: number,
  ): boolean {
    return (
      !signal.aborted &&
      this.#activeGeneration === generation &&
      synthesisGeneration === this.#synthesisCoordinator.generation
    );
  }

  #transitionAfter(
    batch: TTSCompositeBatch,
    index: number,
    state: SchedulerState,
  ): 'sentence' | TTSPlaybackTransition {
    const current = batch.logicalUnits[index]!;
    const next = batch.logicalUnits[index + 1];
    if (next) {
      if (next.transitionFromPrevious !== null) return next.transitionFromPrevious;
      return next.blockOffset === current.blockOffset ? 'sentence' : 'paragraph';
    }
    if (batch.transitionAfter !== null) return batch.transitionAfter;
    return state.streamed ? null : 'sentence';
  }

  #transitionInto(
    state: SchedulerState,
    unit: TTSCompositeLogicalUnit,
  ): 'sentence' | Exclude<TTSPlaybackTransition, null> | undefined {
    const previousBlockOffset = state.lastScheduledBlockOffset;
    if (previousBlockOffset === null) return undefined;
    if (unit.transitionFromPrevious !== null) return unit.transitionFromPrevious;
    return previousBlockOffset === unit.blockOffset ? 'sentence' : 'paragraph';
  }

  #gapAfter(transition: 'sentence' | TTSPlaybackTransition, rate: number): number {
    if (transition === 'sentence') return this.#sentenceGapSec / rate;
    if (transition === 'paragraph' || transition === 'chapter') return this.#paragraphGapSec / rate;
    return 0;
  }

  #latchIndividualFallback(state: SchedulerState, reason: CompositeFallbackReason): void {
    if (state.individualFallback) return;
    state.individualFallback = true;
    this.#compositeMetrics.fallbackSessions += 1;
    this.#compositeMetrics.fallbackReasons[reason] += 1;
    console.info(`[TTS][Composite] ${JSON.stringify({ event: 'fallback', reason })}`);
  }

  async #runIndividualUnit(
    batch: TTSCompositeBatch,
    unit: TTSCompositeLogicalUnit,
    transitionAfter: 'sentence' | TTSPlaybackTransition,
    signal: AbortSignal,
    generation: number,
    synthesisGeneration: number,
    queue: AsyncQueue<SpeakQueueEvent>,
    chunkMeta: Array<ChunkMeta | undefined>,
    state: SchedulerState,
    rate: number,
  ): Promise<boolean> {
    const request: SpeechSynthesisRequest = {
      lang: batch.request.lang,
      text: unit.mark.text,
      voice: batch.request.voice,
      pitch: batch.request.pitch,
    };
    let audio:
      | { data: ArrayBuffer; boundaries: TTSWordBoundary[]; durationSec?: number }
      | undefined;
    try {
      audio = await this.#synthesize(request, signal, 'playback', synthesisGeneration);
    } catch (error) {
      // Cancellation and generation invalidation are control flow, not an
      // unreachable sentence. They must not consume the cross-session skip
      // budget or turn a stopped composite into individual fallback work.
      if (!this.#isSchedulerCurrent(signal, generation, synthesisGeneration)) return false;
      if (error instanceof SpeechSynthesisPermanentError) {
        console.warn('No TTS audio data received for mark', unit.mark.name);
        queue.push({ kind: 'chunk-skip', markName: unit.mark.name });
        return true;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.#consecutiveSkips += 1;
      if (this.#consecutiveSkips > MAX_CONSECUTIVE_SKIPS) {
        console.warn('TTS stopping after consecutive unreachable sentences:', message);
        queue.push({ kind: 'error', message });
        return false;
      }
      console.warn('TTS skipping unreachable mark', unit.mark.name, message);
      queue.push({ kind: 'chunk-skip', markName: unit.mark.name });
      return true;
    }
    if (!audio || !this.#isSchedulerCurrent(signal, generation, synthesisGeneration)) return false;
    this.#consecutiveSkips = 0;
    this.#recordDurations(batch.request.voice, unit.mark.text, audio.boundaries);

    const logicalBoundary = state.streamed
      ? { blockOffset: unit.blockOffset, mark: unit.mark }
      : undefined;
    const requestForManifest = state.streamed ? undefined : request;

    if (this.#player instanceof NativeAudioPlayer) {
      const ready = await this.#player.waitUntilReady(generation);
      if (!ready || !this.#isSchedulerCurrent(signal, generation, synthesisGeneration))
        return false;
      const index = chunkMeta.length;
      const meta: ChunkMeta = {
        mark: unit.mark,
        logicalBoundary,
        boundaries: audio.boundaries,
        trimStartSec: 0,
        trimmedDurationSec: 0,
        req: requestForManifest,
      };
      chunkMeta.push(meta);
      try {
        const durationSec = await this.#player.scheduleRawChunk(generation, index, audio.data, {
          gapSec: this.#gapAfter(transitionAfter, rate),
        });
        meta.trimmedDurationSec = durationSec;
        this.#recordDurations(batch.request.voice, unit.mark.text, audio.boundaries, durationSec);
        state.lastScheduledBlockOffset = unit.blockOffset;
      } catch (error) {
        console.warn('Failed to enqueue TTS audio for mark', unit.mark.name, error);
        queue.push({ kind: 'chunk-skip', markName: unit.mark.name });
      }
      return true;
    }

    let prepared: {
      buffer: TTSAudioBuffer;
      trimStartSec: number;
      trimmedDurationSec: number;
    };
    try {
      prepared = await this.#prepareChunkBuffer(this.#player, audio.data, rate);
    } catch (error) {
      console.warn('Failed to decode TTS audio for mark', unit.mark.name, error);
      queue.push({ kind: 'chunk-skip', markName: unit.mark.name });
      return true;
    }
    if (!this.#isSchedulerCurrent(signal, generation, synthesisGeneration)) return false;
    this.#recordDurations(
      batch.request.voice,
      unit.mark.text,
      audio.boundaries,
      prepared.trimmedDurationSec,
    );

    const ready = await this.#player.waitUntilReady(generation);
    if (!ready || !this.#isSchedulerCurrent(signal, generation, synthesisGeneration)) return false;
    chunkMeta.push({
      mark: unit.mark,
      logicalBoundary,
      boundaries: audio.boundaries,
      trimStartSec: prepared.trimStartSec,
      trimmedDurationSec: prepared.trimmedDurationSec,
      req: requestForManifest,
    });
    this.#player.scheduleChunk(generation, prepared.buffer, {
      trimStartSec: prepared.trimStartSec,
      mediaScale: prepared.trimmedDurationSec / prepared.buffer.duration,
      gapSec: this.#gapAfter(transitionAfter, rate),
      transitionFromPrevious: this.#transitionInto(state, unit),
    });
    state.lastScheduledBlockOffset = unit.blockOffset;
    if (state.streamed) this.#compositeMetrics.logicalMarksScheduled += 1;
    return true;
  }

  async #runCompositeBatch(
    batch: TTSCompositeBatch,
    signal: AbortSignal,
    generation: number,
    synthesisGeneration: number,
    queue: AsyncQueue<SpeakQueueEvent>,
    chunkMeta: Array<ChunkMeta | undefined>,
    state: SchedulerState,
    rate: number,
  ): Promise<CompositeRunResult> {
    const player = this.#player;
    if (!(player instanceof WebAudioPlayer)) return { kind: 'stop' };
    this.#compositeMetrics.compositeRequests += 1;
    this.#compositeMetrics.maxMarksPerComposite = Math.max(
      this.#compositeMetrics.maxMarksPerComposite,
      batch.logicalUnits.length,
    );

    let audio:
      | { data: ArrayBuffer; boundaries: TTSWordBoundary[]; durationSec?: number }
      | undefined;
    try {
      audio = await this.#synthesize(batch.request, signal, 'playback', synthesisGeneration);
    } catch (error) {
      if (!this.#isSchedulerCurrent(signal, generation, synthesisGeneration)) {
        return { kind: 'stop' };
      }
      if (error instanceof SpeechSynthesisPermanentError) {
        return { kind: 'fallback', reason: 'synthesis' };
      }
      const message = error instanceof Error ? error.message : String(error);
      this.#consecutiveSkips += batch.logicalUnits.length;
      if (this.#consecutiveSkips > MAX_CONSECUTIVE_SKIPS) {
        console.warn('TTS stopping after consecutive unreachable sentences:', message);
        queue.push({ kind: 'error', message });
        return { kind: 'stop' };
      }
      for (const unit of batch.logicalUnits) {
        console.warn('TTS skipping unreachable mark', unit.mark.name, message);
        queue.push({ kind: 'chunk-skip', markName: unit.mark.name });
      }
      return { kind: 'continue' };
    }
    if (!audio || !this.#isSchedulerCurrent(signal, generation, synthesisGeneration)) {
      return { kind: 'stop' };
    }

    const prepared = await this.#prepareCompositeBatch(
      batch,
      audio.boundaries,
      audio.data,
      rate,
      state,
    );
    if (!this.#isSchedulerCurrent(signal, generation, synthesisGeneration)) {
      return { kind: 'stop' };
    }
    if (!prepared.ok) return { kind: 'fallback', reason: prepared.reason };

    // Structural validation and every PCM allocation complete before the
    // first admission, so fallback remains all-or-nothing. The already-safe
    // slices still enter WebAudio through its ordinary bounded admission;
    // otherwise one pathological 32-mark batch could bypass both pending and
    // ahead limits and retain a chapter-sized graph on a mobile device.
    this.#consecutiveSkips = 0;
    for (let index = 0; index < prepared.chunks.length; index++) {
      const unit = batch.logicalUnits[index]!;
      const chunk = prepared.chunks[index]!;
      this.#recordDurations(
        batch.request.voice,
        unit.mark.text,
        chunk.meta.boundaries,
        chunk.meta.trimmedDurationSec,
      );
    }
    for (let index = 0; index < prepared.chunks.length; index++) {
      const unit = batch.logicalUnits[index]!;
      const chunk = prepared.chunks[index]!;
      const ready = await player.waitUntilReady(generation);
      if (!ready || !this.#isSchedulerCurrent(signal, generation, synthesisGeneration)) {
        return { kind: 'stop' };
      }
      chunkMeta.push(chunk.meta);
      player.scheduleChunk(generation, chunk.buffer, {
        trimStartSec: chunk.meta.trimStartSec,
        mediaScale: chunk.meta.trimmedDurationSec / chunk.buffer.duration,
        gapSec: this.#gapAfter(chunk.transitionAfter, rate),
        transitionFromPrevious: this.#transitionInto(state, unit),
      });
      state.lastScheduledBlockOffset = unit.blockOffset;
    }
    this.#compositeMetrics.compositesScheduled += 1;
    this.#compositeMetrics.logicalMarksScheduled += batch.logicalUnits.length;
    console.info(
      `[TTS][Composite] ${JSON.stringify({
        event: 'scheduled',
        marks: batch.logicalUnits.length,
        chars: batch.request.text.length,
      })}`,
    );
    return { kind: 'scheduled' };
  }

  async #prepareCompositeBatch(
    batch: TTSCompositeBatch,
    boundaries: TTSWordBoundary[],
    data: ArrayBuffer,
    rate: number,
    state: SchedulerState,
  ): Promise<CompositePreparation> {
    const mappedBoundaries = this.#mapCompositeBoundaries(batch, boundaries);
    if (!mappedBoundaries) return { ok: false, reason: 'boundaries' };

    let decoded: TTSAudioBuffer;
    let samples: Float32Array;
    try {
      decoded = await (this.#player as WebAudioPlayer).decode(data);
      samples = decoded.getChannelData(0);
    } catch {
      return { ok: false, reason: 'decode' };
    }
    const seedOffsetsTicks = mappedBoundaries.slice(1).map((unit) => unit[0]!.offset);
    const cutPlan = planSafePcmCuts(samples, decoded.sampleRate, seedOffsetsTicks);
    if (!cutPlan.ok) return { ok: false, reason: cutPlan.reason };
    if (cutPlan.cutFrames.length !== batch.logicalUnits.length - 1) {
      return { ok: false, reason: 'invalid-seeds' };
    }

    const edges = [0, ...cutPlan.cutFrames, samples.length];
    const chunks: PreparedWebChunk[] = [];
    try {
      for (let index = 0; index < batch.logicalUnits.length; index++) {
        const unit = batch.logicalUnits[index]!;
        const prepared = await this.#preparePcmSlice(
          this.#player as WebAudioPlayer,
          samples,
          decoded.sampleRate,
          edges[index]!,
          edges[index + 1]!,
          rate,
        );
        chunks.push({
          buffer: prepared.buffer,
          meta: {
            mark: unit.mark,
            logicalBoundary: { blockOffset: unit.blockOffset, mark: unit.mark },
            boundaries: mappedBoundaries[index]!,
            trimStartSec: prepared.trimStartSec,
            trimmedDurationSec: prepared.trimmedDurationSec,
          },
          transitionAfter: this.#transitionAfter(batch, index, state),
        });
      }
    } catch {
      return { ok: false, reason: 'prepare' };
    }
    return { ok: true, chunks };
  }

  #mapCompositeBoundaries(
    batch: TTSCompositeBatch,
    boundaries: TTSWordBoundary[],
  ): TTSWordBoundary[][] | null {
    const mapped = batch.logicalUnits.map(() => [] as TTSWordBoundary[]);
    let previousTextEnd = 0;
    let previousAudioOffset = 0;

    for (const unit of batch.logicalUnits) {
      if (
        !Number.isSafeInteger(unit.textStart) ||
        !Number.isSafeInteger(unit.textEnd) ||
        unit.textStart < 0 ||
        unit.textEnd <= unit.textStart ||
        unit.textEnd > batch.request.text.length ||
        batch.request.text.slice(unit.textStart, unit.textEnd) !== unit.mark.text
      ) {
        return null;
      }
    }

    for (const boundary of boundaries) {
      const { textStart, textEnd } = boundary;
      if (
        !Number.isSafeInteger(boundary.offset) ||
        !Number.isSafeInteger(boundary.duration) ||
        boundary.offset < previousAudioOffset ||
        boundary.duration < 0 ||
        !Number.isSafeInteger(textStart) ||
        !Number.isSafeInteger(textEnd) ||
        textStart! < previousTextEnd ||
        textEnd! <= textStart! ||
        textEnd! > batch.request.text.length ||
        batch.request.text.slice(textStart, textEnd) !== boundary.text
      ) {
        return null;
      }
      const unitIndex = batch.logicalUnits.findIndex(
        (unit) => textStart! >= unit.textStart && textEnd! <= unit.textEnd,
      );
      if (unitIndex < 0) return null;
      mapped[unitIndex]!.push(boundary);
      previousTextEnd = textEnd!;
      previousAudioOffset = boundary.offset;
    }

    return mapped.every((unitBoundaries) => unitBoundaries.length > 0) ? mapped : null;
  }

  async #prepareChunkBuffer(
    player: WebAudioPlayer,
    data: ArrayBuffer,
    rate: number,
  ): Promise<{ buffer: TTSAudioBuffer; trimStartSec: number; trimmedDurationSec: number }> {
    // decodeAudioData resamples to the context rate (44.1/48kHz on real
    // devices, not the stream's 24kHz) — all math below must use the decoded
    // buffer's sampleRate.
    const decoded = await player.decode(data);
    const channel = decoded.getChannelData(0);
    return this.#preparePcmSlice(player, channel, decoded.sampleRate, 0, channel.length, rate);
  }

  async #preparePcmSlice(
    player: WebAudioPlayer,
    samples: Float32Array,
    sampleRate: number,
    absoluteStartFrame: number,
    absoluteEndFrame: number,
    rate: number,
  ): Promise<{ buffer: TTSAudioBuffer; trimStartSec: number; trimmedDurationSec: number }> {
    if (
      !Number.isFinite(sampleRate) ||
      sampleRate <= 0 ||
      !Number.isSafeInteger(absoluteStartFrame) ||
      !Number.isSafeInteger(absoluteEndFrame) ||
      absoluteStartFrame < 0 ||
      absoluteEndFrame <= absoluteStartFrame ||
      absoluteEndFrame > samples.length
    ) {
      throw new Error('Invalid decoded PCM slice');
    }
    const slice = samples.subarray(absoluteStartFrame, absoluteEndFrame);
    const bounds = findSpeechBounds(slice, sampleRate);
    const localStartFrame = Math.floor(bounds.startSec * sampleRate);
    const localEndFrame = Math.min(slice.length, Math.ceil(bounds.endSec * sampleRate));
    if (localEndFrame <= localStartFrame) throw new Error('Empty decoded PCM slice');
    // A subarray is a view; timeStretch never writes its input and
    // createMonoBuffer copies, so no mutation can reach the decoded buffer.
    const trimmed = slice.subarray(localStartFrame, localEndFrame);
    const trimmedDurationSec = trimmed.length / sampleRate;
    const outputSamples = rate !== 1 ? timeStretch(trimmed, sampleRate, rate) : trimmed;
    const buffer = await player.createMonoBuffer(outputSamples, sampleRate);
    if (!Number.isFinite(buffer.duration) || buffer.duration <= 0) {
      throw new Error('Invalid prepared PCM buffer');
    }
    // Silence-trimmed edges sit on non-zero samples; fade the buffer's own copy
    // so chunk starts/ends don't click against the inter-sentence gap.
    applyEdgeFade(buffer.getChannelData(0), sampleRate);
    return {
      buffer,
      trimStartSec: (absoluteStartFrame + localStartFrame) / sampleRate,
      trimmedDurationSec,
    };
  }

  // Poll the audio clock (visual concern only, so rAF throttling with the
  // screen off is fine) and tell the controller which word is being spoken.
  // The player reports original (rate-1.0) media time, so the boundary
  // ticks need no rescaling for trim or rate.
  #startWordTracking(generation: number, chunkIndex: number, meta: ChunkMeta): void {
    this.#stopWordTracking();
    const controller = this.controller;
    if (!controller) return;
    // Always hand the words to the controller — with boundaries it highlights
    // word-by-word; with none it draws the sentence highlight that was
    // suppressed at mark dispatch (see TTSController.prepareSpeakWords).
    controller.prepareSpeakWords(meta.boundaries.map((boundary) => boundary.text));
    if (!meta.boundaries.length) return;
    let lastIndex = -1;
    const tick = () => {
      const pos = this.#player.getPlaybackPosition(generation);
      // Guard the one-frame window around a transition where this tick still
      // holds the previous chunk's boundaries.
      if (pos && pos.chunkIndex === chunkIndex) {
        const index = findBoundaryIndexAtTime(meta.boundaries, pos.mediaTimeSec);
        if (index !== lastIndex && index >= 0) {
          lastIndex = index;
          controller.dispatchSpeakWord(index);
        }
      }
      this.#wordTrackingRafId = requestAnimationFrame(tick);
    };
    this.#wordTrackingRafId = requestAnimationFrame(tick);
  }

  #stopWordTracking(): void {
    if (this.#wordTrackingRafId !== null) {
      cancelAnimationFrame(this.#wordTrackingRafId);
      this.#wordTrackingRafId = null;
    }
  }

  async pause() {
    if (!this.#isPlaying) return true;
    await this.#player.pauseContext();
    return true;
  }

  async resume() {
    // Throws when the context refuses to run again (iOS post-interruption);
    // the controller's catch stops playback visibly instead of showing
    // "playing" over silence.
    await this.#player.resumeContext();
    return true;
  }

  async stop(preserveSynthesis = false) {
    await this.stopInternal();
    if (!preserveSynthesis) this.#logSynthesisMetrics('stop');
  }

  invalidateSynthesis(): void {
    this.#synthesisCoordinator.advanceGeneration();
    this.#logSynthesisMetrics('invalidate');
  }

  waitForSynthesisIdle(): Promise<void> {
    return this.#synthesisCoordinator.waitForIdle();
  }

  getSynthesisMetrics() {
    return {
      ...this.#synthesisCoordinator.getMetrics(),
      ...(this.supportsBlockStreaming()
        ? {
            composite: {
              ...this.#compositeMetrics,
              fallbackReasons: { ...this.#compositeMetrics.fallbackReasons },
            },
          }
        : {}),
      ...(this.#player instanceof WebAudioPlayer
        ? { playback: this.#player.getDiagnostics() }
        : {}),
    };
  }

  #logSynthesisMetrics(reason: 'invalidate' | 'stop'): void {
    console.info(
      `[TTS][BufferedMetrics] ${JSON.stringify({ client: this.name, reason, ...this.getSynthesisMetrics() })}`,
    );
  }

  protected async stopInternal() {
    this.#stopWordTracking();
    this.#isPlaying = false;
    if (this.#activeGeneration !== null) {
      this.#activeGeneration = null;
      // Unblock a generator awaiting the queue; without this a stop() outside
      // the abort path would leave the consumer parked forever.
      this.#activeQueue?.push({ kind: 'error', message: 'Aborted' });
      this.#activeQueue = null;
      this.#player.abortSession();
    }
  }

  getChunkPosition(): number | null {
    const generation = this.#activeGeneration;
    if (generation === null) return null;
    const pos = this.#player.getPlaybackPosition(generation);
    if (!pos) return null;
    const meta = this.#chunkMeta[pos.chunkIndex];
    if (!meta) return null;
    // Trim-relative and clamped: the section timeline sums TRIMMED durations,
    // while the player reports untrimmed media time (kept that way for word
    // boundaries).
    return Math.min(Math.max(pos.mediaTimeSec - meta.trimStartSec, 0), meta.trimmedDurationSec);
  }

  async setRate(rate: number) {
    // Web path: applied client-side via WSOLA time-stretch at schedule time;
    // takes effect on the next speak() session (the controller restarts
    // playback on rate changes). Native path: applied live by the AVPlayer.
    this.#rate = rate;
    if (this.#player instanceof NativeAudioPlayer) {
      await this.#player.setRate(rate);
    }
  }

  async setPitch(pitch: number) {
    // Passed through to the provider per synthesis request (Edge accepts
    // pitch in [0.5 .. 1.5]).
    if (pitch !== this.#pitch) this.invalidateSynthesis();
    this.#pitch = pitch;
  }

  setParagraphGap(sec: number): void {
    this.#paragraphGapSec = Math.max(0, sec);
  }

  async setVoice(voice: string) {
    const selectedVoice = this.voices.find((v) => v.id === voice);
    if (selectedVoice) {
      if (selectedVoice.id !== this.#currentVoiceId) this.invalidateSynthesis();
      this.#currentVoiceId = selectedVoice.id;
    }
  }

  setSentenceGap(sec: number): void {
    this.#sentenceGapSec = sec;
  }

  registerSectionManifest(section: number, marks: string[]): void {
    if (this.provider instanceof CachingProvider) {
      this.provider.registerSectionManifest(section, marks);
    }
  }

  // Per-ordinal cached durations for the section under the current voice,
  // consumed by the timeline's hydration pass.
  async getSectionDurations(section: number): Promise<Map<number, number>> {
    if (!(this.provider instanceof CachingProvider)) return new Map();
    return this.provider.getSectionDurations(section, this.#currentVoiceId);
  }

  // ── Headless pre-synthesis (TTSDownloader CacheWarmer) ─────────────────

  // Whether this client has a persistent cache to download into.
  canDownload(): boolean {
    return this.provider instanceof CachingProvider && this.provider.cacheable !== false;
  }

  // Synthesize one sentence into the cache (a hit is a no-op) and record its
  // key against the section manifest. Resolves the voice exactly as live
  // playback does, so the computed key matches. Returns whether audio is now
  // cached for it.
  async warmSentence(
    section: number,
    ordinal: number,
    lang: string,
    text: string,
  ): Promise<boolean> {
    if (!(this.provider instanceof CachingProvider)) return false;
    const voiceId = await this.getVoiceIdFromLang(lang);
    const req = { lang, text, voice: voiceId, pitch: this.#pitch };
    try {
      const lease = this.#synthesisCoordinator.acquire(req, {
        priority: 'warmup',
        generation: this.#synthesisCoordinator.generation,
      });
      if (!(await lease.result)) return false;
    } catch {
      // Offline / permanent failure: leave the ordinal unrecorded so the
      // section stays incomplete and can be retried later.
      return false;
    }
    this.provider.recordMark(section, ordinal, req);
    return true;
  }

  async compactCache(): Promise<void> {
    if (this.provider instanceof CachingProvider) await this.provider.compact();
  }

  async getSectionCacheStatuses(): Promise<
    Map<number, { total: number; recorded: number; packed: boolean }>
  > {
    if (!(this.provider instanceof CachingProvider)) return new Map();
    return this.provider.getSectionStatuses();
  }

  async getCacheBytes(): Promise<number> {
    if (!(this.provider instanceof CachingProvider)) return 0;
    return this.provider.totalCacheBytes();
  }

  async getAllVoices(): Promise<TTSVoice[]> {
    this.voices.forEach((voice) => {
      voice.disabled = !this.initialized;
    });
    return this.voices;
  }

  async getVoices(lang: string) {
    const locale = lang === 'en' ? getUserLocale(lang) || lang : lang;
    const voices = await this.getAllVoices();
    // Match by primary language so the voice set stays the same across a book
    // whose sections mix region variants (e.g. en-US front matter and en-GB
    // body text); the requested locale's voices sort first. See #4033.
    const filteredVoices = voices.filter((v) => isSameLang(v.lang, lang));

    const voicesGroup: TTSVoicesGroup = {
      id: this.name,
      name: this.provider.label,
      voices: filteredVoices.sort(TTSUtils.sortVoicesPreferLocaleFunc(locale)),
      disabled: !this.initialized || filteredVoices.length === 0,
    };

    return [voicesGroup];
  }

  setPrimaryLang(lang: string) {
    if (lang !== this.#primaryLang) this.invalidateSynthesis();
    this.#primaryLang = lang;
  }

  getCapabilities(): TTSCapabilities {
    return {
      wordBoundaries: true,
      mediaClock: true,
      gapControl: true,
      // The native player time-stretches live; the web path bakes the rate
      // into the scheduled buffers, so it needs a session restart.
      liveRateChange: this.#player instanceof NativeAudioPlayer,
      cacheable: this.provider.cacheable !== false,
      downloadable: false,
      measurableDurations: true,
    };
  }

  getGranularities(): TTSGranularity[] {
    return ['sentence'];
  }

  getVoiceId(): string {
    return this.#currentVoiceId;
  }

  getSpeakingLang(): string {
    return this.#speakingLang;
  }

  async shutdown(): Promise<void> {
    await this.stopInternal();
    this.#synthesisCoordinator.shutdown();
    await this.#synthesisCoordinator.waitForIdle();
    await this.#player.shutdown();
    await this.provider.shutdown?.();
    this.initialized = false;
    this.voices = [];
  }
}
