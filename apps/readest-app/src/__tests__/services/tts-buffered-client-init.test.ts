import { describe, expect, test, vi } from 'vitest';

vi.mock('@/services/environment', () => ({ isTauriAppPlatform: () => false }));
vi.mock('@/utils/misc', () => ({
  getOSPlatform: () => 'macos',
  getUserLocale: (lang: string) => lang,
}));

import { BufferedTTSClient } from '@/services/tts/BufferedTTSClient';
import { CachingProvider } from '@/services/tts/providers/cache';
import type { SpeechProvider } from '@/services/tts/providers/types';

describe('BufferedTTSClient initialization', () => {
  test('initializes the provider before enumerating engine-dependent voices', async () => {
    const calls: string[] = [];
    let engineReady = false;
    const provider: SpeechProvider = {
      id: 'init-order-provider',
      label: 'Init order provider',
      init: vi.fn(async () => {
        calls.push('init');
        engineReady = true;
        return true;
      }),
      getAllVoices: vi.fn(async () => {
        calls.push('voices');
        if (!engineReady) throw new Error('engine not initialized');
        return [{ id: 'voice', name: 'Voice', lang: 'en-US' }];
      }),
      synthesize: vi.fn(async () => ({ audio: new ArrayBuffer(1), boundaries: [] })),
    };
    const client = new BufferedTTSClient(provider);

    await expect(client.init()).resolves.toBe(true);

    expect(calls).toEqual(['init', 'voices']);
    await expect(client.getAllVoices()).resolves.toHaveLength(1);
  });

  test('does not enumerate voices when provider initialization fails', async () => {
    const provider: SpeechProvider = {
      id: 'unavailable-provider',
      label: 'Unavailable provider',
      init: vi.fn(async () => false),
      getAllVoices: vi.fn(async () => []),
      synthesize: vi.fn(async () => ({ audio: new ArrayBuffer(1), boundaries: [] })),
    };
    const client = new BufferedTTSClient(provider);

    await expect(client.init()).resolves.toBe(false);

    expect(provider.getAllVoices).not.toHaveBeenCalled();
  });

  test('does not advertise downloads when the wrapped provider forbids persistence', () => {
    const inner: SpeechProvider = {
      id: 'non-persistent-provider',
      label: 'Non-persistent provider',
      cacheable: false,
      init: vi.fn(async () => true),
      getAllVoices: vi.fn(async () => []),
      synthesize: vi.fn(async () => ({ audio: new ArrayBuffer(1), boundaries: [] })),
    };
    const cached = new CachingProvider(inner, {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    });
    const client = new BufferedTTSClient(cached);

    expect(client.canDownload()).toBe(false);
    expect(client.getCapabilities()).toMatchObject({ cacheable: false, downloadable: false });
  });
});
