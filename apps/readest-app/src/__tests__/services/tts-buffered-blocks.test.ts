import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { TTSBlockInput, TTSMessageEvent } from '@/services/tts/TTSClient';
import type { TTSController } from '@/services/tts/TTSController';
import type {
  SpeechProvider,
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
} from '@/services/tts/providers/types';
import { FakeAudioBuffer, FakeAudioContext } from './tts-fake-audio';

vi.mock('@/utils/misc', () => ({
  getOSPlatform: () => 'macos',
  getUserLocale: (lang: string) => lang,
}));

vi.mock('@/services/environment', () => ({ isTauriAppPlatform: () => false }));

vi.mock('@/services/tts/TTSUtils', () => ({
  TTSUtils: {
    getPreferredVoice: () => null,
    sortVoicesPreferLocaleFunc: () => () => 0,
  },
}));

const TICKS_PER_SECOND = 10_000_000;
const textA = 'First dialogue line, ending softly.';
const textB = 'Second dialogue line, starting here.';

const ssml = (text: string, mark = '0'): string =>
  `<speak xml:lang="en-US"><mark name="${mark}"/>${text}</speak>`;

const blocks = async function* (
  inputs: Array<{ blockOffset: number; text: string; mark?: string }>,
): AsyncGenerator<TTSBlockInput> {
  for (const input of inputs) {
    yield {
      blockOffset: input.blockOffset,
      ssml: input.text ? ssml(input.text, input.mark) : '',
    };
  }
};

const taggedAudio = (tag: number): ArrayBuffer => Uint8Array.of(tag).buffer;

const voiceSamples = (sampleRate: number, seconds = 1): Float32Array => {
  const samples = new Float32Array(Math.round(sampleRate * seconds));
  samples.fill(0.1, Math.round(sampleRate * 0.1), Math.round(sampleRate * 0.8));
  return samples;
};

const compositeSamples = (sampleRate: number, units = 2): Float32Array => {
  const samples = new Float32Array(Math.round(sampleRate * (units * 1.1 + 0.2)));
  for (let index = 0; index < units; index++) {
    const base = index * 1.1;
    samples.fill(0.1, Math.round(sampleRate * (base + 0.1)), Math.round(sampleRate * (base + 0.8)));
  }
  return samples;
};

const continuousSamples = (sampleRate: number): Float32Array => {
  const samples = new Float32Array(Math.round(sampleRate * 2.4));
  samples.fill(0.1, Math.round(sampleRate * 0.1), Math.round(sampleRate * 2.1));
  return samples;
};

const validCompositeBoundaries = (request: SpeechSynthesisRequest) => {
  let textStart = 0;
  return request.text.split('\n\n').map((text, index) => {
    const boundary = {
      offset: Math.round((index * 1.1 + 0.1) * TICKS_PER_SECOND),
      duration: Math.round(0.7 * TICKS_PER_SECOND),
      text,
      textStart,
      textEnd: textStart + text.length,
    };
    textStart = boundary.textEnd + 2;
    return boundary;
  });
};

type CompositeMode =
  | 'valid'
  | 'missing-boundaries'
  | 'continuous-pcm'
  | 'decode-error'
  | 'deferred-decode'
  | 'many-valid';

const makeProvider = (
  mode: CompositeMode,
  sourceCount: () => number,
): { provider: SpeechProvider; individualSourceCounts: number[] } => {
  const individualSourceCounts: number[] = [];
  const synthesize = vi.fn(
    async (request: SpeechSynthesisRequest): Promise<SpeechSynthesisResult> => {
      const composite = request.text.includes('\n\n');
      if (composite) {
        return {
          audio: taggedAudio(
            mode === 'decode-error'
              ? 3
              : mode === 'continuous-pcm'
                ? 2
                : mode === 'many-valid'
                  ? 5
                  : 1,
          ),
          boundaries: mode === 'missing-boundaries' ? [] : validCompositeBoundaries(request),
          durationSec: 2.4,
        };
      }
      individualSourceCounts.push(sourceCount());
      return {
        audio: taggedAudio(4),
        boundaries: [],
        durationSec: 1,
      };
    },
  );
  return {
    individualSourceCounts,
    provider: {
      id: 'composite-test-provider',
      label: 'Composite test provider',
      cacheable: false,
      synthesisConcurrency: 1,
      compositeBoundaries: { textOffsets: 'utf16', audioTiming: 'estimated' },
      init: vi.fn(async () => true),
      getAllVoices: vi.fn(async () => [{ id: 'voice-a', name: 'Voice A', lang: 'en-US' }]),
      synthesize,
    },
  };
};

type BufferedClient = InstanceType<
  typeof import('@/services/tts/BufferedTTSClient').BufferedTTSClient
>;

const collect = (
  client: BufferedClient,
  input: AsyncIterable<TTSBlockInput>,
  signal = new AbortController().signal,
) => {
  const events: TTSMessageEvent[] = [];
  const done = (async () => {
    for await (const event of client.speakBlocks!(input, signal)) events.push(event);
  })();
  return { events, done };
};

const drain = async (ctx: FakeAudioContext, done: Promise<void>): Promise<void> => {
  let finished = false;
  void done.then(() => {
    finished = true;
  });
  for (let index = 0; index < 50 && !finished; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const next = ctx.sources
      .filter((source) => !source.endedFired && !source.stopped)
      .sort((left, right) => left.endTime - right.endTime)[0];
    if (next) await ctx.advanceTo(next.endTime + 0.001);
  }
  await done;
};

const audibleSources = (ctx: FakeAudioContext) =>
  ctx.sources.filter((source) => (source.buffer?.duration ?? 0) > 0.01);

const markerSources = (ctx: FakeAudioContext) =>
  ctx.sources.filter((source) => (source.buffer?.duration ?? 0) <= 0.01);

describe('BufferedTTSClient streamed composite playback', () => {
  beforeEach(() => {
    vi.resetModules();
    FakeAudioContext.instances = [];
    localStorage.clear();
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const startClient = async (mode: CompositeMode, sampleRate: number) => {
    let releaseDecode: () => void = () => {};
    const decodeGate = new Promise<void>((resolve) => {
      releaseDecode = resolve;
    });
    const decode = vi.fn(async (data: ArrayBuffer) => {
      const tag = new Uint8Array(data)[0];
      if (tag === 3) throw new Error('decode failed');
      if (mode === 'deferred-decode') await decodeGate;
      const samples =
        tag === 1
          ? compositeSamples(sampleRate)
          : tag === 5
            ? compositeSamples(sampleRate, 4)
            : tag === 2
              ? continuousSamples(sampleRate)
              : voiceSamples(sampleRate);
      return new FakeAudioBuffer(samples, sampleRate);
    });
    class TestAudioContext extends FakeAudioContext {
      constructor() {
        super(sampleRate);
        this.decodeImpl = decode;
      }
    }
    vi.stubGlobal('AudioContext', TestAudioContext);
    const { BufferedTTSClient } = await import('@/services/tts/BufferedTTSClient');
    const { provider, individualSourceCounts } = makeProvider(
      mode,
      () => FakeAudioContext.instances[0]?.sources.length ?? 0,
    );
    const controller = {
      dispatchSpeakMark: vi.fn(),
      prepareSpeakWords: vi.fn(),
      dispatchSpeakWord: vi.fn(),
    };
    const client = new BufferedTTSClient(provider, controller as unknown as TTSController);
    await client.init();
    const ctx = () => FakeAudioContext.instances[0]!;
    return { client, provider, individualSourceCounts, controller, ctx, decode, releaseDecode };
  };

  test('requires explicit composite capability instead of an engine identity check', async () => {
    const { client, provider } = await startClient('valid', 24_000);
    expect(client.supportsBlockStreaming()).toBe(true);
    expect(client.getCapabilities().gapControl).toBe(false);

    delete (provider as { compositeBoundaries?: SpeechProvider['compositeBoundaries'] })
      .compositeBoundaries;

    expect(client.supportsBlockStreaming()).toBe(false);
  });

  test.each([
    24_000, 48_000,
  ])('synthesizes and decodes once, then schedules one continuous chunk with logical marks at %i Hz', async (sampleRate) => {
    const { client, provider, controller, ctx, decode } = await startClient('valid', sampleRate);
    client.setSentenceGap(0.1);
    client.setParagraphGap(0.3);
    const run = collect(
      client,
      blocks([
        { blockOffset: 0, text: textA, mark: '0' },
        { blockOffset: 1, text: textB, mark: '0' },
      ]),
    );

    await vi.waitFor(() => expect(FakeAudioContext.instances).toHaveLength(1));
    await vi.waitFor(() => expect(ctx().sources).toHaveLength(2));

    expect(provider.synthesize).toHaveBeenCalledTimes(1);
    expect(provider.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({ text: `${textA}\n\n${textB}` }),
      expect.any(AbortSignal),
      expect.any(Object),
    );
    expect(decode).toHaveBeenCalledTimes(1);
    expect(audibleSources(ctx())).toHaveLength(1);
    expect(markerSources(ctx())).toHaveLength(1);
    // The paragraph-gap setting cannot be inserted inside uncut PCM. The
    // marker rides the estimated audio offset while speech remains continuous.
    expect(markerSources(ctx())[0]!.startedAt!).toBeLessThan(audibleSources(ctx())[0]!.endTime);

    await drain(ctx(), run.done);
    expect(run.events.map((event) => event.code)).toEqual(['boundary', 'boundary', 'end']);
    expect(run.events.slice(0, 2).map((event) => event.logicalBoundary)).toMatchObject([
      { blockOffset: 0, mark: { name: '0', text: textA } },
      { blockOffset: 1, mark: { name: '0', text: textB } },
    ]);
    expect(controller.prepareSpeakWords.mock.calls).toEqual([[[textA]], [[textB]]]);
    expect(run.events.at(-1)).toMatchObject({ code: 'end', consumedBlockOffset: 1 });
    expect(client.getSynthesisMetrics()).toMatchObject({
      attempts: 1,
      composite: {
        compositeRequests: 1,
        compositesScheduled: 1,
        logicalMarksScheduled: 2,
        logicalMarksStarted: 2,
        fallbackSessions: 0,
      },
    });
  });

  test('keeps many logical marks inside one bounded physical chunk', async () => {
    const { client, provider, ctx } = await startClient('many-valid', 24_000);
    const run = collect(
      client,
      blocks(
        Array.from({ length: 4 }, (_, blockOffset) => ({
          blockOffset,
          text: `D${blockOffset}${'x'.repeat(11)}`,
          mark: '0',
        })),
      ),
    );

    await vi.waitFor(() => expect(ctx().sources).toHaveLength(4));
    expect(provider.synthesize).toHaveBeenCalledTimes(1);
    expect(audibleSources(ctx())).toHaveLength(1);
    expect(markerSources(ctx())).toHaveLength(3);

    await drain(ctx(), run.done);
    expect(ctx().sources).toHaveLength(4);
    expect(run.events.filter((event) => event.code === 'boundary')).toHaveLength(4);
    expect(run.events.at(-1)).toMatchObject({ code: 'end', consumedBlockOffset: 3 });
    expect(client.getSynthesisMetrics()).toMatchObject({
      composite: { logicalMarksScheduled: 4, logicalMarksStarted: 4 },
    });
  });

  test.each([
    ['missing-boundaries', 'boundaries'],
    ['decode-error', 'decode'],
  ] as const)('falls back before scheduling and latches the %s failure', async (mode, reason) => {
    const { client, provider, individualSourceCounts, ctx } = await startClient(mode, 24_000);
    const inputs = [0, 1, 2, 3].map((blockOffset) => ({
      blockOffset,
      text: `${String.fromCharCode(65 + blockOffset)}${'x'.repeat(34)}`,
      mark: '0',
    }));
    const run = collect(client, blocks(inputs));

    await vi.waitFor(() => expect(FakeAudioContext.instances).toHaveLength(1));
    await vi.waitFor(() => expect(ctx().sources.length).toBeGreaterThan(0));
    await drain(ctx(), run.done);

    const requests = vi.mocked(provider.synthesize).mock.calls.map(([request]) => request.text);
    expect(requests.filter((text) => text.includes('\n\n'))).toHaveLength(1);
    expect(requests).toHaveLength(5);
    expect(individualSourceCounts[0]).toBe(0);
    expect(run.events.filter((event) => event.code === 'end')).toHaveLength(1);
    expect(run.events.filter((event) => event.code === 'boundary')).toHaveLength(4);
    expect(client.getSynthesisMetrics()).toMatchObject({
      composite: {
        compositeRequests: 1,
        compositesScheduled: 0,
        fallbackSessions: 1,
        fallbackIndividualRequests: 4,
        fallbackReasons: { [reason]: 1 },
      },
    });
  });

  test('plays continuous composite PCM without cuts or individual regeneration', async () => {
    const { client, provider, ctx } = await startClient('continuous-pcm', 24_000);
    const run = collect(
      client,
      blocks([
        { blockOffset: 0, text: textA },
        { blockOffset: 1, text: textB },
      ]),
    );

    await vi.waitFor(() => expect(audibleSources(ctx())).toHaveLength(1));
    expect(provider.synthesize).toHaveBeenCalledTimes(1);
    expect(markerSources(ctx())).toHaveLength(1);

    await drain(ctx(), run.done);
    expect(run.events.map((event) => event.code)).toEqual(['boundary', 'boundary', 'end']);
    expect(client.getSynthesisMetrics()).toMatchObject({
      attempts: 1,
      composite: {
        compositesScheduled: 1,
        logicalMarksScheduled: 2,
        logicalMarksStarted: 2,
        fallbackSessions: 0,
        fallbackIndividualRequests: 0,
      },
      playback: { scheduledChunks: 1 },
    });
  });

  test('reports media position relative to the active logical mark', async () => {
    const { client, ctx } = await startClient('valid', 24_000);
    const run = collect(
      client,
      blocks([
        { blockOffset: 0, text: textA },
        { blockOffset: 1, text: textB },
      ]),
    );

    await vi.waitFor(() => expect(markerSources(ctx())).toHaveLength(1));
    const marker = markerSources(ctx())[0]!;
    await ctx().advanceTo(marker.endTime + 0.2);
    await vi.waitFor(() =>
      expect(run.events.filter((event) => event.code === 'boundary')).toHaveLength(2),
    );

    expect(client.getChunkPosition()).toBeCloseTo(0.2, 2);
    await drain(ctx(), run.done);
  });

  test('maps estimated media offsets onto the rate-stretched output clock', async () => {
    const { client, ctx } = await startClient('valid', 24_000);
    await client.setRate(2);
    const run = collect(
      client,
      blocks([
        { blockOffset: 0, text: textA },
        { blockOffset: 1, text: textB },
      ]),
    );

    await vi.waitFor(() => expect(markerSources(ctx())).toHaveLength(1));
    const audible = audibleSources(ctx())[0]!;
    const marker = markerSources(ctx())[0]!;
    const outputFraction = (marker.startedAt! - audible.startedAt!) / audible.buffer!.duration;
    // Composite speech is trimmed to media [0.08, 1.95], and the second
    // logical unit's estimated first range starts at 1.2s.
    expect(outputFraction).toBeCloseTo((1.2 - 0.08) / (1.95 - 0.08), 3);

    await drain(ctx(), run.done);
  });

  test('reports trailing empty blocks only on the successful terminal end', async () => {
    const { client, ctx } = await startClient('valid', 24_000);
    const run = collect(
      client,
      blocks([
        { blockOffset: 0, text: textA },
        { blockOffset: 4, text: '' },
      ]),
    );

    await vi.waitFor(() => expect(FakeAudioContext.instances).toHaveLength(1));
    await vi.waitFor(() => expect(ctx().sources).toHaveLength(1));
    await drain(ctx(), run.done);

    expect(run.events).toHaveLength(2);
    expect(run.events[0]).toMatchObject({
      code: 'boundary',
      logicalBoundary: { blockOffset: 0 },
    });
    expect(run.events[1]).toMatchObject({ code: 'end', consumedBlockOffset: 4 });
  });

  test('an abort during composite decode schedules no late audio or fallback', async () => {
    const { client, provider, ctx, decode, releaseDecode } = await startClient(
      'deferred-decode',
      24_000,
    );
    const abort = new AbortController();
    const run = collect(
      client,
      blocks([
        { blockOffset: 0, text: textA },
        { blockOffset: 1, text: textB },
      ]),
      abort.signal,
    );

    await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(1));
    abort.abort();
    releaseDecode();
    await run.done;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(provider.synthesize).toHaveBeenCalledTimes(1);
    expect(ctx().sources).toHaveLength(0);
    expect(run.events).toEqual([{ code: 'error', message: 'Aborted' }]);
    expect(client.getSynthesisMetrics()).toMatchObject({
      composite: {
        logicalMarksStarted: 0,
        fallbackSessions: 0,
        fallbackIndividualRequests: 0,
      },
    });
  });

  test('does not count internal logical marks after playback is aborted', async () => {
    const { client, ctx } = await startClient('valid', 24_000);
    const abort = new AbortController();
    const run = collect(
      client,
      blocks([
        { blockOffset: 0, text: textA },
        { blockOffset: 1, text: textB },
      ]),
      abort.signal,
    );

    await vi.waitFor(() =>
      expect(run.events.filter((event) => event.code === 'boundary')).toHaveLength(1),
    );
    expect(client.getSynthesisMetrics()).toMatchObject({
      composite: { logicalMarksScheduled: 2, logicalMarksStarted: 1 },
    });

    abort.abort();
    await run.done;
    await ctx().advanceTo(100);
    expect(client.getSynthesisMetrics()).toMatchObject({
      composite: { logicalMarksScheduled: 2, logicalMarksStarted: 1 },
    });
  });

  test('rejects a nonzero initial block offset without synthesis or a success marker', async () => {
    const { client, provider, ctx } = await startClient('valid', 24_000);
    const run = collect(client, blocks([{ blockOffset: 2, text: textA }]));

    await run.done;

    expect(provider.synthesize).not.toHaveBeenCalled();
    expect(ctx().sources).toHaveLength(0);
    expect(run.events).toEqual([
      { code: 'error', message: 'Invalid streamed TTS block offset: 2' },
    ]);
  });
});
