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

export const LAPTOP_USB_VOICE_PREFIX = 'laptop-usb:';

const ENDPOINT = 'http://127.0.0.1:18765';
// The first plugin-http request after a cold Android WebView start can exceed
// 500 ms even when the adb reverse and an already-loaded host are healthy.
// Keep discovery bounded, but leave enough room for that one-time bridge
// startup so an explicitly preferred laptop voice does not silently start on
// an established fallback engine.
const HEALTH_TIMEOUT_MS = 1_500;
const FRAME_PROTOCOL_VERSION = 1;
const LEGACY_PROTOCOL_VERSION = 1;
const MULTI_MODEL_PROTOCOL_VERSION = 2;
const LEGACY_SAMPLE_RATE = 44_100;
const MAX_TEXT_UTF16 = 200;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const RESPONSE_CONTENT_TYPE = 'application/vnd.reading-tts.synthesis';
const LEGACY_MODEL_IDENTITY = 'sherpa-onnx-supertonic-3-tts-int8-2026-05-11';
const LEGACY_PIPELINE_REVISION = 'android-full-buffer-parity-v1';
const MULTI_MODEL_PIPELINE_REVISION = 'native-rate-full-buffer-v2';
const LEGACY_RUNTIME_VERSION = '1.13.4';
const ADAPTER_REVISION = 'rtts-v2';

interface LaptopHealthVoice {
  id: string;
  name: string;
  lang: string;
}

interface MultiModelHealthVoice extends LaptopHealthVoice {
  backend: string;
  modelIdentity: string;
  runtimeVersion: string;
  sampleRate: number;
  memoryHintMb: number;
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

interface MultiModelHealthResponse {
  schemaVersion: 2;
  status: string;
  protocolVersion: 2;
  serviceVersion: string;
  pipelineRevision: string;
  maxTextUtf16: number;
  synthesisConcurrency: number;
  settingsIdentity: string;
  catalogIdentity: string;
  voices: MultiModelHealthVoice[];
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
  runtimeVersion?: string;
  pipelineRevision: string;
  sampleRate: number;
  channels: number;
  format: string;
  frameCount: number;
  durationSec: number;
  appliedPitch: number;
  boundaries: LaptopBoundary[];
}

interface ExpectedFrameContract {
  schemaVersion: 1 | 2;
  modelIdentity: string;
  runtimeVersion?: string;
  pipelineRevision: string;
  sampleRate: number;
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

const validLegacyVoice = (value: unknown): value is LaptopHealthVoice => {
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

const validLegacyHealth = (value: unknown): value is LaptopHealthResponse => {
  if (!isRecord(value)) return false;
  const voices = value['voices'];
  const settingsIdentity = value['settingsIdentity'];
  const voiceSuffixes = Array.isArray(voices)
    ? new Set(
        voices
          .filter(validLegacyVoice)
          .map((voice) => voice.id.split(':').at(-1))
          .filter((suffix): suffix is string => !!suffix),
      )
    : new Set<string>();
  return (
    value['schemaVersion'] === 1 &&
    value['status'] === 'ready' &&
    value['protocolVersion'] === LEGACY_PROTOCOL_VERSION &&
    typeof value['serviceVersion'] === 'string' &&
    value['serviceVersion'].length > 0 &&
    value['pipelineRevision'] === LEGACY_PIPELINE_REVISION &&
    value['modelIdentity'] === LEGACY_MODEL_IDENTITY &&
    value['runtimeVersion'] === LEGACY_RUNTIME_VERSION &&
    value['sampleRate'] === LEGACY_SAMPLE_RATE &&
    isSafeInteger(value['maxTextUtf16']) &&
    value['maxTextUtf16'] >= MAX_TEXT_UTF16 &&
    value['synthesisConcurrency'] === 1 &&
    typeof settingsIdentity === 'string' &&
    /^reading-tts-settings-v2:sid(?:0|[1-9]\d*):speed\d+(?:\.\d+)?:steps[5-7]:pauses\d+,\d+,\d+,\d+,\d+$/.test(
      settingsIdentity,
    ) &&
    Array.isArray(voices) &&
    voices.length > 0 &&
    voices.every(validLegacyVoice) &&
    voiceSuffixes.size === 1 &&
    settingsIdentity.includes(`:${[...voiceSuffixes][0]}:`)
  );
};

const MODEL_CONTRACTS = {
  supertonic3: {
    modelIdentity: LEGACY_MODEL_IDENTITY,
    runtimeVersion: 'sherpa-onnx-1.13.4',
    sampleRate: 44_100,
    voice: /^laptop-usb:supertonic3:(?:es|en):sid(?:0|[1-9]\d*)$/,
  },
  'pocket-tts-2.1': {
    modelIdentity: 'kyutai-pocket-tts-2.1.0',
    runtimeVersion: 'pocket-tts-2.1.0',
    sampleRate: 24_000,
    voice: /^laptop-usb:pocket-tts-2\.1:(?:es:lola|en:alba)$/,
  },
  'moss-tts-nano': {
    modelIdentity: 'openmoss-moss-tts-nano-v0.5-f52645cb',
    runtimeVersion: 'onnxruntime-1.23.2',
    sampleRate: 48_000,
    voice: /^laptop-usb:moss-tts-nano:(?:es:Xiaoyu|en:Ava)$/,
  },
} as const;

const validMultiModelVoice = (value: unknown): value is MultiModelHealthVoice => {
  if (!isRecord(value)) return false;
  const id = value['id'];
  const name = value['name'];
  const lang = value['lang'];
  const backend = value['backend'];
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    !name.trim() ||
    typeof lang !== 'string' ||
    typeof backend !== 'string' ||
    !(backend in MODEL_CONTRACTS)
  ) {
    return false;
  }
  const contract = MODEL_CONTRACTS[backend as keyof typeof MODEL_CONTRACTS];
  const normalized = normalizeSynthesisLocale(lang);
  return (
    contract.voice.test(id) &&
    id.split(':')[1] === backend &&
    primaryLanguage(normalized) === id.split(':')[2] &&
    value['modelIdentity'] === contract.modelIdentity &&
    value['runtimeVersion'] === contract.runtimeVersion &&
    value['sampleRate'] === contract.sampleRate &&
    isSafeInteger(value['memoryHintMb']) &&
    value['memoryHintMb'] > 0
  );
};

const validMultiModelHealth = (value: unknown): value is MultiModelHealthResponse => {
  if (!isRecord(value)) return false;
  const voices = value['voices'];
  const settingsIdentity = value['settingsIdentity'];
  const catalogIdentity = value['catalogIdentity'];
  if (
    value['schemaVersion'] !== 2 ||
    value['status'] !== 'ready' ||
    value['protocolVersion'] !== MULTI_MODEL_PROTOCOL_VERSION ||
    typeof value['serviceVersion'] !== 'string' ||
    !value['serviceVersion'] ||
    value['pipelineRevision'] !== MULTI_MODEL_PIPELINE_REVISION ||
    !isSafeInteger(value['maxTextUtf16']) ||
    value['maxTextUtf16'] < MAX_TEXT_UTF16 ||
    value['synthesisConcurrency'] !== 1 ||
    typeof settingsIdentity !== 'string' ||
    !/^reading-tts-settings-v2:sid(?:0|[1-9]\d*):speed\d+(?:\.\d+)?:steps[5-7]:pauses\d+,\d+,\d+,\d+,\d+$/.test(
      settingsIdentity,
    ) ||
    typeof catalogIdentity !== 'string' ||
    !catalogIdentity.startsWith('local-rtts-catalog-v1:') ||
    !Array.isArray(voices) ||
    voices.length < 2 ||
    !voices.every(validMultiModelVoice)
  ) {
    return false;
  }
  const ids = new Set(voices.map((voice) => voice.id));
  if (ids.size !== voices.length) return false;
  const sid = settingsIdentity.match(/:sid(\d+):/)?.[1];
  return voices
    .filter((voice) => voice.backend === 'supertonic3')
    .every((voice) => voice.id.endsWith(`:sid${sid}`));
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

const parseWav = (wav: Uint8Array, expectedSampleRate: number): number => {
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
        sampleRate !== expectedSampleRate ||
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
  expected: ExpectedFrameContract,
): SpeechSynthesisResult => {
  if (frame.byteLength < 12 || frame.byteLength > MAX_RESPONSE_BYTES) {
    throw new LaptopUsbProtocolError('Invalid RTTS frame length');
  }
  const bytes = new Uint8Array(frame);
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== 'RTTS') {
    throw new LaptopUsbProtocolError('Invalid RTTS magic');
  }
  const view = new DataView(frame);
  if (view.getUint16(4, false) !== FRAME_PROTOCOL_VERSION || view.getUint16(6, false) !== 0) {
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
    metadata.schemaVersion !== expected.schemaVersion ||
    metadata.requestId !== expectedRequestId ||
    metadata.modelIdentity !== expected.modelIdentity ||
    (expected.runtimeVersion !== undefined &&
      metadata.runtimeVersion !== expected.runtimeVersion) ||
    metadata.pipelineRevision !== expected.pipelineRevision ||
    metadata.sampleRate !== expected.sampleRate ||
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
  const wavFrames = parseWav(wav, expected.sampleRate);
  if (wavFrames !== metadata.frameCount)
    throw new LaptopUsbProtocolError('WAV frame count mismatch');
  const expectedDuration = metadata.frameCount / expected.sampleRate;
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
  readonly label = 'Laptop — Modelos locales';
  readonly cacheable = false;
  readonly synthesisConcurrency = 1;
  readonly compositeBoundaries = {
    textOffsets: 'utf16',
    audioTiming: 'estimated',
  } as const;
  readonly retryPolicy = { maxAttempts: 1 } satisfies SpeechRetryPolicy;

  #voices: LaptopHealthVoice[] = [];
  #voiceContracts = new Map<string, ExpectedFrameContract>();
  #serviceVersion = '';
  #settingsIdentity = '';
  #catalogIdentity = '';
  #protocolVersion: 1 | 2 = 1;
  #initialized = false;
  #fallbackRequestSequence = 0;

  get synthesisIdentity(): string {
    if (!this.#initialized) return `${ADAPTER_REVISION}:uninitialized`;
    const pipelineRevision =
      this.#protocolVersion === 2 ? MULTI_MODEL_PIPELINE_REVISION : LEGACY_PIPELINE_REVISION;
    return `${ADAPTER_REVISION}:rtts-${this.#protocolVersion}:${this.#serviceVersion}:${this.#settingsIdentity}:${pipelineRevision}:${this.#catalogIdentity}`;
  }

  async init(): Promise<boolean> {
    this.#voices = [];
    this.#voiceContracts.clear();
    this.#serviceVersion = '';
    this.#settingsIdentity = '';
    this.#catalogIdentity = '';
    this.#protocolVersion = 1;
    this.#initialized = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const multiResponse = await tauriFetch(`${ENDPOINT}/v2/health`, {
        method: 'GET',
        signal: controller.signal,
      });
      if (multiResponse.ok && multiResponse.status === 200) {
        const health: unknown = await multiResponse.json();
        if (validMultiModelHealth(health)) {
          this.#applyMultiModelHealth(health);
          return true;
        }
        // A v1 payload at the new path is accepted for compatibility with
        // simple local proxies and older test fixtures.
        if (validLegacyHealth(health)) {
          this.#applyLegacyHealth(health);
          return true;
        }
        return false;
      }
      if (multiResponse.status !== 404) return false;
      const legacyResponse = await tauriFetch(`${ENDPOINT}/health`, {
        method: 'GET',
        signal: controller.signal,
      });
      if (!legacyResponse.ok || legacyResponse.status !== 200) return false;
      const legacyHealth: unknown = await legacyResponse.json();
      if (!validLegacyHealth(legacyHealth)) return false;
      this.#applyLegacyHealth(legacyHealth);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  #applyLegacyHealth(health: LaptopHealthResponse): void {
    this.#voices = health.voices.map((voice) => ({ ...voice }));
    this.#voiceContracts = new Map(
      health.voices.map((voice) => [
        voice.id,
        {
          schemaVersion: 1,
          modelIdentity: LEGACY_MODEL_IDENTITY,
          pipelineRevision: LEGACY_PIPELINE_REVISION,
          sampleRate: LEGACY_SAMPLE_RATE,
        },
      ]),
    );
    this.#serviceVersion = health.serviceVersion;
    this.#settingsIdentity = health.settingsIdentity;
    this.#catalogIdentity = `${LEGACY_MODEL_IDENTITY}:${LEGACY_RUNTIME_VERSION}`;
    this.#protocolVersion = 1;
    this.#initialized = true;
  }

  #applyMultiModelHealth(health: MultiModelHealthResponse): void {
    this.#voices = health.voices.map(({ id, name, lang }) => ({ id, name, lang }));
    this.#voiceContracts = new Map(
      health.voices.map((voice) => [
        voice.id,
        {
          schemaVersion: 2,
          modelIdentity: voice.modelIdentity,
          runtimeVersion: voice.runtimeVersion,
          pipelineRevision: MULTI_MODEL_PIPELINE_REVISION,
          sampleRate: voice.sampleRate,
        },
      ]),
    );
    this.#serviceVersion = health.serviceVersion;
    this.#settingsIdentity = health.settingsIdentity;
    this.#catalogIdentity = health.catalogIdentity;
    this.#protocolVersion = 2;
    this.#initialized = true;
  }

  async getAllVoices(): Promise<TTSVoice[]> {
    return this.#voices.map(({ id, name, lang }) => ({ id, name, lang }));
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
    const frameContract = this.#voiceContracts.get(req.voice);
    if (
      !['es', 'en'].includes(primary) ||
      !voice ||
      !frameContract ||
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
      schemaVersion: this.#protocolVersion,
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
      const response = await tauriFetch(`${ENDPOINT}/v${this.#protocolVersion}/synthesize`, {
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
      return parseFrame(frame, requestId, req.text, frameContract);
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw abortError();
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    this.#voices = [];
    this.#voiceContracts.clear();
    this.#serviceVersion = '';
    this.#settingsIdentity = '';
    this.#catalogIdentity = '';
    this.#protocolVersion = 1;
    this.#initialized = false;
  }
}
