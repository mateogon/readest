import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: h.fetch,
}));

import { LaptopUsbSpeechProvider } from '@/services/tts/providers/laptopUsb';
import { SpeechSynthesisPermanentError } from '@/services/tts/providers/types';

const HEALTH = {
  schemaVersion: 1,
  status: 'ready',
  protocolVersion: 1,
  serviceVersion: '0.1.0',
  pipelineRevision: 'android-full-buffer-parity-v1',
  modelIdentity: 'sherpa-onnx-supertonic-3-tts-int8-2026-05-11',
  runtimeVersion: '1.13.4',
  sampleRate: 44_100,
  maxTextUtf16: 200,
  synthesisConcurrency: 1,
  voices: [
    {
      id: 'laptop-usb:supertonic3:es:sid7',
      name: 'Laptop Supertonic 3 — Español',
      lang: 'es-ES',
    },
    {
      id: 'laptop-usb:supertonic3:en:sid7',
      name: 'Laptop Supertonic 3 — English',
      lang: 'en-US',
    },
  ],
};

const context = {
  sessionId: 'tts-coordinator-1',
  requestId: 'tts-coordinator-1:0:1',
  generation: 0,
};

const response = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: vi.fn().mockResolvedValue(body),
    arrayBuffer: vi.fn(),
  }) as unknown as Response;

const makeWav = (frameCount = 441): ArrayBuffer => {
  const dataBytes = frameCount * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1)
      bytes[offset + index] = value.charCodeAt(index);
  };
  write(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 44_100, true);
  view.setUint32(28, 88_200, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, dataBytes, true);
  return bytes.buffer;
};

const makeFrame = (metadata: Record<string, unknown>, wav = makeWav()): ArrayBuffer => {
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  const frame = new Uint8Array(12 + metadataBytes.length + wav.byteLength);
  frame.set([82, 84, 84, 83], 0);
  const view = new DataView(frame.buffer);
  view.setUint16(4, 1, false);
  view.setUint16(6, 0, false);
  view.setUint32(8, metadataBytes.length, false);
  frame.set(metadataBytes, 12);
  frame.set(new Uint8Array(wav), 12 + metadataBytes.length);
  return frame.buffer;
};

const synthesisMetadata = (requestId = context.requestId): Record<string, unknown> => ({
  schemaVersion: 1,
  requestId,
  modelIdentity: HEALTH.modelIdentity,
  pipelineRevision: HEALTH.pipelineRevision,
  sampleRate: 44_100,
  channels: 1,
  format: 'wav-pcm16le',
  frameCount: 441,
  durationSec: 0.01,
  appliedPitch: 1,
  boundaries: [
    { offset: 0, duration: 40_000, text: 'Hi 😀', textStart: 0, textEnd: 5 },
    { offset: 40_000, duration: 60_000, text: 'cafe\u0301', textStart: 6, textEnd: 11 },
  ],
});

const synthesisResponse = (body: ArrayBuffer = makeFrame(synthesisMetadata())) => {
  const result = response(undefined);
  (result.headers as Headers).set('content-type', 'application/vnd.reading-tts.synthesis');
  (result.headers as Headers).set('content-length', String(body.byteLength));
  (result.arrayBuffer as ReturnType<typeof vi.fn>).mockResolvedValue(body);
  return result;
};

describe('LaptopUsbSpeechProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.fetch.mockResolvedValue(response(HEALTH));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('declares a stable, serial, non-cacheable provider', () => {
    const provider = new LaptopUsbSpeechProvider();

    expect(provider.id).toBe('laptop-usb-supertonic');
    expect(provider.label).toBe('Laptop — Supertonic 3 por USB');
    expect(provider.cacheable).toBe(false);
    expect(provider.synthesisConcurrency).toBe(1);
    expect(provider.retryPolicy?.maxAttempts).toBe(1);
    expect(provider.compositeBoundaries).toEqual({
      textOffsets: 'utf16',
      audioTiming: 'estimated',
    });
    expect(provider.synthesisIdentity).toContain('uninitialized');
  });

  test('initializes from compatible health and exposes namespaced voices', async () => {
    const provider = new LaptopUsbSpeechProvider();

    await expect(provider.init()).resolves.toBe(true);
    await expect(provider.getAllVoices()).resolves.toEqual(HEALTH.voices);
    expect(provider.synthesisIdentity).toContain(HEALTH.pipelineRevision);
    expect(provider.synthesisIdentity).toContain(HEALTH.modelIdentity);
    expect(h.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:18765/health',
      expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) }),
    );
  });

  test('stays unavailable for absence, timeout, or incompatible health', async () => {
    const provider = new LaptopUsbSpeechProvider();
    h.fetch.mockRejectedValueOnce(new Error('connection refused'));
    await expect(provider.init()).resolves.toBe(false);
    await expect(provider.getAllVoices()).resolves.toEqual([]);

    const timedOut = new LaptopUsbSpeechProvider();
    h.fetch.mockImplementationOnce(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    vi.useFakeTimers();
    const initPromise = timedOut.init();
    await vi.advanceTimersByTimeAsync(1_600);
    await expect(initPromise).resolves.toBe(false);

    for (const field of [
      'runtimeVersion',
      'sampleRate',
      'maxTextUtf16',
      'synthesisConcurrency',
    ] as const) {
      const incompatible = new LaptopUsbSpeechProvider();
      h.fetch.mockResolvedValueOnce(
        response({ ...HEALTH, [field]: field === 'maxTextUtf16' ? 199 : 0 }),
      );
      await expect(incompatible.init()).resolves.toBe(false);
    }
  });

  test('maps context and canonical locale without sending playback rate', async () => {
    const provider = new LaptopUsbSpeechProvider();
    await provider.init();
    h.fetch.mockResolvedValueOnce(synthesisResponse());

    const result = await provider.synthesize(
      {
        lang: 'es_cl',
        text: 'Hi 😀 cafe\u0301',
        voice: 'laptop-usb:supertonic3:es:sid7',
        pitch: 1.1,
      },
      new AbortController().signal,
      context,
    );

    const [, init] = h.fetch.mock.calls[1] as [string, RequestInit];
    expect(h.fetch.mock.calls[1]?.[0]).toBe('http://127.0.0.1:18765/v1/synthesize');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual(expect.objectContaining({ 'content-type': 'application/json' }));
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      schemaVersion: 1,
      sessionId: context.sessionId,
      requestId: context.requestId,
      generation: context.generation,
      text: 'Hi 😀 cafe\u0301',
      lang: 'es-CL',
      voice: 'laptop-usb:supertonic3:es:sid7',
      pitch: 1.1,
    });
    expect(body).not.toHaveProperty('rate');
    expect(result.durationSec).toBe(0.01);
    expect(result.boundaries[0]).toEqual({
      offset: 0,
      duration: 40_000,
      text: 'Hi 😀',
      textStart: 0,
      textEnd: 5,
    });
    expect(result.boundaries[1]?.textStart).toBe(6);
    expect(result.boundaries[1]?.textEnd).toBe(11);
  });

  test('rejects corrupt or truncated frames and invalid boundaries', async () => {
    const provider = new LaptopUsbSpeechProvider();
    await provider.init();
    const cases = [
      Uint8Array.from([0, 0, 0, 0]).buffer,
      makeFrame(synthesisMetadata(), makeWav(442)),
      makeFrame({ ...synthesisMetadata(), requestId: 'other-request' }),
      makeFrame({
        ...synthesisMetadata(),
        boundaries: [{ offset: 0, duration: 100_000, text: 'wrong', textStart: 99, textEnd: 104 }],
      }),
    ];
    for (const body of cases) {
      h.fetch.mockResolvedValueOnce(synthesisResponse(body));
      await expect(
        provider.synthesize(
          {
            lang: 'en-US',
            text: 'Hi 😀 cafe\u0301',
            voice: 'laptop-usb:supertonic3:en:sid7',
            pitch: 1,
          },
          new AbortController().signal,
          context,
        ),
      ).rejects.toThrow();
    }
  });

  test('classifies request errors as permanent and session errors as transient', async () => {
    const provider = new LaptopUsbSpeechProvider();
    await provider.init();
    for (const status of [400, 413, 415, 422]) {
      h.fetch.mockResolvedValueOnce(
        response({ schemaVersion: 1, code: 'invalid_request' }, status),
      );
      await expect(
        provider.synthesize(
          { lang: 'es-ES', text: 'Texto', voice: 'laptop-usb:supertonic3:es:sid7', pitch: 1 },
          new AbortController().signal,
          context,
        ),
      ).rejects.toBeInstanceOf(SpeechSynthesisPermanentError);
    }
    h.fetch.mockResolvedValueOnce(response({ schemaVersion: 1, code: 'synthesis_failed' }, 500));
    await expect(
      provider.synthesize(
        { lang: 'es-ES', text: 'Texto', voice: 'laptop-usb:supertonic3:es:sid7', pitch: 1 },
        new AbortController().signal,
        context,
      ),
    ).rejects.not.toBeInstanceOf(SpeechSynthesisPermanentError);
  });

  test('honors abort before and during transport without exposing text', async () => {
    const provider = new LaptopUsbSpeechProvider();
    await provider.init();
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.synthesize(
        {
          lang: 'es-ES',
          text: 'secreto no debe aparecer',
          voice: 'laptop-usb:supertonic3:es:sid7',
          pitch: 1,
        },
        controller.signal,
        context,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    h.fetch.mockImplementationOnce(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    const activeController = new AbortController();
    const request = provider.synthesize(
      {
        lang: 'es-ES',
        text: 'secreto no debe aparecer',
        voice: 'laptop-usb:supertonic3:es:sid7',
        pitch: 1,
      },
      activeController.signal,
      context,
    );
    activeController.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('returns an owned WAV buffer and never logs request text', async () => {
    const provider = new LaptopUsbSpeechProvider();
    await provider.init();
    const privateText = 'secreto no debe aparecer';
    const source = makeFrame({
      ...synthesisMetadata(),
      boundaries: [
        {
          offset: 0,
          duration: 100_000,
          text: privateText,
          textStart: 0,
          textEnd: privateText.length,
        },
      ],
    });
    h.fetch.mockResolvedValueOnce(synthesisResponse(source));
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const result = await provider.synthesize(
      { lang: 'es-ES', text: privateText, voice: 'laptop-usb:supertonic3:es:sid7', pitch: 1 },
      new AbortController().signal,
      context,
    );
    expect(result.audio).not.toBe(source);
    expect(result.audio.byteLength).toBeGreaterThan(44);
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining('secreto no debe aparecer'));
    info.mockRestore();
  });
});
