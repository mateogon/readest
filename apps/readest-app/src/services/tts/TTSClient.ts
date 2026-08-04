import { TTSGranularity, TTSMark, TTSPlaybackTransition, TTSVoice, TTSVoicesGroup } from './types';
import type { SynthesisCoordinatorMetrics } from './SynthesisCoordinator';
import type { WebAudioPlayerDiagnostics } from './WebAudioPlayer';

// A semantic sentence may be arbitrarily long (or become long after a broken
// abbreviation heuristic). Keep every engine request acoustically bounded at
// real DOM ranges so navigation, highlighting, and timelines share the same
// segments instead of inventing invisible transport-only continuations.
export const DEFAULT_TTS_MAX_SEGMENT_CHARS = 200;

type TTSMessageCode = 'boundary' | 'error' | 'end';

export interface TTSMessageEvent {
  code: TTSMessageCode;
  message?: string;
  mark?: string;
  // Valid only on `code: 'boundary'`; emitted when playback reaches a logical
  // mark transition in a streamed block. It may precede audio samples by an
  // intentional configured gap.
  // Block labels are local to each SSML fragment, so blockOffset is part of
  // the identity even when adjacent blocks both contain a mark named "0".
  logicalBoundary?: {
    blockOffset: number;
    mark: TTSMark;
  };
  // On a successful terminal `end`, the last block fully consumed by the
  // client. This lets the controller commit trailing empty/skipped blocks
  // without moving the live document cursor for merely planned audio.
  consumedBlockOffset?: number;
}

export interface TTSBlockInput {
  // Current block is zero; future blocks increase monotonically within the
  // same document section.
  blockOffset: number;
  ssml: string;
}

export interface TTSRuntimeMetrics extends SynthesisCoordinatorMetrics {
  playback?: WebAudioPlayerDiagnostics;
}

// What the active engine can actually do, so the controller and UI degrade
// uniformly instead of probing per-feature or comparing client identities.
export interface TTSCapabilities {
  // Reports word-boundary timings during playback: the controller highlights
  // word-by-word and suppresses the sentence highlight.
  wordBoundaries: boolean;
  // Has a real audio clock: getChunkPosition() returns positions, enabling
  // the scrubber/seek via the section timeline.
  mediaClock: boolean;
  // The inter-sentence gap setting applies.
  gapControl: boolean;
  // Rate changes apply to in-flight audio without restarting the session.
  liveRateChange: boolean;
  // Provider permits prepared audio to be persisted under a safe identity.
  cacheable: boolean;
  // Active client exposes a real headless download/cache workflow.
  downloadable: boolean;
  // Sentence durations can be measured/refined for a section timeline.
  measurableDurations: boolean;
  // Consecutive blocks are one continuous recording rather than separate
  // utterances, so the controller must not insert its own pauses between them —
  // the recording already contains the pauses its narrator made.
  continuousTimeline?: boolean;
}

export interface TTSClient {
  name: string;
  initialized: boolean;
  init(): Promise<boolean>;
  shutdown(): Promise<void>;
  speak(
    ssml: string,
    signal: AbortSignal,
    preload?: boolean,
    preloadPriority?: 'next' | 'prefetch',
    transitionFromPrevious?: TTSPlaybackTransition,
  ): AsyncIterable<TTSMessageEvent>;
  // Paired optional methods: a client opts into streamed logical blocks only
  // when it explicitly advertises support and implements speakBlocks. The
  // returned stream must finish with one terminal `end` or `error` event.
  // Established clients retain the single-SSML path.
  supportsBlockStreaming?(): boolean;
  speakBlocks?(
    blocks: AsyncIterable<TTSBlockInput>,
    signal: AbortSignal,
    transitionFromPrevious?: TTSPlaybackTransition,
  ): AsyncIterable<TTSMessageEvent>;
  pause(): Promise<boolean>;
  resume(): Promise<boolean>;
  // `handover` marks the stop the controller performs between two consecutive
  // utterances of the same session, as opposed to a real stop. A continuous
  // recording may stay rolling; synthesized clients can ignore the hint.
  stop(handover?: boolean): Promise<void>;
  // Drop queued/prepared synthesis after a logical navigation or acoustic
  // configuration change. Pause/resume and sequential auto-advance preserve it.
  invalidateSynthesis?(): void;
  // Resolve only after provider-side cancellation has completed and no native
  // synthesis lease remains active. Client switches sharing one OS engine must
  // await this before applying the next client's mutable configuration.
  waitForSynthesisIdle?(): Promise<void>;
  // Structured, text-free counters for live buffer diagnostics.
  getSynthesisMetrics?(): TTSRuntimeMetrics;
  setPrimaryLang(lang: string): void;
  setRate(rate: number): Promise<void>;
  setPitch(pitch: number): Promise<void>;
  setVoice(voice: string): Promise<void>;
  setSentenceGap?(sec: number): void;
  // Diagnostic copy of the controller-owned inter-paragraph delay. Buffered
  // players use it only to separate intentional silence from underrun.
  setParagraphGap?(sec: number): void;
  getAllVoices(): Promise<TTSVoice[]>;
  getVoices(lang: string): Promise<TTSVoicesGroup[]>;
  getGranularities(): TTSGranularity[];
  getCapabilities(): TTSCapabilities;
  // Ordered sentence labels for a section (timeline enumeration), consumed
  // by clients with a persistent cache to drive section-pack compaction.
  registerSectionManifest?(section: number, marks: string[]): void;
  // Cached per-ordinal audio durations (seconds) for a section under the
  // current voice; empty when the client has no persistent cache.
  getSectionDurations?(section: number): Promise<Map<number, number>>;
  getVoiceId(): string;
  getSpeakingLang(): string;
  // Playback position within the currently audible sentence, in trimmed media
  // seconds at rate 1.0, clamped to [0, sentenceDuration]. Only meaningful
  // when capabilities.mediaClock is true; the section timeline treats absence
  // as sentence-granularity positions.
  getChunkPosition?(): number | null;
  // How far through the chunk now sounding, 0..1. Reported as a single value
  // rather than position/duration so it cannot skew between two calls, and so a
  // playback rate change cannot be applied to one but not the other.
  getChunkProgress?(): number | null;
}
