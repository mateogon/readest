// Edge (Microsoft) speech as a SpeechProvider. Pure re-homing: the WS/HTTP
// transport, LRU + inflight caches, and voice list all stay in
// EdgeSpeechTTS (@/libs/edgeTTS); this adapter owns the contract-level
// concerns — the rate-1.0 invariant and permanent-error classification.

import { EDGE_TTS_PROTOCOL, EdgeSpeechTTS } from '@/libs/edgeTTS';
import type { TTSVoice } from '../types';
import {
  SpeechProvider,
  SpeechRetryPolicy,
  SpeechSynthesisPermanentError,
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
} from './types';

const awaitEdgeTransport = <T>(transport: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    transport.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
};

export class EdgeSpeechProvider implements SpeechProvider {
  readonly id = 'edge-tts';
  readonly label = 'Edge TTS';
  readonly fallbackVoiceId = 'en-US-AriaNeural';
  readonly cacheable = true;
  readonly synthesisIdentity = 'edge-adapter-v1';
  readonly synthesisConcurrency = 4;
  readonly retryPolicy = {
    maxAttempts: 3,
    delayMs: (failedAttempt) => 200 * failedAttempt,
  } satisfies SpeechRetryPolicy;

  #tts: EdgeSpeechTTS | null = null;

  // The wss transport is free but intermittently blocked; the https fallback
  // goes through the authenticated proxy route. The Edge client owns the
  // fallback policy (auth state lives there); the provider just takes the
  // protocol to probe with.
  async init(protocol: EDGE_TTS_PROTOCOL = 'wss'): Promise<boolean> {
    this.#tts = new EdgeSpeechTTS(protocol);
    try {
      await this.#tts.create({
        lang: 'en',
        text: 'test',
        voice: 'en-US-AriaNeural',
        rate: 1.0,
        pitch: 1.0,
      });
      return true;
    } catch {
      return false;
    }
  }

  async getAllVoices(): Promise<TTSVoice[]> {
    return EdgeSpeechTTS.voices;
  }

  async synthesize(
    req: SpeechSynthesisRequest,
    signal: AbortSignal,
  ): Promise<SpeechSynthesisResult> {
    const tts = this.#tts;
    if (!tts) throw new Error('EdgeSpeechProvider not initialized');
    try {
      // Rate pinned to 1.0: keeps the audio cache rate-independent; the
      // playback rate is applied at playout.
      // The shared Edge transport cannot always close its underlying request,
      // but this provider lease must still settle promptly on navigation so a
      // stale request cannot occupy the coordinator's only synthesis slot.
      const { data, boundaries } = await awaitEdgeTransport(
        tts.createAudioData({
          lang: req.lang,
          text: req.text,
          voice: req.voice,
          rate: 1.0,
          pitch: req.pitch,
        }),
        signal,
      );
      return { audio: data, boundaries };
    } catch (err) {
      // Permanent for this sentence: Edge answered without audio frames.
      if (err instanceof Error && err.message === 'No audio data received.') {
        throw new SpeechSynthesisPermanentError(err.message, { cause: err });
      }
      throw err;
    }
  }

  pickDefaultVoice(voices: TTSVoice[]): string | undefined {
    // Avoid AnaNeural (a child voice) as an accidental English default.
    const first = voices[0];
    if (first?.id === 'en-US-AnaNeural') return 'en-US-AriaNeural';
    return first?.id;
  }
}
