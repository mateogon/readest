import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import type { TTSWordBoundary } from '@/libs/edgeTTS';
import type { TTSVoice } from '../types';
import {
  normalizeSynthesisLocale,
  type SpeechProvider,
  type SpeechRetryPolicy,
  type SpeechSynthesisContext,
  SpeechSynthesisPermanentError,
  type SpeechSynthesisRequest,
  type SpeechSynthesisResult,
} from './types';

export const LAPTOP_USB_VOICE_PREFIX = 'laptop-usb:supertonic3:';

const ENDPOINT = 'http://127.0.0.1:18765';
// The first plugin-http request after a cold Android WebView start can exceed
// 500 ms even when the adb reverse and an already-loaded host are healthy.
// Keep discovery bounded, but leave enough room for that one-time bridge
// startup so an explicitly preferred laptop voice does not silently start on
// an established fallback engine.
const HEALTH_TIMEOUT_MS = 1_500;
const PROTOCOL_VERSION = 1;
const SAMPLE_RATE = 44_100;
const MAX_TEXT_UTF16 = 200;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const RESPONSE_CONTENT_TYPE = 'application/vnd.reading-tts.synthesis';
const EXPECTED_MODEL_IDENTITY = 'sherpa-onnx-supertonic-3-tts-int8-2026-05-11';
const EXPECTED_PIPELINE_REVISION = 'android-full-buffer-parity-v1';
const EXPECTED_RUNTIME_VERSION = '1.13.4';
const ADAPTER_REVISION = 'rtts-v1';

interface LaptopHealthVoice {
  id: string;
  name: string;
  lang: string;
}

interface LaptopHealthResponse {
  schemaVersion: number;
  status: string;
  protocolVersion: number;
  serviceVersion: string;
  pipelineRevision: string;
  modelIdentity: string;
  runtimeVersion: string;
  sampleRate: number;
  maxTextUtf16: number;
  synthesisConcurrency: number;
  settingsIdentity: string;
  voices: LaptopHealthVoice[];
}

interface LaptopBoundary {
  offset: number;
  duration: number;
  text: string;
  textStart: number;
  textEnd: number;
}

interface LaptopFrameMetadata {
  schemaVersion: number;
  requestId: string;
  modelIdentity: string;
  pipelineRevision: string;
  sampleRate: number;
  channels: number;
  format: string;
  frameCount: number;
  durationSec: number;
  appliedPitch: number;
  boundaries: LaptopBoundary[];
}

class LaptopUsbProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaptopUsbProtocolError';
  }
}

const abortError = (): DOMException => new DOMException('Aborted', 'AbortError');

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const primaryLanguage = (locale: string): string => locale.split('-')[0]?.toLowerCase() ?? '';

const validVoice = (value: unknown): value is LaptopHealthVoice => {
  if (!isRecord(value)) return false;
  const id = value['id'];
  const name = value['name'];
  const lang = value['lang'];
  if (
    typeof id !== 'string' ||
    !/^laptop-usb:supertonic3:(?:es|en):sid(?:0|[1-9]\d*)$/.test(id) ||
    typeof name !== 'string' ||
    !name.trim() ||
    typeof lang !== 'string'
  ) {
    return false;
  }
  const normalized = normalizeSynthesisLocale(lang);
  return primaryLanguage(normalized) === id.split(':')[2];
};

const validHealth = (value: unknown): value is LaptopHealthResponse => {
  if (!isRecord(value)) return false;
  const voices = value['voices'];
  const settingsIdentity = value['settingsIdentity'];
  const voiceSuffixes = Array.isArray(voices)
    ? new Set(
        voices
          .filter(validVoice)
          .map((voice) => voice.id.split(':').at(-1))
          .filter((suffix): suffix is string => !!suffix),
      )
    : new Set<string>();
  return (
    value['schemaVersion'] === 1 &&
    value['status'] === 'ready' &&
    value['protocolVersion'] === PROTOCOL_VERSION &&
    typeof value['serviceVersion'] === 'string' &&
    value['serviceVersion'].length > 0 &&
    value['pipelineRevision'] === EXPECTED_PIPELINE_REVISION &&
    value['modelIdentity'] === EXPECTED_MODEL_IDENTITY &&
    value['runtimeVersion'] === EXPECTED_RUNTIME_VERSION &&
    value['sampleRate'] === SAMPLE_RATE &&
    isSafeInteger(value['maxTextUtf16']) &&
    value['maxTextUtf16'] >= MAX_TEXT_UTF16 &&
    value['synthesisConcurrency'] === 1 &&
    typeof settingsIdentity === 'string' &&
    /^reading-tts-settings-v2:sid(?:0|[1-9]\d*):speed\d+(?:\.\d+)?:steps[5-7]:pauses\d+,\d+,\d+,\d+,\d+$/.test(
      settingsIdentity,
    ) &&
    Array.isArray(voices) &&
    voices.length > 0 &&
    voices.every(validVoice) &&
    voiceSuffixes.size === 1 &&
    settingsIdentity.includes(`:${[...voiceSuffixes][0]}:`)
  );
};

const headerValue = (response: Response, name: string): string | null => response.headers.get(name);

const responseContentLength = (response: Response): number => {
  const raw = headerValue(response, 'content-length');
  if (!raw || !/^\d+$/.test(raw))
    throw new LaptopUsbProtocolError('Missing or invalid response length');
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_RESPONSE_BYTES) {
    throw new LaptopUsbProtocolError('Response exceeds protocol limits');
  }
  return length;
};

const errorCode = async (response: Response): Promise<string> => {
  try {
    const value: unknown = await response.json();
    if (
      isRecord(value) &&
      typeof value['code'] === 'string' &&
      /^[a-z0-9_:-]{1,64}$/.test(value['code'])
    ) {
      return value['code'];
    }
  } catch {
    // The HTTP status remains the only safe error detail.
  }
  return 'http_error';
};

const requestIdOrFallback = (
  context: SpeechSynthesisContext | undefined,
  sequence: number,
): string => context?.requestId ?? `laptop-usb-direct:0:${sequence}`;

const validOperationId = (value: string): boolean =>
  value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);

const parseWav = (wav: Uint8Array): number => {
  if (wav.length < 44 || new TextDecoder().decode(wav.subarray(0, 4)) !== 'RIFF') {
    throw new LaptopUsbProtocolError('Invalid WAV container');
  }
  if (new TextDecoder().decode(wav.subarray(8, 12)) !== 'WAVE') {
    throw new LaptopUsbProtocolError('Invalid WAV container');
  }
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let offset = 12;
  let fmt = false;
  let dataFrames = 0;
  while (offset + 8 <= wav.length) {
    const chunk = new TextDecoder().decode(wav.subarray(offset, offset + 4));
    const chunkLength = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkEnd > wav.length) throw new LaptopUsbProtocolError('Truncated WAV chunk');
    if (chunk === 'fmt ') {
      if (chunkLength < 16) throw new LaptopUsbProtocolError('Invalid WAV format chunk');
      const format = view.getUint16(chunkStart, true);
      const channels = view.getUint16(chunkStart + 2, true);
      const sampleRate = view.getUint32(chunkStart + 4, true);
      const blockAlign = view.getUint16(chunkStart + 12, true);
      const bits = view.getUint16(chunkStart + 14, true);
      if (
        format !== 1 ||
        channels !== 1 ||
        sampleRate !== SAMPLE_RATE ||
        bits !== 16 ||
        blockAlign !== 2
      ) {
        throw new LaptopUsbProtocolError('Unsupported WAV format');
      }
      fmt = true;
    } else if (chunk === 'data') {
      if (chunkLength === 0 || chunkLength % 2 !== 0)
        throw new LaptopUsbProtocolError('Empty WAV data');
      dataFrames = chunkLength / 2;
    }
    offset = chunkEnd + (chunkLength % 2);
  }
  if (!fmt || dataFrames <= 0) throw new LaptopUsbProtocolError('WAV chunks are incomplete');
  return dataFrames;
};

const parseFrame = (
  frame: ArrayBuffer,
  expectedRequestId: string,
  text: string,
): SpeechSynthesisResult => {
  if (frame.byteLength < 12 || frame.byteLength > MAX_RESPONSE_BYTES) {
    throw new LaptopUsbProtocolError('Invalid RTTS frame length');
  }
  const bytes = new Uint8Array(frame);
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== 'RTTS') {
    throw new LaptopUsbProtocolError('Invalid RTTS magic');
  }
  const view = new DataView(frame);
  if (view.getUint16(4, false) !== PROTOCOL_VERSION || view.getUint16(6, false) !== 0) {
    throw new LaptopUsbProtocolError('Unsupported RTTS frame version');
  }
  const metadataLength = view.getUint32(8, false);
  if (
    metadataLength === 0 ||
    metadataLength > MAX_METADATA_BYTES ||
    12 + metadataLength > frame.byteLength
  ) {
    throw new LaptopUsbProtocolError('Invalid RTTS metadata length');
  }
  let metadataValue: unknown;
  try {
    metadataValue = JSON.parse(
      new TextDecoder().decode(bytes.subarray(12, 12 + metadataLength)),
    ) as unknown;
  } catch {
    throw new LaptopUsbProtocolError('Invalid RTTS metadata');
  }
  if (!isRecord(metadataValue)) throw new LaptopUsbProtocolError('Invalid RTTS metadata');
  const metadata = metadataValue as Partial<LaptopFrameMetadata>;
  if (
    metadata.schemaVersion !== 1 ||
    metadata.requestId !== expectedRequestId ||
    metadata.modelIdentity !== EXPECTED_MODEL_IDENTITY ||
    metadata.pipelineRevision !== EXPECTED_PIPELINE_REVISION ||
    metadata.sampleRate !== SAMPLE_RATE ||
    metadata.channels !== 1 ||
    metadata.format !== 'wav-pcm16le' ||
    !isSafeInteger(metadata.frameCount) ||
    metadata.frameCount <= 0 ||
    !isFiniteNumber(metadata.durationSec) ||
    metadata.durationSec <= 0 ||
    metadata.appliedPitch !== 1 ||
    !Array.isArray(metadata.boundaries)
  ) {
    throw new LaptopUsbProtocolError('Invalid RTTS metadata fields');
  }
  const wavOffset = 12 + metadataLength;
  const wav = bytes.subarray(wavOffset);
  const wavFrames = parseWav(wav);
  if (wavFrames !== metadata.frameCount)
    throw new LaptopUsbProtocolError('WAV frame count mismatch');
  const expectedDuration = metadata.frameCount / SAMPLE_RATE;
  if (Math.abs(metadata.durationSec - expectedDuration) > 0.005) {
    throw new LaptopUsbProtocolError('WAV duration mismatch');
  }
  const durationTicks = metadata.durationSec * 10_000_000;
  let previousOffset = -1;
  const boundaries: TTSWordBoundary[] = metadata.boundaries.map((value) => {
    if (
      !isRecord(value) ||
      !isSafeInteger(value.offset) ||
      !isSafeInteger(value.duration) ||
      value.offset < 0 ||
      value.duration <= 0 ||
      value.offset < previousOffset ||
      value.offset + value.duration > durationTicks + 1 ||
      typeof value.text !== 'string' ||
      value.text.length === 0 ||
      !isSafeInteger(value.textStart) ||
      !isSafeInteger(value.textEnd) ||
      value.textStart < 0 ||
      value.textEnd <= value.textStart ||
      value.textEnd > text.length ||
      text.slice(value.textStart, value.textEnd) !== value.text
    ) {
      throw new LaptopUsbProtocolError('Invalid RTTS boundary');
    }
    previousOffset = value.offset;
    return {
      offset: value.offset,
      duration: value.duration,
      text: value.text,
      textStart: value.textStart,
      textEnd: value.textEnd,
    };
  });
  return {
    audio: frame.slice(wavOffset),
    boundaries,
    durationSec: metadata.durationSec,
  };
};

export class LaptopUsbSpeechProvider implements SpeechProvider {
  readonly id = 'laptop-usb-supertonic';
  readonly label = 'Laptop — Supertonic 3 por USB';
  readonly cacheable = false;
  readonly synthesisConcurrency = 1;
  readonly compositeBoundaries = {
    textOffsets: 'utf16',
    audioTiming: 'estimated',
  } as const;
  readonly retryPolicy = { maxAttempts: 1 } satisfies SpeechRetryPolicy;

  #voices: LaptopHealthVoice[] = [];
  #serviceVersion = '';
  #settingsIdentity = '';
  #initialized = false;
  #fallbackRequestSequence = 0;

  get synthesisIdentity(): string {
    if (!this.#initialized) return `${ADAPTER_REVISION}:uninitialized`;
    return `${ADAPTER_REVISION}:rtts-${PROTOCOL_VERSION}:${this.#serviceVersion}:${this.#settingsIdentity}:${EXPECTED_RUNTIME_VERSION}:${EXPECTED_PIPELINE_REVISION}:${EXPECTED_MODEL_IDENTITY}`;
  }

  async init(): Promise<boolean> {
    this.#voices = [];
    this.#serviceVersion = '';
    this.#settingsIdentity = '';
    this.#initialized = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const response = await tauriFetch(`${ENDPOINT}/health`, {
        method: 'GET',
        signal: controller.signal,
      });
      if (!response.ok || response.status !== 200) return false;
      const health: unknown = await response.json();
      if (!validHealth(health)) return false;
      this.#voices = health.voices.map((voice) => ({ ...voice }));
      this.#serviceVersion = health.serviceVersion;
      this.#settingsIdentity = health.settingsIdentity;
      this.#initialized = true;
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getAllVoices(): Promise<TTSVoice[]> {
    return this.#voices.map((voice) => ({ ...voice }));
  }

  async synthesize(
    req: SpeechSynthesisRequest,
    signal: AbortSignal,
    context?: SpeechSynthesisContext,
  ): Promise<SpeechSynthesisResult> {
    if (signal.aborted) throw abortError();
    if (!this.#initialized) throw new LaptopUsbProtocolError('Laptop TTS is not initialized');
    if (!req.text || req.text.length > MAX_TEXT_UTF16) {
      throw new SpeechSynthesisPermanentError('Laptop TTS text exceeds protocol limits');
    }
    if (!Number.isFinite(req.pitch)) {
      throw new SpeechSynthesisPermanentError('Invalid laptop TTS pitch');
    }
    const lang = normalizeSynthesisLocale(req.lang);
    const primary = primaryLanguage(lang);
    const voice = this.#voices.find((candidate) => candidate.id === req.voice);
    if (
      !['es', 'en'].includes(primary) ||
      !voice ||
      primaryLanguage(normalizeSynthesisLocale(voice.lang)) !== primary
    ) {
      throw new SpeechSynthesisPermanentError('Invalid laptop TTS voice or language');
    }
    const requestId = requestIdOrFallback(context, ++this.#fallbackRequestSequence);
    const sessionId = context?.sessionId ?? 'laptop-usb-direct';
    const generation = context?.generation ?? 0;
    if (
      !validOperationId(sessionId) ||
      !validOperationId(requestId) ||
      !Number.isSafeInteger(generation) ||
      generation < 0
    ) {
      throw new SpeechSynthesisPermanentError('Invalid laptop TTS operation identity');
    }
    const body = JSON.stringify({
      schemaVersion: 1,
      sessionId,
      requestId,
      generation,
      text: req.text,
      lang,
      voice: req.voice,
      pitch: req.pitch,
    });
    if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
      throw new SpeechSynthesisPermanentError('Laptop TTS request exceeds protocol limits');
    }
    try {
      const response = await tauriFetch(`${ENDPOINT}/v1/synthesize`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: RESPONSE_CONTENT_TYPE,
        },
        body,
        signal,
      });
      if (!response.ok) {
        const code = await errorCode(response);
        if ([400, 413, 415, 422].includes(response.status)) {
          throw new SpeechSynthesisPermanentError(
            `Laptop TTS request rejected (${response.status}: ${code})`,
          );
        }
        throw new LaptopUsbProtocolError(`Laptop TTS session failed (${response.status}: ${code})`);
      }
      if (
        response.status !== 200 ||
        headerValue(response, 'content-type')?.split(';')[0] !== RESPONSE_CONTENT_TYPE
      ) {
        throw new LaptopUsbProtocolError('Invalid laptop TTS response type');
      }
      const expectedLength = responseContentLength(response);
      const frame = await response.arrayBuffer();
      if (frame.byteLength !== expectedLength)
        throw new LaptopUsbProtocolError('Truncated RTTS response');
      return parseFrame(frame, requestId, req.text);
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw abortError();
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    this.#voices = [];
    this.#serviceVersion = '';
    this.#settingsIdentity = '';
    this.#initialized = false;
  }
}
