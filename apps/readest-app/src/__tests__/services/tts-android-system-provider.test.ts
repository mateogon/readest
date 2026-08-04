import { beforeEach, describe, expect, test, vi } from 'vitest';

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: h.invoke,
}));

import {
  ANDROID_BUFFERED_VOICE_PREFIX,
  AndroidSystemSpeechProvider,
} from '@/services/tts/providers/android';
import { SpeechSynthesisPermanentError } from '@/services/tts/providers/types';
import { SynthesisCoordinator } from '@/services/tts/SynthesisCoordinator';

const initResponse = {
  success: true,
  enginePackage: 'dev.example.engine',
  engineVersion: '42',
  maxInputLength: 4_000,
};

const nativeVoices = [
  { id: 'engine_en_voice', name: 'English voice', lang: 'en-US' },
  { id: 'engine_es_voice', name: 'Voz española', lang: 'es-ES' },
];

const context = {
  sessionId: 'session-1',
  requestId: 'session-1:0:1',
  generation: 0,
};

describe('AndroidSystemSpeechProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.invoke.mockImplementation((command: string) => {
      if (command === 'plugin:native-tts|init') return Promise.resolve(initResponse);
      if (command === 'plugin:native-tts|get_all_voices') {
        return Promise.resolve({ voices: nativeVoices });
      }
      if (command === 'plugin:native-tts|synthesize_to_file') {
        return Promise.resolve({
          assetId: 'asset-1',
          sampleRate: 44_100,
          frameCount: 44_100,
          durationSec: 1,
          enginePackage: initResponse.enginePackage,
          engineVersion: initResponse.engineVersion,
          maxInputLength: initResponse.maxInputLength,
          boundaries: [
            { offset: 0, duration: 3_000_000, text: 'Hi', textStart: 0, textEnd: 2 },
            { offset: 3_000_000, duration: 3_000_000, text: '😀', textStart: 3, textEnd: 5 },
            {
              offset: 6_000_000,
              duration: 4_000_000,
              text: 'cafe\u{301}',
              textStart: 6,
              textEnd: 11,
            },
          ],
        });
      }
      if (command === 'plugin:native-tts|read_synthesis_audio') {
        return Promise.resolve(Uint8Array.from([82, 73, 70, 70]).buffer);
      }
      if (command === 'plugin:native-tts|cancel_synthesis') return Promise.resolve(undefined);
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
  });

  test('declares a serial, ephemeral experimental provider', () => {
    const provider = new AndroidSystemSpeechProvider();

    expect(provider.id).toBe('android-system-buffered');
    expect(provider.label).toBe('System TTS — Buffered (Experimental)');
    expect(provider.cacheable).toBe(false);
    expect(provider.synthesisConcurrency).toBe(1);
    expect(provider.retryPolicy?.maxAttempts).toBe(2);
    expect(provider.compositeBoundaries).toEqual({
      textOffsets: 'utf16',
      audioTiming: 'estimated',
    });
  });

  test('initializes before exposing a runtime engine identity', async () => {
    const provider = new AndroidSystemSpeechProvider();
    expect(provider.synthesisIdentity).toContain('uninitialized');

    await expect(provider.init()).resolves.toBe(true);

    expect(provider.synthesisIdentity).toContain('dev.example.engine');
    expect(provider.synthesisIdentity).toContain('42');
    expect(h.invoke).toHaveBeenCalledWith('plugin:native-tts|init');
  });

  test('stays unavailable when a legacy plugin cannot expose safe engine identity', async () => {
    h.invoke.mockResolvedValueOnce({ success: true });
    const provider = new AndroidSystemSpeechProvider();

    await expect(provider.init()).resolves.toBe(false);
    expect(provider.synthesisIdentity).toContain('uninitialized');
  });

  test('clears stale engine identity when a later initialization fails', async () => {
    const provider = new AndroidSystemSpeechProvider();
    await expect(provider.init()).resolves.toBe(true);
    expect(provider.synthesisIdentity).toContain('dev.example.engine');

    h.invoke.mockResolvedValueOnce({ success: false });

    await expect(provider.init()).resolves.toBe(false);
    expect(provider.synthesisIdentity).toContain('uninitialized');
  });

  test('namespaces native voice IDs so direct and buffered modes cannot collide', async () => {
    const provider = new AndroidSystemSpeechProvider();
    await provider.init();

    await expect(provider.getAllVoices()).resolves.toEqual([
      {
        ...nativeVoices[0],
        id: `${ANDROID_BUFFERED_VOICE_PREFIX}${nativeVoices[0]!.id}`,
      },
      {
        ...nativeVoices[1],
        id: `${ANDROID_BUFFERED_VOICE_PREFIX}${nativeVoices[1]!.id}`,
      },
    ]);
  });

  test('performs one atomic native synthesis and reads the resulting asset as bytes', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const provider = new AndroidSystemSpeechProvider();
    await provider.init();

    const result = await provider.synthesize(
      {
        lang: 'en_us',
        text: 'Hi 😀 cafe\u{301}',
        voice: `${ANDROID_BUFFERED_VOICE_PREFIX}engine_en_voice`,
        pitch: 1.1,
      },
      new AbortController().signal,
      context,
    );

    expect(h.invoke).toHaveBeenCalledWith('plugin:native-tts|synthesize_to_file', {
      payload: {
        text: 'Hi 😀 cafe\u{301}',
        enginePackage: 'dev.example.engine',
        voice: 'engine_en_voice',
        locale: 'en-US',
        pitch: 1.1,
        rate: 1,
        sessionId: context.sessionId,
        requestId: context.requestId,
        generation: context.generation,
      },
    });
    expect(h.invoke).toHaveBeenCalledWith('plugin:native-tts|read_synthesis_audio', {
      payload: { assetId: 'asset-1' },
    });
    expect(Array.from(new Uint8Array(result.audio))).toEqual([82, 73, 70, 70]);
    expect(result.durationSec).toBe(1);
    expect(result.boundaries).toEqual([
      { offset: 0, duration: 3_000_000, text: 'Hi', textStart: 0, textEnd: 2 },
      { offset: 3_000_000, duration: 3_000_000, text: '😀', textStart: 3, textEnd: 5 },
      {
        offset: 6_000_000,
        duration: 4_000_000,
        text: 'cafe\u{301}',
        textStart: 6,
        textEnd: 11,
      },
    ]);
    expect(result.boundaries[1]!.textStart).toBe(3);
    expect(result.boundaries[1]!.textEnd).toBe(5);
    const diagnosticCalls = info.mock.calls.filter(
      ([message]) => typeof message === 'string' && message.startsWith('[TTS][AndroidBuffered] '),
    );
    const diagnosticPayloads = diagnosticCalls.map(([message]) =>
      JSON.parse((message as string).slice('[TTS][AndroidBuffered] '.length)),
    );
    expect(diagnosticPayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'native-start',
          sessionId: context.sessionId,
          requestId: context.requestId,
          generation: context.generation,
        }),
        expect.objectContaining({ event: 'bridge-completed' }),
      ]),
    );
    expect(diagnosticCalls.every((call) => call.length === 1)).toBe(true);
    expect(
      diagnosticCalls.every(([message]) => !(message as string).includes('Hi 😀 cafe\u{301}')),
    ).toBe(true);
    info.mockRestore();
  });

  test('rejects oversized input permanently without starting native synthesis', async () => {
    const provider = new AndroidSystemSpeechProvider();
    h.invoke.mockImplementation((command: string) => {
      if (command === 'plugin:native-tts|init') {
        return Promise.resolve({ ...initResponse, maxInputLength: 4 });
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
    await provider.init();

    await expect(
      provider.synthesize(
        {
          lang: 'en',
          text: 'Hello',
          voice: `${ANDROID_BUFFERED_VOICE_PREFIX}engine_en_voice`,
          pitch: 1,
        },
        new AbortController().signal,
        context,
      ),
    ).rejects.toBeInstanceOf(SpeechSynthesisPermanentError);
    expect(h.invoke).not.toHaveBeenCalledWith(
      'plugin:native-tts|synthesize_to_file',
      expect.anything(),
    );
  });

  test('waits for native cancellation before rejecting an aborted synthesis', async () => {
    let resolveSynthesis!: (value: unknown) => void;
    let resolveCancellation!: () => void;
    const synthesis = new Promise((resolve) => {
      resolveSynthesis = resolve;
    });
    const cancellation = new Promise<void>((resolve) => {
      resolveCancellation = resolve;
    });
    h.invoke.mockImplementation((command: string) => {
      if (command === 'plugin:native-tts|init') return Promise.resolve(initResponse);
      if (command === 'plugin:native-tts|synthesize_to_file') return synthesis;
      if (command === 'plugin:native-tts|cancel_synthesis') return cancellation;
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
    const provider = new AndroidSystemSpeechProvider();
    await provider.init();
    const abortController = new AbortController();
    const pending = provider.synthesize(
      {
        lang: 'en',
        text: 'Hello',
        voice: `${ANDROID_BUFFERED_VOICE_PREFIX}engine_en_voice`,
        pitch: 1,
      },
      abortController.signal,
      context,
    );

    abortController.abort();
    await vi.waitFor(() =>
      expect(h.invoke).toHaveBeenCalledWith('plugin:native-tts|cancel_synthesis', {
        payload: context,
      }),
    );
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveCancellation();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    resolveSynthesis({});
  });

  test('does not report cancellation success or start more work when native reuse fails', async () => {
    const neverFinishes = new Promise(() => undefined);
    h.invoke.mockImplementation((command: string) => {
      if (command === 'plugin:native-tts|init') return Promise.resolve(initResponse);
      if (command === 'plugin:native-tts|synthesize_to_file') return neverFinishes;
      if (command === 'plugin:native-tts|cancel_synthesis') {
        return Promise.reject(new Error('engine could not be reset'));
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
    const provider = new AndroidSystemSpeechProvider();
    await provider.init();
    const abortController = new AbortController();
    const first = provider.synthesize(
      {
        lang: 'en',
        text: 'Hello',
        voice: `${ANDROID_BUFFERED_VOICE_PREFIX}engine_en_voice`,
        pitch: 1,
      },
      abortController.signal,
      context,
    );

    abortController.abort();
    await expect(first).rejects.toMatchObject({
      name: 'AndroidSpeechConnectionError',
      retryable: false,
    });

    await expect(
      provider.synthesize(
        {
          lang: 'en',
          text: 'Second request',
          voice: `${ANDROID_BUFFERED_VOICE_PREFIX}engine_en_voice`,
          pitch: 1,
        },
        new AbortController().signal,
        { ...context, requestId: 'session-1:0:2' },
      ),
    ).rejects.toMatchObject({ name: 'AndroidSpeechConnectionError', retryable: false });
    expect(
      h.invoke.mock.calls.filter(([command]) => command === 'plugin:native-tts|synthesize_to_file'),
    ).toHaveLength(1);
  });

  test('cleans a ready asset after a bridge read failure without retrying inference', async () => {
    const provider = new AndroidSystemSpeechProvider();
    await provider.init();
    h.invoke.mockImplementation((command: string) => {
      if (command === 'plugin:native-tts|synthesize_to_file') {
        return Promise.resolve({
          assetId: 'asset-unreadable',
          sampleRate: 44_100,
          frameCount: 44_100,
          durationSec: 1,
          enginePackage: initResponse.enginePackage,
          engineVersion: initResponse.engineVersion,
          maxInputLength: initResponse.maxInputLength,
          boundaries: [],
        });
      }
      if (command === 'plugin:native-tts|read_synthesis_audio') {
        return Promise.reject(new Error('bridge read failed'));
      }
      if (command === 'plugin:native-tts|cancel_synthesis') return Promise.resolve(undefined);
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    await expect(
      provider.synthesize(
        {
          lang: 'en',
          text: 'Hello',
          voice: `${ANDROID_BUFFERED_VOICE_PREFIX}engine_en_voice`,
          pitch: 1,
        },
        new AbortController().signal,
        context,
      ),
    ).rejects.toThrow('bridge read failed');

    expect(h.invoke).toHaveBeenCalledWith('plugin:native-tts|cancel_synthesis', {
      payload: context,
    });
    expect(
      h.invoke.mock.calls.filter(([command]) => command === 'plugin:native-tts|synthesize_to_file'),
    ).toHaveLength(1);
  });

  test('reinitializes and retries exactly once after an explicit engine disconnect', async () => {
    let synthesisAttempts = 0;
    h.invoke.mockImplementation((command: string) => {
      if (command === 'plugin:native-tts|init') return Promise.resolve(initResponse);
      if (command === 'plugin:native-tts|synthesize_to_file') {
        synthesisAttempts += 1;
        if (synthesisAttempts === 1) return Promise.reject(new Error('TTS engine disconnected'));
        return Promise.resolve({
          assetId: 'asset-after-reconnect',
          sampleRate: 44_100,
          frameCount: 44_100,
          durationSec: 1,
          enginePackage: initResponse.enginePackage,
          engineVersion: initResponse.engineVersion,
          maxInputLength: initResponse.maxInputLength,
          boundaries: [],
        });
      }
      if (command === 'plugin:native-tts|read_synthesis_audio') {
        return Promise.resolve(Uint8Array.from([82, 73, 70, 70]).buffer);
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
    const provider = new AndroidSystemSpeechProvider();
    await provider.init();
    const coordinator = new SynthesisCoordinator(provider);

    const lease = coordinator.acquire(
      {
        lang: 'en',
        text: 'Hello',
        voice: `${ANDROID_BUFFERED_VOICE_PREFIX}engine_en_voice`,
        pitch: 1,
      },
      { priority: 'playback' },
    );

    await expect(lease.result).resolves.toMatchObject({ audio: expect.any(ArrayBuffer) });
    expect(synthesisAttempts).toBe(2);
    expect(
      h.invoke.mock.calls.filter(([command]) => command === 'plugin:native-tts|init'),
    ).toHaveLength(2);
    expect(coordinator.getMetrics()).toMatchObject({ attempts: 2, retries: 1 });
  });

  test.each([
    'Invalid synthesis request: text exceeds the Android TTS input limit',
    'Invalid synthesis metadata: malformed duration',
    'Invalid synthesis audio: malformed WAV',
    'Requested TTS engine does not match the initialized engine',
  ])('classifies native contract failures as permanent: %s', async (message) => {
    const provider = new AndroidSystemSpeechProvider();
    await provider.init();
    h.invoke.mockImplementation((command: string) => {
      if (command === 'plugin:native-tts|synthesize_to_file') {
        return Promise.reject(new Error(message));
      }
      if (command === 'plugin:native-tts|cancel_synthesis') return Promise.resolve(undefined);
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    await expect(
      provider.synthesize(
        {
          lang: 'en',
          text: 'Hello',
          voice: `${ANDROID_BUFFERED_VOICE_PREFIX}engine_en_voice`,
          pitch: 1,
        },
        new AbortController().signal,
        context,
      ),
    ).rejects.toBeInstanceOf(SpeechSynthesisPermanentError);
  });
});
