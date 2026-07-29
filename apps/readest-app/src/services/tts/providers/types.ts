// The synthesis-side seam of the TTS architecture: a SpeechProvider turns
// text into compressed audio plus word-boundary timings, and nothing else.
// Scheduling, decoding, time-stretch, playout, word tracking, and media
// sessions all live above this seam (BufferedTTSClient and the players), so
// a new engine — another HTTP service, a local model, a system voice
// synthesizing to buffers — is one adapter implementing this contract.
//
// Invariants every provider must uphold:
// - The playback RATE is never sent to the provider. Rate is a playout
//   concern (WSOLA on the web path, AVPlayer timeDomain on iOS), which keeps
//   synthesized audio rate-independent and therefore cacheable.
// - `boundaries` use the Edge wire shape (100ns ticks from stream start,
//   verbatim text spans); providers convert at their edge. Absent boundaries
//   simply degrade word highlighting to sentence highlighting.

import type { TTSWordBoundary } from '@/libs/edgeTTS';
import type { TTSVoice } from '../types';

export interface SpeechSynthesisRequest {
  lang: string;
  text: string;
  voice: string;
  pitch: number;
}

export const normalizeSynthesisLocale = (locale: string): string => {
  const hyphenated = locale.trim().replaceAll('_', '-');
  try {
    return Intl.getCanonicalLocales(hyphenated)[0] ?? hyphenated.toLowerCase();
  } catch {
    return hyphenated.toLowerCase();
  }
};

export interface SpeechSynthesisResult {
  // Compressed audio exactly as delivered by the engine. Callers own the
  // buffer (providers must hand out a fresh copy per call: WebKit's
  // decodeAudioData detaches its input).
  audio: ArrayBuffer;
  boundaries: TTSWordBoundary[];
  // Exact rate-1.0 media duration when word timings are unavailable or do not
  // cover the full audio (for example PCM WAV from Android system TTS).
  // Providers should omit invalid/unknown values rather than using zero.
  durationSec?: number;
}

// Scheduling identity is intentionally separate from the acoustic request:
// it reaches native adapters for stale-result rejection, while the coordinator
// namespaces ownership by generation outside the reusable acoustic fingerprint.
export interface SpeechSynthesisContext {
  sessionId: string;
  requestId: string;
  generation: number;
}

// A failure that is permanent for the given sentence (retrying the same
// request cannot succeed). The buffered client skips the sentence instead of
// retrying; anything else thrown from synthesize() is treated as transient.
export class SpeechSynthesisPermanentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SpeechSynthesisPermanentError';
  }
}

// Retry belongs to the engine adapter: a network transport may tolerate a
// few attempts, while a local Android engine generally must not duplicate
// expensive inference. The coordinator executes attempts serially.
export interface SpeechRetryPolicy {
  maxAttempts: number;
  delayMs?: (failedAttempt: number, error: unknown) => number;
  shouldRetry?: (error: unknown) => boolean;
}

export interface SpeechProvider {
  // Stable identifier: persisted voice/client preferences and cache
  // namespaces key off it, so renaming one is a migration.
  readonly id: string;
  // Human-readable engine name for voice-group headers.
  readonly label: string;
  // Probe/initialize the transport; false means the engine is unavailable
  // (its voices render disabled in the picker).
  init(): Promise<boolean>;
  getAllVoices(): Promise<TTSVoice[]>;
  synthesize(
    req: SpeechSynthesisRequest,
    signal: AbortSignal,
    context?: SpeechSynthesisContext,
  ): Promise<SpeechSynthesisResult>;
  // Engine-specific default-voice policy for a language's candidate list
  // (already filtered and sorted); return undefined to accept the first.
  pickDefaultVoice?(voices: TTSVoice[]): string | undefined;
  // Last-resort voice when nothing matched and no voice was ever selected.
  readonly fallbackVoiceId?: string;
  // Whether synthesized audio may be persisted. Some services forbid
  // storing their output; CachingProvider bypasses the store when false.
  readonly cacheable?: boolean;
  // Runtime identity beyond the stable provider id (for example an Android
  // engine package + version). A changed identity must not reuse prepared
  // audio from the previous engine.
  readonly synthesisIdentity?: string;
  // Explicit provider-owned retry semantics. Omitted means one attempt.
  readonly retryPolicy?: SpeechRetryPolicy;
  // Maximum independent synthesis jobs for this engine. Local/mobile engines
  // default to one; network providers may opt into bounded parallelism.
  readonly synthesisConcurrency?: number;
  // Release provider resources (network handles, cache databases) when the
  // owning client shuts down.
  shutdown?(): Promise<void>;
}
