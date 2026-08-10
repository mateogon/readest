// Gapless chunk scheduler on a persistent Web Audio context.
//
// Sentence buffers are scheduled back-to-back into an always-running
// AudioContext so the OS-level output stream never stops between sentences or
// paragraphs — per-sentence track restarts are what let Bluetooth fade-in /
// noise gates swallow the first word (#3851) and what put audible gaps
// between sentences (#2033). Chunk transitions ride source onended callbacks
// (background-safe when rAF and timers are throttled with the screen off);
// word-highlight polling is the only rAF consumer, and it lives in the client.
//
// The real AudioContext is a MODULE-LEVEL SINGLETON shared by all player
// instances and never closed: a fresh TTSController (and thus client+player)
// is constructed per tts-speak, and WebKit caps live AudioContexts (~4 on
// iOS) — per-player contexts would leak until every new one is born suspended
// and TTS goes silent. Sessions are isolated purely by generation tokens.
//
// This module speaks to the context through structural interfaces so jsdom
// tests can drive a fake clock.
//
// iOS now-playing note: TTS has no HTMLMediaElement (chunks connect straight
// to ctx.destination), so WebKit never publishes a now-playing session for it.
// Routing the graph through a MediaStreamAudioDestinationNode + <audio> was
// tried and reverted: WebKit then published the element's own stream clock,
// fighting setPositionState on the lock screen/CarPlay (jumping timeline) and
// rendering underrun glitches while the context was suspended. iOS instead
// drives MPNowPlayingInfoCenter/MPRemoteCommandCenter natively via the
// native-tts plugin (getMediaSession -> TauriMediaSession).

import type { TTSAudioPlayer } from './TTSAudioPlayer';
import type { TTSPlaybackTransition } from './types';

export interface TTSAudioBuffer {
  readonly sampleRate: number;
  readonly length: number;
  readonly duration: number;
  getChannelData(channel: number): Float32Array;
  copyToChannel(source: Float32Array, channel: number): void;
}

export interface TTSAudioBufferSourceNode {
  buffer: TTSAudioBuffer | null;
  onended: (() => void) | null;
  connect(destination: unknown): void;
  disconnect(): void;
  start(when?: number, offset?: number, duration?: number): void;
  stop(when?: number): void;
}

export interface TTSAudioContext {
  readonly currentTime: number;
  readonly state: string; // 'running' | 'suspended' | 'interrupted' | 'closed'
  readonly destination: unknown;
  onstatechange: (() => void) | null;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
  createBufferSource(): TTSAudioBufferSourceNode;
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): TTSAudioBuffer;
  decodeAudioData(data: ArrayBuffer): Promise<TTSAudioBuffer>;
}

export interface ChunkTiming {
  // Leading trim in original (rate-1.0) media time; word boundaries live there.
  trimStartSec: number;
  // originalTrimmedDuration / outputDuration (≈ playback rate).
  mediaScale: number;
  // Silence scheduled after this chunk; the caller rate-scales it.
  gapSec: number;
  // Logical transition into this chunk. Undefined preserves the historical
  // inference: the first chunk uses the session transition and later chunks
  // are sentences. Null explicitly suppresses transition diagnostics.
  transitionFromPrevious?: 'sentence' | TTSPlaybackTransition;
  // Internal logical-mark starts in prepared/output seconds from this
  // buffer's start. Index zero is represented by chunk-start; these offsets
  // therefore map to logical indexes 1..N. They drive silent Web Audio marker
  // nodes, never cuts or gaps in the audible buffer.
  logicalBoundaryOffsetsSec?: readonly number[];
}

export type WebAudioPlayerEvent =
  | { type: 'chunk-start'; chunkIndex: number }
  | { type: 'logical-boundary'; chunkIndex: number; logicalIndex: number }
  | { type: 'session-end' }
  | { type: 'context-error'; message: string };

interface ScheduledChunk {
  index: number;
  source: TTSAudioBufferSourceNode;
  startTime: number;
  started: boolean;
  duration: number;
  timing: ChunkTiming;
  transitionKind: 'sentence' | TTSPlaybackTransition;
  diagnosticKind: 'sentence' | 'paragraph' | 'chapter' | 'cold-start' | null;
  configuredGapSec: number | null;
  unplannedGapMs: number | null;
  logicalMarkers: TTSAudioBufferSourceNode[];
  logicalMarkerEnded: boolean[];
  nextLogicalIndex: number;
  ended: boolean;
}

interface PlayerSession {
  generation: number;
  onEvent: (event: WebAudioPlayerEvent) => void;
  leadingGapSec: number;
  transitionFromPrevious: TTSPlaybackTransition;
  coldStartPending: boolean;
  startupBufferSec: number;
  refillBufferSec: number;
  maxPendingVisible: number;
  maxPendingHidden: number;
  buffering: 'startup' | 'refill' | null;
  chunks: ScheduledChunk[];
  nextChunkIndex: number;
  nextStartTime: number;
  ended: boolean;
  endedEmitted: boolean;
  waiters: Array<(ready: boolean) => void>;
}

export interface TransitionGapDiagnostics {
  transitions: number;
  gapsOver50Ms: number;
  gapsOver500Ms: number;
  unplannedGapMsP50: number;
  unplannedGapMsP95: number;
  unplannedGapMsP99: number;
  unplannedGapMsMax: number;
}

export interface WebAudioPlayerDiagnostics {
  sessionsStarted: number;
  sessionsCompleted: number;
  sessionsAborted: number;
  // Admission count; unlike transition samples, a later abort can make a
  // scheduled chunk inaudible.
  scheduledChunks: number;
  // Samples are committed only from onended, after the target chunk played.
  sentenceGaps: TransitionGapDiagnostics;
  paragraphGaps: TransitionGapDiagnostics;
  chapterGaps: TransitionGapDiagnostics;
  // Refill transitions after the first chapter chunk remain cold-start work
  // until one chunk is admitted within the steady-state latency target.
  coldStartGaps: TransitionGapDiagnostics;
  // Scheduled playout horizon through the end of the last audible buffer;
  // intentionally excludes trailing silence and synthesis/cache lookahead.
  currentBufferAheadMs: number;
  maxBufferAheadMs: number;
  // Only unfinished chunks plus, during an underrun, the latest completed
  // timing anchor remain owned by the session.
  retainedChunks: number;
}

export interface WebAudioSessionOptions {
  // Controller-owned context. Automatic continuation distinguishes ordinary
  // paragraphs from chapter boundaries; manual starts and seeks pass null.
  transitionFromPrevious?: TTSPlaybackTransition;
  // Intentional inter-block silence, already scaled for playback rate.
  leadingGapSec?: number;
  // Atomic local engines can take longer to prepare the next chunk than the
  // current chunk takes to play. Hold the first prepared chunks until this
  // audible horizon is available instead of starting with a one-chunk lead.
  startupBufferSec?: number;
  // After a real underrun, rebuild this much audible horizon before resuming.
  // A zero value preserves immediate late-chunk admission.
  refillBufferSec?: number;
  // Per-session backpressure budgets. Buffered local engines need enough
  // pending work to reach their reservoir target; network engines retain the
  // historical defaults.
  maxPendingVisible?: number;
  maxPendingHidden?: number;
}

// Small offset so start() never lands in the past between the read of
// currentTime and the schedule call.
const SCHEDULE_SAFETY_SEC = 0.03;
// Screen-off JS throttling must not starve the queue between onended and the
// next schedule, so the pending budget deepens when the page is hidden.
const MAX_PENDING_VISIBLE = 2;
const MAX_PENDING_HIDDEN = 5;
// Bounds decoded PCM at slow rates (0.2x stretches a 30s sentence to 150s).
const MAX_AHEAD_SEC = 60;
const MAX_GAP_SAMPLES = 2048;
const STEADY_STATE_GAP_THRESHOLD_MS = 50;

const nearestRank = (values: number[], percentile: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * percentile) - 1);
  return sorted[index] ?? 0;
};

const summarizeGaps = (values: number[]): TransitionGapDiagnostics => ({
  transitions: values.length,
  gapsOver50Ms: values.filter((gap) => gap > 50).length,
  gapsOver500Ms: values.filter((gap) => gap > 500).length,
  unplannedGapMsP50: Math.round(nearestRank(values, 0.5)),
  unplannedGapMsP95: Math.round(nearestRank(values, 0.95)),
  unplannedGapMsP99: Math.round(nearestRank(values, 0.99)),
  unplannedGapMsMax: Math.round(values.reduce((max, gap) => Math.max(max, gap), 0)),
});

let sharedContext: TTSAudioContext | null = null;

const getSharedContext = (): TTSAudioContext => {
  if (!sharedContext) {
    sharedContext = new AudioContext() as unknown as TTSAudioContext;
  }
  return sharedContext;
};

// Warm up (create + resume) the shared context. Call this synchronously in a
// user-gesture handler: speak() itself runs after network awaits, outside
// WebKit's gesture window, where resume() can be rejected by autoplay policy.
export const ensureSharedAudioContext = async (): Promise<void> => {
  if (typeof AudioContext === 'undefined') return;
  try {
    const ctx = getSharedContext();
    if (ctx.state !== 'running') {
      await ctx.resume();
    }
  } catch (err) {
    console.warn('[TTS] audio context warmup failed', err);
  }
};

// Inaudible background keep-alive for a page that must stay schedulable.
//
// When the app is backgrounded (or the screen locks) the WebView page becomes
// hidden, and Chromium throttles — then outright freezes — a hidden page's
// timers and task queues. A page that is emitting audio is exempt: that is
// precisely why Edge TTS keeps reading with the screen off (its speech is
// audible WebAudio output) while system TTS stops after a page. Merely having a
// running-but-idle context does NOT earn the exemption — Chromium keys off
// actual, non-silent output — so we play a continuous 40 Hz tone at ~-62 dBFS:
// below the reach of phone speakers and masked to inaudibility by the speech,
// but non-silent enough to keep the page "audible" and its timers alive.
//
// Two things depend on it: the JS-driven per-sentence auto-advance loop that
// direct-speak engines rely on while playing (#4408), and — for EVERY engine —
// the media-session transport handlers of a *paused* session, which live in the
// page even though the notification itself is served by the native foreground
// service (#5561).
const KEEP_ALIVE_FREQ_HZ = 40;
const KEEP_ALIVE_GAIN = 0.0008;
let keepAliveCtx: AudioContext | null = null;
let keepAliveOsc: OscillatorNode | null = null;
let keepAliveGain: GainNode | null = null;

export const startAudioKeepAlive = (): void => {
  if (typeof AudioContext === 'undefined') return;
  if (keepAliveOsc) return;
  try {
    // A context of its OWN, never the shared one: buffered engines suspend the
    // shared context to pause (WebAudioPlayer.pauseContext), which would
    // silence the tone exactly when a paused session needs it — and resuming
    // that context to feed the tone would un-pause the speech.
    if (!keepAliveCtx) keepAliveCtx = new AudioContext();
    const ctx = keepAliveCtx;
    // TTS only ever starts from a user gesture, so the page has sticky
    // activation and the context comes up running; nudge it best-effort in
    // case autoplay policy left it suspended.
    if (ctx.state !== 'running') void ctx.resume();
    const osc = ctx.createOscillator();
    osc.frequency.value = KEEP_ALIVE_FREQ_HZ;
    const gain = ctx.createGain();
    gain.gain.value = KEEP_ALIVE_GAIN;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    keepAliveOsc = osc;
    keepAliveGain = gain;
  } catch (err) {
    console.warn('[TTS] audio keep-alive start failed', err);
  }
};

export const stopAudioKeepAlive = (): void => {
  if (!keepAliveOsc && !keepAliveGain) return;
  try {
    keepAliveOsc?.stop();
    keepAliveOsc?.disconnect();
    keepAliveGain?.disconnect();
    // Close rather than suspend: an idle-but-running context still renders
    // silence to an open output stream, and unlike the shared context this one
    // has no other use. A later start() builds a fresh one, which is also the
    // path that has to work when Pause arrives with the app already hidden.
    void keepAliveCtx?.close();
  } catch (err) {
    console.warn('[TTS] audio keep-alive stop failed', err);
  }
  keepAliveCtx = null;
  keepAliveOsc = null;
  keepAliveGain = null;
};

export class WebAudioPlayer implements TTSAudioPlayer {
  #createContext: () => TTSAudioContext;
  #usesSharedContext: boolean;
  #ctx: TTSAudioContext | null = null;
  #generation = 0;
  #session: PlayerSession | null = null;
  #userPaused = false;
  #sessionsStarted = 0;
  #sessionsCompleted = 0;
  #sessionsAborted = 0;
  #scheduledChunks = 0;
  #sentenceGapMs: number[] = [];
  #paragraphGapMs: number[] = [];
  #chapterGapMs: number[] = [];
  #coldStartGapMs: number[] = [];
  #lastAudibleEndSec: number | null = null;
  #maxBufferAheadMs = 0;

  constructor(createContext?: () => TTSAudioContext) {
    this.#createContext = createContext ?? getSharedContext;
    this.#usesSharedContext = !createContext;
  }

  async ensureContext(): Promise<TTSAudioContext> {
    if (!this.#ctx) {
      this.#ctx = this.#createContext();
      this.#ctx.onstatechange = () => this.#handleStateChange();
    }
    if (this.#ctx.state !== 'running' && !this.#userPaused) {
      await this.#ctx.resume();
    }
    return this.#ctx;
  }

  async decode(data: ArrayBuffer): Promise<TTSAudioBuffer> {
    const ctx = await this.ensureContext();
    return ctx.decodeAudioData(data);
  }

  async createMonoBuffer(samples: Float32Array, sampleRate: number): Promise<TTSAudioBuffer> {
    const ctx = await this.ensureContext();
    const buffer = ctx.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    return buffer;
  }

  startSession(
    onEvent: (event: WebAudioPlayerEvent) => void,
    options: WebAudioSessionOptions = {},
  ): number {
    this.abortSession();
    const generation = ++this.#generation;
    this.#sessionsStarted += 1;
    const transitionFromPrevious = options.transitionFromPrevious ?? null;
    if (transitionFromPrevious === null) this.#lastAudibleEndSec = null;
    this.#session = {
      generation,
      onEvent,
      leadingGapSec: Math.max(0, options.leadingGapSec ?? 0),
      transitionFromPrevious,
      coldStartPending: false,
      startupBufferSec: Math.max(0, options.startupBufferSec ?? 0),
      refillBufferSec: Math.max(0, options.refillBufferSec ?? 0),
      maxPendingVisible: Math.max(1, Math.floor(options.maxPendingVisible ?? MAX_PENDING_VISIBLE)),
      maxPendingHidden: Math.max(1, Math.floor(options.maxPendingHidden ?? MAX_PENDING_HIDDEN)),
      buffering: (options.startupBufferSec ?? 0) > 0 ? 'startup' : null,
      chunks: [],
      nextChunkIndex: 0,
      nextStartTime: 0,
      ended: false,
      endedEmitted: false,
      waiters: [],
    };
    console.log(`[TTS] session ${generation} start`);
    return generation;
  }

  scheduleChunk(generation: number, buffer: TTSAudioBuffer, timing: ChunkTiming): void {
    const session = this.#session;
    const ctx = this.#ctx;
    if (!session || session.generation !== generation || !ctx) return;
    const logicalBoundaryOffsetsSec = timing.logicalBoundaryOffsetsSec ?? [];
    let previousLogicalOffsetSec = 0;
    for (const offsetSec of logicalBoundaryOffsetsSec) {
      if (
        !Number.isFinite(offsetSec) ||
        offsetSec <= previousLogicalOffsetSec ||
        offsetSec >= buffer.duration
      ) {
        throw new Error('Invalid logical boundary offset');
      }
      previousLogicalOffsetSec = offsetSec;
    }
    const previousChunk = session.chunks.at(-1);
    const hasPreviousAudio = previousChunk !== undefined || this.#lastAudibleEndSec !== null;
    const inferredTransition = previousChunk
      ? 'sentence'
      : session.transitionFromPrevious !== null && this.#lastAudibleEndSec !== null
        ? session.transitionFromPrevious
        : null;
    const requestedTransition = timing.transitionFromPrevious;
    const transitionKind =
      requestedTransition === undefined
        ? inferredTransition
        : requestedTransition !== null && hasPreviousAudio
          ? requestedTransition
          : null;
    const configuredGapSec =
      transitionKind === null
        ? null
        : previousChunk
          ? Math.max(0, previousChunk.timing.gapSec)
          : session.leadingGapSec;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const logicalMarkerBuffer =
      logicalBoundaryOffsetsSec.length > 0 ? ctx.createBuffer(1, 1, buffer.sampleRate) : null;
    const logicalMarkers = logicalBoundaryOffsetsSec.map(() => {
      const marker = ctx.createBufferSource();
      marker.buffer = logicalMarkerBuffer;
      return marker;
    });
    source.connect(ctx.destination);
    for (const marker of logicalMarkers) marker.connect(ctx.destination);
    const chunk: ScheduledChunk = {
      index: session.nextChunkIndex++,
      source,
      startTime: 0,
      started: false,
      duration: buffer.duration,
      timing,
      transitionKind,
      diagnosticKind: null,
      configuredGapSec,
      unplannedGapMs: null,
      logicalMarkers,
      logicalMarkerEnded: logicalMarkers.map(() => false),
      nextLogicalIndex: 1,
      ended: false,
    };
    source.onended = () => this.#handleChunkEnded(session, chunk);
    for (let index = 0; index < logicalMarkers.length; index++) {
      const marker = logicalMarkers[index]!;
      marker.onended = () => {
        marker.onended = null;
        try {
          marker.disconnect();
        } catch {
          // The platform may already have released a completed source.
        }
        if (this.#session !== session) return;
        chunk.logicalMarkerEnded[index] = true;
        this.#flushLogicalBoundaries(session, chunk);
      };
    }
    session.chunks.push(chunk);
    this.#scheduledChunks += 1;
    this.#updateMaxBufferAhead(session);
    this.#releaseBufferedChunks(session);
  }

  endSession(generation: number): void {
    const session = this.#session;
    if (!session || session.generation !== generation) return;
    session.ended = true;
    // A short final section may never reach the normal startup/refill target.
    // Source exhaustion is the safe force-release signal.
    this.#releaseBufferedChunks(session, true);
    // Fires synchronously when nothing is unfinished: a session whose marks
    // were all skipped (zero chunks) or whose last onended beat endSession
    // must still end, or auto-advance dead-ends with controls stuck playing.
    this.#maybeEmitSessionEnd(session);
  }

  abortSession(): void {
    const session = this.#session;
    if (!session) return;
    this.#session = null;
    if (!session.endedEmitted) {
      this.#sessionsAborted += 1;
      this.#lastAudibleEndSec = null;
    }
    for (const chunk of session.chunks) {
      chunk.source.onended = null;
      try {
        chunk.source.stop();
      } catch {
        // Sources that never started or already ended throw; irrelevant here.
      }
      try {
        chunk.source.disconnect();
      } catch {
        // Ignore repeated disconnects.
      }
      for (const marker of chunk.logicalMarkers) {
        marker.onended = null;
        try {
          marker.stop();
        } catch {
          // Sources that already ended throw; irrelevant during teardown.
        }
        try {
          marker.disconnect();
        } catch {
          // Ignore repeated disconnects.
        }
      }
    }
    const waiters = session.waiters;
    session.waiters = [];
    for (const waiter of waiters) waiter(false);
    console.log(
      `[TTS] session ${session.generation} ${session.endedEmitted ? 'release' : 'abort'}`,
    );
  }

  getDiagnostics(): WebAudioPlayerDiagnostics {
    const currentBufferAheadMs = this.#session ? this.#bufferAheadSec(this.#session) * 1000 : 0;
    return {
      sessionsStarted: this.#sessionsStarted,
      sessionsCompleted: this.#sessionsCompleted,
      sessionsAborted: this.#sessionsAborted,
      scheduledChunks: this.#scheduledChunks,
      sentenceGaps: summarizeGaps(this.#sentenceGapMs),
      paragraphGaps: summarizeGaps(this.#paragraphGapMs),
      chapterGaps: summarizeGaps(this.#chapterGapMs),
      coldStartGaps: summarizeGaps(this.#coldStartGapMs),
      currentBufferAheadMs: Math.round(currentBufferAheadMs),
      maxBufferAheadMs: Math.round(this.#maxBufferAheadMs),
      retainedChunks: this.#session?.chunks.length ?? 0,
    };
  }

  async waitUntilReady(generation: number): Promise<boolean> {
    for (;;) {
      const session = this.#session;
      if (!session || session.generation !== generation) return false;
      if (this.#isReadyForMore(session)) return true;
      const ready = await new Promise<boolean>((resolve) => {
        session.waiters.push(resolve);
      });
      if (!ready) return false;
    }
  }

  async pauseContext(): Promise<void> {
    this.#userPaused = true;
    if (this.#ctx && this.#ctx.state === 'running') {
      await this.#ctx.suspend();
    }
  }

  async resumeContext(): Promise<void> {
    this.#userPaused = false;
    const ctx = this.#ctx;
    if (!ctx) return;
    await ctx.resume();
    if (ctx.state !== 'running') {
      // iOS can refuse to leave 'interrupted' (e.g. right after a phone
      // call); fail loudly so the controller stops visibly instead of
      // showing "playing" over silence.
      throw new Error(`AudioContext failed to resume (state: ${ctx.state})`);
    }
  }

  isUserPaused(): boolean {
    return this.#userPaused;
  }

  getPlaybackPosition(generation: number): { chunkIndex: number; mediaTimeSec: number } | null {
    const session = this.#session;
    const ctx = this.#ctx;
    if (!session || session.generation !== generation || !ctx) return null;
    const startedChunks = session.chunks.filter((chunk) => chunk.started);
    const first = startedChunks[0];
    if (!first) return null;
    const t = ctx.currentTime;
    let active = first;
    for (const chunk of startedChunks) {
      if (chunk.startTime <= t) active = chunk;
      else break;
    }
    const within = Math.min(Math.max(t - active.startTime, 0), active.duration);
    return {
      chunkIndex: active.index,
      mediaTimeSec: active.timing.trimStartSec + within * active.timing.mediaScale,
    };
  }

  async shutdown(): Promise<void> {
    this.abortSession();
    if (this.#ctx && !this.#usesSharedContext) {
      // Test-injected contexts are owned by this player; the shared context
      // stays alive for the whole page (see module comment).
      await this.#ctx.close().catch(() => {});
    }
    this.#ctx = null;
  }

  #isReadyForMore(session: PlayerSession): boolean {
    const unfinished = session.chunks.reduce((n, c) => n + (c.ended ? 0 : 1), 0);
    const limit =
      typeof document !== 'undefined' && document.visibilityState === 'hidden'
        ? session.maxPendingHidden
        : session.maxPendingVisible;
    if (unfinished >= limit) return false;
    if (this.#bufferAheadSec(session) >= MAX_AHEAD_SEC) return false;
    return true;
  }

  #bufferAheadSec(session: PlayerSession): number {
    const ctx = this.#ctx;
    if (!ctx) return 0;
    const startedEndSec = session.chunks.reduce(
      (end, chunk) =>
        chunk.started && !chunk.ended ? Math.max(end, chunk.startTime + chunk.duration) : end,
      ctx.currentTime,
    );
    const pending = session.chunks.filter((chunk) => !chunk.started && !chunk.ended);
    const pendingSec = pending.reduce(
      (total, chunk, index) =>
        total +
        chunk.duration +
        (index < pending.length - 1 ? Math.max(0, chunk.timing.gapSec) : 0),
      0,
    );
    return Math.max(0, startedEndSec - ctx.currentTime) + pendingSec;
  }

  #updateMaxBufferAhead(session: PlayerSession): void {
    this.#maxBufferAheadMs = Math.max(this.#maxBufferAheadMs, this.#bufferAheadSec(session) * 1000);
  }

  #releaseBufferedChunks(session: PlayerSession, force = false): void {
    const ctx = this.#ctx;
    if (!ctx || this.#session !== session) return;
    const pending = session.chunks.filter((chunk) => !chunk.started && !chunk.ended);
    if (pending.length === 0) return;

    if (session.buffering !== null && !force) {
      const targetSec =
        session.buffering === 'startup' ? session.startupBufferSec : session.refillBufferSec;
      const pendingLimit =
        typeof document !== 'undefined' && document.visibilityState === 'hidden'
          ? session.maxPendingHidden
          : session.maxPendingVisible;
      // Never let the reservoir target deadlock against backpressure when a
      // run of unusually short chunks fills every pending slot first.
      if (this.#bufferAheadSec(session) < targetSec && pending.length < pendingLimit) return;
    }
    session.buffering = null;

    for (const chunk of pending) {
      const previousChunk = session.chunks.find((candidate) => candidate.index === chunk.index - 1);
      const targetStartTime =
        chunk.transitionKind === null || chunk.configuredGapSec === null
          ? null
          : previousChunk?.started
            ? previousChunk.startTime + previousChunk.duration + chunk.configuredGapSec
            : this.#lastAudibleEndSec !== null
              ? this.#lastAudibleEndSec + chunk.configuredGapSec
              : null;
      const start = Math.max(session.nextStartTime, ctx.currentTime + SCHEDULE_SAFETY_SEC);
      const unplannedGapMs =
        targetStartTime === null ? null : Math.max(0, start - targetStartTime) * 1000;
      const chapterStart = previousChunk === undefined && chunk.transitionKind === 'chapter';
      const diagnosticKind =
        chunk.transitionKind === null
          ? null
          : session.coldStartPending && previousChunk !== undefined
            ? 'cold-start'
            : chunk.transitionKind;
      if (chapterStart) {
        session.coldStartPending = true;
      } else if (
        diagnosticKind === 'cold-start' &&
        unplannedGapMs !== null &&
        unplannedGapMs <= STEADY_STATE_GAP_THRESHOLD_MS
      ) {
        session.coldStartPending = false;
      }
      if (chunk.index === 0) this.#lastAudibleEndSec = null;

      chunk.startTime = start;
      chunk.started = true;
      chunk.diagnosticKind = diagnosticKind;
      chunk.unplannedGapMs = unplannedGapMs;
      session.nextStartTime = start + chunk.duration + Math.max(0, chunk.timing.gapSec);
      chunk.source.start(start);
      for (let index = 0; index < chunk.logicalMarkers.length; index++) {
        chunk.logicalMarkers[index]!.start(
          start + (chunk.timing.logicalBoundaryOffsetsSec?.[index] ?? 0),
        );
      }
      const bufferAheadMs = this.#bufferAheadSec(session) * 1000;
      this.#maxBufferAheadMs = Math.max(this.#maxBufferAheadMs, bufferAheadMs);
      console.info(
        `[TTS][WebAudio] ${JSON.stringify({
          event: 'scheduled',
          generation: session.generation,
          chunkIndex: chunk.index,
          startSec: Number(start.toFixed(3)),
          durationSec: Number(chunk.duration.toFixed(3)),
          transitionKind: chunk.transitionKind,
          diagnosticKind,
          configuredGapMs:
            chunk.configuredGapSec === null
              ? null
              : Math.round(Math.max(0, chunk.configuredGapSec) * 1000),
          unplannedGapMs: unplannedGapMs === null ? null : Math.round(unplannedGapMs),
          bufferAheadMs: Math.round(bufferAheadMs),
        })}`,
      );
      if (chunk.index === 0 || previousChunk?.ended) {
        // Normally the previous source announces this chunk from its onended
        // callback. Startup and refill reservoirs have no active predecessor,
        // so their first released chunk must announce itself here.
        session.onEvent({ type: 'chunk-start', chunkIndex: chunk.index });
      }
      if (previousChunk?.ended) this.#discardEndedBefore(session, chunk.index);
    }
  }

  #handleChunkEnded(session: PlayerSession, chunk: ScheduledChunk): void {
    if (this.#session !== session || chunk.ended) return;
    // Chromium may deliver several audio-node callbacks in one foreground
    // turn after background throttling. The audible source cannot end before
    // its internal marker times have passed, so flush any callbacks still
    // queued by the browser before announcing the next chunk/session end.
    chunk.logicalMarkerEnded.fill(true);
    this.#flushLogicalBoundaries(session, chunk);
    chunk.ended = true;
    for (const marker of chunk.logicalMarkers) {
      marker.onended = null;
      try {
        marker.disconnect();
      } catch {
        // A completed source may already be disconnected by the platform.
      }
    }
    this.#lastAudibleEndSec = chunk.startTime + chunk.duration;
    if (chunk.diagnosticKind !== null && chunk.unplannedGapMs !== null) {
      const gaps =
        chunk.diagnosticKind === 'sentence'
          ? this.#sentenceGapMs
          : chunk.diagnosticKind === 'paragraph'
            ? this.#paragraphGapMs
            : chunk.diagnosticKind === 'chapter'
              ? this.#chapterGapMs
              : this.#coldStartGapMs;
      gaps.push(chunk.unplannedGapMs);
      if (gaps.length > MAX_GAP_SAMPLES) gaps.shift();
    }
    const waiters = session.waiters;
    session.waiters = [];
    for (const waiter of waiters) waiter(true);
    const next = session.chunks.find((candidate) => candidate.index === chunk.index + 1);
    if (next?.started) {
      session.onEvent({ type: 'chunk-start', chunkIndex: next.index });
      this.#discardEndedBefore(session, next.index);
    } else if (!session.ended && session.refillBufferSec > 0) {
      // The synthesis pipeline lost the race with playout. Late chunks now
      // rebuild a useful reservoir instead of resuming for one short fragment
      // and immediately stalling again.
      session.buffering = 'refill';
    }
    this.#maybeEmitSessionEnd(session);
  }

  #flushLogicalBoundaries(session: PlayerSession, chunk: ScheduledChunk): void {
    if (this.#session !== session) return;
    while (chunk.nextLogicalIndex <= chunk.logicalMarkers.length) {
      if (!chunk.logicalMarkerEnded[chunk.nextLogicalIndex - 1]) return;
      session.onEvent({
        type: 'logical-boundary',
        chunkIndex: chunk.index,
        logicalIndex: chunk.nextLogicalIndex,
      });
      chunk.nextLogicalIndex += 1;
    }
  }

  #discardEndedBefore(session: PlayerSession, retainedIndex: number): void {
    let discardCount = 0;
    while (discardCount < session.chunks.length) {
      const candidate = session.chunks[discardCount]!;
      if (!candidate.ended || candidate.index >= retainedIndex) break;
      candidate.source.onended = null;
      try {
        candidate.source.disconnect();
      } catch {
        // A completed source may already be disconnected by the platform.
      }
      discardCount += 1;
    }
    if (discardCount > 0) session.chunks.splice(0, discardCount);
  }

  #maybeEmitSessionEnd(session: PlayerSession): void {
    if (!session.ended || session.endedEmitted) return;
    if (session.chunks.some((c) => !c.ended)) return;
    session.endedEmitted = true;
    this.#sessionsCompleted += 1;
    session.onEvent({ type: 'session-end' });
  }

  #handleStateChange(): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    if (ctx.state === 'running' || this.#userPaused) return;
    if (!this.#session) return;
    // Unexpected suspension (iOS 'interrupted', route change) during live
    // playback: try to keep going. If the OS refuses, the next user action
    // surfaces the failure through resumeContext().
    console.log(`[TTS] audio context ${ctx.state}; attempting auto-resume`);
    ctx.resume().catch((err) => {
      console.warn('[TTS] audio context auto-resume failed', err);
      this.#session?.onEvent({
        type: 'context-error',
        message: `AudioContext ${ctx.state}`,
      });
    });
  }
}
