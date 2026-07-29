import { invoke } from '@tauri-apps/api/core';
import type { TTSVoice } from '../types';
import {
  normalizeSynthesisLocale,
  SpeechProvider,
  SpeechRetryPolicy,
  SpeechSynthesisContext,
  SpeechSynthesisPermanentError,
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
} from './types';

export const ANDROID_BUFFERED_VOICE_PREFIX = 'android-buffered:';
const ADAPTER_REVISION = 'android-file-v1';

interface AndroidTTSInitResponse {
  success: boolean;
  enginePackage?: string;
  engineVersion?: string;
  maxInputLength?: number;
}

interface AndroidTTSVoicesResponse {
  voices: TTSVoice[];
}

interface AndroidTTSBoundary {
  offset: number;
  duration: number;
  text: string;
}

interface AndroidTTSSynthesisResponse {
  assetId: string;
  sampleRate: number;
  frameCount: number;
  durationSec: number;
  enginePackage: string;
  engineVersion: string;
  maxInputLength: number;
  boundaries: AndroidTTSBoundary[];
}

class AndroidSpeechConnectionError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = true, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AndroidSpeechConnectionError';
    this.retryable = retryable;
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'AbortError' || error.message === 'Aborted');

const isConnectionFailure = (message: string): boolean =>
  /engine[_ -]?(?:disconnected|unavailable)|service[_ -]?disconnected|not initialized/i.test(
    message,
  );

const isPermanentFailure = (message: string): boolean =>
  /invalid (?:synthesis )?(?:request|input|audio|wav|range|metadata)|input[_ -]?too[_ -]?long|text exceeds|voice[_ -]?(?:not found|unavailable)|engine[_ -]?mismatch|engine does not match|locale (?:is invalid|is not supported)|unsupported/i.test(
    message,
  );

const abortError = (): DOMException => new DOMException('Aborted', 'AbortError');
const monotonicNowMs = (): number => globalThis.performance?.now() ?? Date.now();

const logSynthesisEvent = (
  event: string,
  operation: SpeechSynthesisContext,
  details: Record<string, string | number | boolean> = {},
): void => {
  console.info('[TTS][AndroidBuffered]', {
    event,
    sessionId: operation.sessionId,
    requestId: operation.requestId,
    generation: operation.generation,
    ...details,
  });
};

// Android TextToSpeech as a rate-1.0 file-synthesis provider. Scheduling,
// lookahead, ephemeral retention, decoding, WSOLA, and playout remain owned by
// BufferedTTSClient; this adapter only translates the atomic native operation.
export class AndroidSystemSpeechProvider implements SpeechProvider {
  readonly id = 'android-system-buffered';
  readonly label = 'System TTS — Buffered (Experimental)';
  readonly cacheable = false;
  readonly synthesisConcurrency = 1;
  readonly retryPolicy = {
    maxAttempts: 2,
    shouldRetry: (error) => error instanceof AndroidSpeechConnectionError && error.retryable,
  } satisfies SpeechRetryPolicy;

  #enginePackage = '';
  #engineVersion = '';
  #maxInputLength = 0;
  #fallbackRequestSequence = 0;
  #blockedByCancellationFailure: AndroidSpeechConnectionError | null = null;

  get synthesisIdentity(): string {
    const runtimeIdentity = this.#enginePackage
      ? `${this.#enginePackage}@${this.#engineVersion || 'unknown'}`
      : 'uninitialized';
    return `${runtimeIdentity}:${ADAPTER_REVISION}`;
  }

  async init(): Promise<boolean> {
    this.#enginePackage = '';
    this.#engineVersion = '';
    this.#maxInputLength = 0;
    const response = await invoke<AndroidTTSInitResponse>('plugin:native-tts|init');
    if (!response.success) return false;
    const enginePackage = response.enginePackage?.trim() ?? '';
    const maxInputLength = Math.max(0, Math.floor(response.maxInputLength ?? 0));
    // Older bundled plugins only returned { success }. Direct speech remains
    // compatible, but the experimental provider must stay hidden until it can
    // build a safe runtime identity and enforce Android's input limit.
    if (!enginePackage || maxInputLength === 0) return false;
    this.#enginePackage = enginePackage;
    this.#engineVersion = response.engineVersion ?? '';
    this.#maxInputLength = maxInputLength;
    this.#blockedByCancellationFailure = null;
    return true;
  }

  async getAllVoices(): Promise<TTSVoice[]> {
    const response = await invoke<AndroidTTSVoicesResponse>('plugin:native-tts|get_all_voices');
    return response.voices.map((voice) => ({
      ...voice,
      id: `${ANDROID_BUFFERED_VOICE_PREFIX}${voice.id}`,
    }));
  }

  async synthesize(
    req: SpeechSynthesisRequest,
    signal: AbortSignal,
    context?: SpeechSynthesisContext,
  ): Promise<SpeechSynthesisResult> {
    if (signal.aborted) throw abortError();
    if (this.#blockedByCancellationFailure) throw this.#blockedByCancellationFailure;
    if (!req.text || (this.#maxInputLength > 0 && req.text.length > this.#maxInputLength)) {
      throw new SpeechSynthesisPermanentError('Android TTS input exceeds engine limits');
    }
    if (!this.#enginePackage) {
      throw new AndroidSpeechConnectionError('Android TTS engine is not initialized');
    }
    if (!req.voice.startsWith(ANDROID_BUFFERED_VOICE_PREFIX)) {
      throw new SpeechSynthesisPermanentError('Invalid Android buffered voice ID');
    }

    const operation =
      context ??
      ({
        sessionId: 'android-provider-direct',
        requestId: `android-provider-direct:${++this.#fallbackRequestSequence}`,
        generation: 0,
      } satisfies SpeechSynthesisContext);
    const operationStartedAt = monotonicNowMs();
    const cancel = async (reason: string): Promise<void> => {
      const cancelStartedAt = monotonicNowMs();
      logSynthesisEvent('cancel-requested', operation, { reason });
      try {
        await invoke('plugin:native-tts|cancel_synthesis', { payload: operation });
        logSynthesisEvent('cancel-completed', operation, {
          reason,
          cancelMs: monotonicNowMs() - cancelStartedAt,
        });
      } catch (error) {
        const unavailable = new AndroidSpeechConnectionError(
          'Android TTS cancellation did not reach a reusable engine state',
          false,
          { cause: error },
        );
        this.#blockedByCancellationFailure = unavailable;
        console.error('[TTS] Android synthesis cancellation failed; provider disabled');
        throw unavailable;
      }
    };

    let abortHandler: (() => void) | undefined;
    const cancellation = new Promise<never>((_, reject) => {
      abortHandler = () => {
        void cancel('abort').then(
          () => reject(abortError()),
          (error: unknown) => reject(error),
        );
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    });
    let metadataReady = false;
    let assetConsumed = false;

    try {
      logSynthesisEvent('native-start', operation, {
        locale: normalizeSynthesisLocale(req.lang),
        textLength: req.text.length,
      });
      const synthesis = invoke<AndroidTTSSynthesisResponse>(
        'plugin:native-tts|synthesize_to_file',
        {
          payload: {
            text: req.text,
            enginePackage: this.#enginePackage,
            voice: req.voice.slice(ANDROID_BUFFERED_VOICE_PREFIX.length),
            locale: normalizeSynthesisLocale(req.lang),
            pitch: req.pitch,
            rate: 1,
            ...operation,
          },
        },
      );
      const metadata = await Promise.race([synthesis, cancellation]);
      metadataReady = true;
      const metadataReadyAt = monotonicNowMs();
      logSynthesisEvent('file-ready', operation, {
        synthesisMs: metadataReadyAt - operationStartedAt,
        sampleRate: metadata.sampleRate,
        frameCount: metadata.frameCount,
        durationSec: metadata.durationSec,
        boundaryCount: metadata.boundaries.length,
      });
      if (signal.aborted) {
        await cancel('abort-after-ready');
        throw abortError();
      }
      if (metadata.enginePackage !== this.#enginePackage) {
        await cancel('engine-mismatch');
        assetConsumed = true;
        throw new SpeechSynthesisPermanentError('Android TTS engine mismatch');
      }

      const audio = await Promise.race([
        invoke<ArrayBuffer>('plugin:native-tts|read_synthesis_audio', {
          payload: { assetId: metadata.assetId },
        }),
        cancellation,
      ]);
      assetConsumed = true;
      logSynthesisEvent('bridge-completed', operation, {
        bridgeMs: monotonicNowMs() - metadataReadyAt,
        totalMs: monotonicNowMs() - operationStartedAt,
        bytes: audio.byteLength,
        durationSec: metadata.durationSec,
      });
      if (signal.aborted) throw abortError();
      if (!(audio instanceof ArrayBuffer) || audio.byteLength === 0) {
        throw new SpeechSynthesisPermanentError('Invalid WAV returned by Android TTS');
      }

      this.#engineVersion = metadata.engineVersion || this.#engineVersion;
      this.#maxInputLength = Math.max(0, Math.floor(metadata.maxInputLength || 0));
      return {
        audio,
        boundaries: metadata.boundaries,
        durationSec: metadata.durationSec,
      };
    } catch (error) {
      if (metadataReady && !assetConsumed && !signal.aborted) await cancel('cleanup-after-error');
      if (error instanceof AndroidSpeechConnectionError && !error.retryable) throw error;
      if (signal.aborted || isAbortError(error)) throw abortError();
      if (error instanceof SpeechSynthesisPermanentError) throw error;
      const message = errorMessage(error);
      if (isConnectionFailure(message)) {
        // The coordinator owns the one allowed retry. Refresh the runtime
        // identity here, then surface a typed retryable failure.
        try {
          await this.init();
        } catch {
          // Preserve the original connection failure for retry accounting.
        }
        throw new AndroidSpeechConnectionError(message, true, { cause: error });
      }
      if (isPermanentFailure(message)) {
        throw new SpeechSynthesisPermanentError(message, { cause: error });
      }
      // Unknown native/read failures do not retry: duplicating a completed
      // local inference merely because the bridge read failed is expensive.
      throw error;
    } finally {
      if (abortHandler) signal.removeEventListener('abort', abortHandler);
    }
  }
}
