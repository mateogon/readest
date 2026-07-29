import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adbShell } from './helpers/adb';
import { type CdpConsoleEntry, CdpPage } from './helpers/cdp';
import {
  APP_PKG,
  STOCK_APP_PKG,
  detectAndroidEnv,
  gotoChapter,
  openFixtureBook,
  waitFor,
} from './helpers/reader';

const FIXTURE = path.resolve(__dirname, '../fixtures/data/sample-alice.epub');
const BUFFERED_PROVIDER = 'android-system-buffered';
const BUFFERED_VOICE_PREFIX = 'android-buffered:';
const ANDROID_EVENT_PREFIX = '[TTS][AndroidBuffered] ';
const WEB_AUDIO_EVENT_PREFIX = '[TTS][WebAudio] ';
const COMPOSITE_EVENT_PREFIX = '[TTS][Composite] ';
const METRICS_EVENT_PREFIX = '[TTS][BufferedMetrics] ';

interface ElementTarget {
  x: number;
  y: number;
  text: string;
}

interface StructuredPayload {
  [key: string]: unknown;
  event?: unknown;
  marks?: unknown;
  requestId?: unknown;
  sessionId?: unknown;
  generation?: unknown;
  client?: unknown;
  reason?: unknown;
  playback?: unknown;
  composite?: unknown;
  compositesScheduled?: unknown;
  fallbackSessions?: unknown;
  currentBufferAheadMs?: unknown;
  retainedChunks?: unknown;
}

interface StructuredEvent {
  index: number;
  payload: StructuredPayload;
}

const parseStructuredEvents = (entries: CdpConsoleEntry[], prefix: string): StructuredEvent[] =>
  entries.flatMap((entry, index) => {
    if (!entry.text.startsWith(prefix)) return [];
    try {
      const value: unknown = JSON.parse(entry.text.slice(prefix.length));
      return value && typeof value === 'object'
        ? [{ index, payload: value as StructuredPayload }]
        : [];
    } catch {
      return [];
    }
  });

const visibleAriaTarget = (page: CdpPage, label: string, root = 'body') =>
  page.evaluate<ElementTarget | null>(`
    const scope = document.querySelector(${JSON.stringify(root)});
    if (!scope) return null;
    const element = [...scope.querySelectorAll('[aria-label]')].find((candidate) => {
      if (candidate.getAttribute('aria-label') !== ${JSON.stringify(label)}) return false;
      const rect = candidate.getBoundingClientRect();
      const style = getComputedStyle(candidate);
      const hit = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' &&
        style.display !== 'none' && !candidate.disabled && !!hit &&
        (hit === candidate || candidate.contains(hit));
    });
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      text: (element.textContent ?? '').trim(),
    };
  `);

const tapAria = async (page: CdpPage, label: string, root = 'body'): Promise<void> => {
  const target = await waitFor(() => visibleAriaTarget(page, label, root), {
    timeoutMs: 60_000,
    label: `visible ${label} control`,
  });
  await page.tap(target.x, target.y);
};

const revealReaderChrome = async (page: CdpPage): Promise<void> => {
  if (await visibleAriaTarget(page, 'Speak')) return;
  const viewport = await page.evaluate<{ width: number; height: number }>(`
    return { width: window.innerWidth, height: window.innerHeight };
  `);
  await waitFor(
    async () => {
      const visible = await visibleAriaTarget(page, 'Speak');
      if (visible) return true;
      // A just-stopped session briefly owns the same surface transition; retry
      // the genuine reader tap after it settles instead of dispatching app state.
      await page.tap(viewport.width / 2, viewport.height / 2);
      await new Promise((resolve) => setTimeout(resolve, 500));
      return (await visibleAriaTarget(page, 'Speak')) ? true : null;
    },
    {
      label: 'visible reader controls',
    },
  );
};

const findBufferedVoiceTarget = (page: CdpPage) =>
  page.evaluate<ElementTarget | null>(`
    const sheet = document.querySelector('#tts_player_sheet');
    if (!sheet) return null;
    const button = [...sheet.querySelectorAll('button')].find((candidate) => {
      const heading = candidate.parentElement?.firstElementChild?.textContent ?? '';
      const rect = candidate.getBoundingClientRect();
      return heading.includes('System TTS') && heading.includes('Buffered') &&
        !candidate.disabled && rect.width > 0 && rect.height > 0;
    });
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      text: (button.textContent ?? '').trim(),
    };
  `);

const bufferedE2E = process.env['READEST_ANDROID_BUFFERED_E2E'] === '1';
const androidEnv = bufferedE2E ? await detectAndroidEnv() : null;

describe.runIf(bufferedE2E)('Android buffered System TTS over the existing CDP lane', () => {
  let page: CdpPage;

  beforeAll(async () => {
    if (APP_PKG === STOCK_APP_PKG) {
      throw new Error(
        'Refusing to mutate stock Readest; set READEST_ANDROID_PACKAGE to an isolated debug package',
      );
    }
    if (!androidEnv) {
      throw new Error(`Android buffered E2E prerequisites missing for ${APP_PKG}`);
    }
    if (!existsSync(FIXTURE)) throw new Error(`fixture not found: ${FIXTURE}`);

    const defaultEngine = (await adbShell('settings get secure tts_default_synth')).trim();
    if (!defaultEngine || defaultEngine === 'null') {
      throw new Error('Android has no default TextToSpeech engine configured');
    }
    const services = await adbShell(
      'cmd package query-services -a android.intent.action.TTS_SERVICE',
    );
    if (!services.includes(`packageName=${defaultEngine}`)) {
      throw new Error(`default TextToSpeech engine is not registered: ${defaultEngine}`);
    }

    page = await openFixtureBook(FIXTURE);
    const chapterOpened = await waitFor(() => gotoChapter(page, 'chapter\\s*4'), {
      timeoutMs: 30_000,
      intervalMs: 500,
      label: 'stable Chapter 4 navigation',
    });
    if (!chapterOpened) {
      throw new Error('sample-alice.epub has no Chapter 4 text section');
    }
    await waitFor(
      () =>
        page.evaluate<boolean>(`
          const view = document.querySelector('foliate-view');
          const primary = view?.renderer?.getContents?.().find(
            (content) => content.doc && content.index === view.renderer.primaryIndex,
          );
          return (primary?.doc?.body?.textContent ?? '').trim().length > 200;
        `),
      { timeoutMs: 30_000, label: 'Chapter 4 text content' },
    );
  }, 120_000);

  afterAll(async () => {
    const stop = page ? await visibleAriaTarget(page, 'Stop reading aloud') : null;
    if (stop) await page.tap(stop.x, stop.y);
    page?.close();
  });

  it('selects, persists, schedules, and stops the buffered provider without retaining audio', async () => {
    const existingStop = await visibleAriaTarget(page, 'Stop reading aloud');
    if (existingStop) {
      await page.tap(existingStop.x, existingStop.y);
      await waitFor(
        async () => (!(await visibleAriaTarget(page, 'Stop reading aloud')) ? true : null),
        {
          label: 'existing TTS session stopped',
        },
      );
    }

    // A real touch gesture is required to unlock WebAudio. Do not replace this
    // with element.click() or an app-bus dispatch: those do not carry browser
    // user activation.
    await revealReaderChrome(page);
    await tapAria(page, 'Speak');
    await waitFor(() => visibleAriaTarget(page, 'Open Read Aloud player'), {
      timeoutMs: 60_000,
      label: 'Read Aloud mini player',
    });

    // The mini player appears before client initialization finishes. Retry the
    // real tap until the supported player sheet exposes its Voice control.
    await waitFor(
      async () => {
        const open = await visibleAriaTarget(page, 'Open Read Aloud player');
        if (!open) return null;
        await page.tap(open.x, open.y);
        await new Promise((resolve) => setTimeout(resolve, 250));
        return (await visibleAriaTarget(page, 'Voice', '#tts_player_sheet')) ? true : null;
      },
      { timeoutMs: 60_000, intervalMs: 500, label: 'initialized Read Aloud player sheet' },
    );
    await tapAria(page, 'Voice', '#tts_player_sheet');
    const bufferedVoice = await waitFor(() => findBufferedVoiceTarget(page), {
      timeoutMs: 30_000,
      label: 'enabled buffered Android voice',
    });

    page.clearRuntimeEvents();
    // Selecting a voice is the supported UI path into TTSController.setVoice;
    // the same real gesture also owns the ensuing stop -> switch -> start.
    await page.tap(bufferedVoice.x, bufferedVoice.y);

    const persisted = await waitFor(
      () =>
        page.evaluate<{ client: string; voice: string } | null>(`
          const raw = localStorage.getItem('ttsPreferredVoices');
          if (!raw) return null;
          const values = JSON.parse(raw);
          const voice = Object.entries(values).find(
            ([key, value]) => key.startsWith('${BUFFERED_PROVIDER}-') &&
              typeof value === 'string' && value.startsWith('${BUFFERED_VOICE_PREFIX}'),
          )?.[1];
          return values.preferredClient === '${BUFFERED_PROVIDER}' && voice
            ? { client: values.preferredClient, voice }
            : null;
        `),
      { timeoutMs: 30_000, label: 'persisted buffered provider preference' },
    );
    expect(persisted.client).toBe(BUFFERED_PROVIDER);
    expect(persisted.voice.startsWith(BUFFERED_VOICE_PREFIX)).toBe(true);

    const runtimeEvidence = await waitFor(
      async () => {
        const entries = page.getConsoleEntries();
        const android = parseStructuredEvents(entries, ANDROID_EVENT_PREFIX);
        const scheduled = parseStructuredEvents(entries, WEB_AUDIO_EVENT_PREFIX).filter(
          ({ payload }) => payload.event === 'scheduled',
        );
        const composite = parseStructuredEvents(entries, COMPOSITE_EVENT_PREFIX).find(
          ({ payload }) =>
            payload.event === 'scheduled' && typeof payload.marks === 'number' && payload.marks > 1,
        );
        if (!composite) return null;

        for (const web of scheduled.filter(({ index }) => index < composite.index).reverse()) {
          const bridge = android
            .filter(
              ({ index, payload }) => index < web.index && payload.event === 'bridge-completed',
            )
            .at(-1);
          if (!bridge) continue;
          const requestId = bridge.payload.requestId;
          const sessionId = bridge.payload.sessionId;
          const synthesisGeneration = bridge.payload.generation;
          const file = android.find(
            ({ index, payload }) =>
              index < bridge.index &&
              payload.event === 'file-ready' &&
              payload.requestId === requestId &&
              payload.sessionId === sessionId &&
              payload.generation === synthesisGeneration,
          );
          const start = android.find(
            ({ index, payload }) =>
              index < (file?.index ?? -1) &&
              payload.event === 'native-start' &&
              payload.requestId === requestId &&
              payload.sessionId === sessionId &&
              payload.generation === synthesisGeneration,
          );
          if (!start || !file) continue;
          // WebAudio has its own playout-generation counter. The bridge does
          // not currently copy the provider request ID into scheduleChunk, so
          // correlate the real pipeline by strict event order: the closest
          // completed bridge before this schedule, with no newer native start
          // interposed, must be the audio admission that produced it.
          const interposedStart = android.some(
            ({ index, payload }) =>
              index > bridge.index && index < web.index && payload.event === 'native-start',
          );
          if (interposedStart) continue;
          const physicalSchedules = scheduled.filter(
            ({ index }) => index > bridge.index && index < composite.index,
          );
          if (physicalSchedules.length !== 1) continue;
          return { start, file, bridge, web, composite, physicalSchedules };
        }
        return null;
      },
      { timeoutMs: 120_000, intervalMs: 250, label: 'correlated buffered synthesis pipeline' },
    );

    expect(runtimeEvidence.start.index).toBeLessThan(runtimeEvidence.file.index);
    expect(runtimeEvidence.file.index).toBeLessThan(runtimeEvidence.bridge.index);
    expect(runtimeEvidence.bridge.index).toBeLessThan(runtimeEvidence.web.index);
    expect(runtimeEvidence.start.payload.generation).toBe(
      runtimeEvidence.bridge.payload.generation,
    );
    expect(typeof runtimeEvidence.web.payload.generation).toBe('number');

    expect(runtimeEvidence.composite.payload.event).toBe('scheduled');
    expect(runtimeEvidence.composite.payload.marks).toEqual(expect.any(Number));
    expect(Number(runtimeEvidence.composite.payload.marks)).toBeGreaterThan(1);
    expect(runtimeEvidence.physicalSchedules).toHaveLength(1);
    console.info(
      `[test:android] buffered synthesis outcome: composite ` +
        `(${String(runtimeEvidence.composite.payload.marks)} logical marks, 1 WebAudio chunk)`,
    );

    await tapAria(page, 'Close', '#tts_player_sheet');
    const stop = await waitFor(() => visibleAriaTarget(page, 'Stop reading aloud'), {
      label: 'buffered mini-player Stop control',
    });
    const beforeStopEntryCount = page.getConsoleEntries().length;
    await page.tap(stop.x, stop.y);

    const finalMetrics = await waitFor(
      async () => {
        const entries = page.getConsoleEntries().slice(beforeStopEntryCount);
        return (
          parseStructuredEvents(entries, METRICS_EVENT_PREFIX)
            .map(({ payload }) => payload)
            .find((payload) => payload.client === BUFFERED_PROVIDER && payload.reason === 'stop') ??
          null
        );
      },
      { timeoutMs: 30_000, label: 'buffered Stop metrics' },
    );
    const playback = finalMetrics.playback as StructuredPayload | undefined;
    const composite = finalMetrics.composite as StructuredPayload | undefined;
    expect(Number(composite?.compositesScheduled)).toBeGreaterThan(0);
    expect(composite?.fallbackSessions).toBe(0);
    expect(playback?.currentBufferAheadMs).toBe(0);
    expect(playback?.retainedChunks).toBe(0);
    const unexpectedExceptions = page
      .getExceptions()
      .filter(({ description }) => !description.includes('ResizeObserver loop completed'));
    expect(unexpectedExceptions).toEqual([]);
  }, 240_000);
});
