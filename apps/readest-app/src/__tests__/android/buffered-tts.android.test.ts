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
  chars?: unknown;
  requestId?: unknown;
  sessionId?: unknown;
  generation?: unknown;
  client?: unknown;
  reason?: unknown;
  playback?: unknown;
  composite?: unknown;
  compositesScheduled?: unknown;
  fallbackSessions?: unknown;
  logicalMarksStarted?: unknown;
  misses?: unknown;
  attempts?: unknown;
  regenerations?: unknown;
  retries?: unknown;
  sentenceGaps?: unknown;
  paragraphGaps?: unknown;
  chapterGaps?: unknown;
  coldStartGaps?: unknown;
  transitions?: unknown;
  gapsOver500Ms?: unknown;
  unplannedGapMsP50?: unknown;
  unplannedGapMsP95?: unknown;
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
const backgroundE2E = process.env['READEST_ANDROID_BUFFERED_BACKGROUND_E2E'] === '1';
const soakE2E = process.env['READEST_ANDROID_BUFFERED_SOAK_E2E'] === '1';
const dialogueE2E = process.env['READEST_ANDROID_BUFFERED_DIALOGUE_E2E'] === '1';
const lifecycleE2E = process.env['READEST_ANDROID_BUFFERED_LIFECYCLE_E2E'] === '1';
const androidEnv = bufferedE2E ? await detectAndroidEnv() : null;
const SOAK_DURATION_MS = 30 * 60 * 1000;
const SOAK_POLL_MS = 60 * 1000;
const BUFFERED_TEST_TIMEOUT_MS = soakE2E
  ? SOAK_DURATION_MS + 5 * 60 * 1000
  : dialogueE2E
    ? 360_000
    : 240_000;

const getWakefulness = async (): Promise<string | null> => {
  const output = await adbShell('dumpsys power');
  return output.match(/mWakefulness=(\w+)/)?.[1] ?? null;
};

const wakeAndUnlock = async (): Promise<void> => {
  await adbShell('input keyevent KEYCODE_WAKEUP');
  await adbShell('wm dismiss-keyguard');
  await waitFor(async () => ((await getWakefulness()) === 'Awake' ? true : null), {
    timeoutMs: 15_000,
    label: 'awake Android emulator',
  });
};

const selectSpeed = async (page: CdpPage, rate: number): Promise<void> => {
  await tapAria(page, 'Speed', '#tts_player_sheet');
  await waitFor(
    () =>
      page.evaluate<boolean>(`
        return !!document.querySelector('#tts_player_sheet input[aria-label="Speed"]');
      `),
    { label: 'Speed slider' },
  );
  await page.evaluate<void>(`
    const slider = document.querySelector('#tts_player_sheet input[aria-label="Speed"]');
    if (!(slider instanceof HTMLInputElement)) throw new Error('Speed slider not found');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('Native input value setter unavailable');
    setter.call(slider, ${JSON.stringify(String(rate))});
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    slider.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  `);
  await waitFor(
    () =>
      page.evaluate<boolean>(`
        const slider = document.querySelector('#tts_player_sheet input[aria-label="Speed"]');
        return slider?.getAttribute('aria-valuetext') === ${JSON.stringify(`${rate}×`)};
      `),
    { label: `${rate.toFixed(1)}x Speed selection` },
  );
  await tapAria(page, 'Go Back', '#tts_player_sheet');
  await waitFor(() => visibleAriaTarget(page, 'Voice', '#tts_player_sheet'), {
    label: 'TTS player main view after Speed selection',
  });
};

const gotoDialogueRegression = async (page: CdpPage): Promise<boolean> => {
  const found = await page.evaluate<boolean>(`
    const view = document.querySelector('foliate-view');
    if (!view?.renderer) return false;
    const target = 'Ah! that accounts for it';
    const content = view.renderer.getContents().find((candidate) =>
      candidate.doc && (candidate.doc.body?.textContent ?? '').includes(target),
    );
    if (!content) return false;
    const block = [...content.doc.querySelectorAll('p')].find((candidate) =>
      (candidate.textContent ?? '').includes(target),
    );
    if (!block) return false;
    const range = content.doc.createRange();
    range.selectNodeContents(block);
    await view.renderer.goTo({ index: content.index, anchor: range });
    return true;
  `);
  if (found) await new Promise((resolve) => setTimeout(resolve, 1000));
  return found;
};

const scheduledWebAudioEvents = (page: CdpPage): StructuredEvent[] =>
  parseStructuredEvents(page.getConsoleEntries(), WEB_AUDIO_EVENT_PREFIX).filter(
    ({ payload }) => payload.event === 'scheduled' && typeof payload.generation === 'number',
  );

const latestWebAudioGeneration = (page: CdpPage): number =>
  Math.max(...scheduledWebAudioEvents(page).map(({ payload }) => Number(payload.generation)));

const waitForNewWebAudioGeneration = (page: CdpPage, previousGeneration: number, label: string) =>
  waitFor(
    async () =>
      scheduledWebAudioEvents(page).find(
        ({ payload }) => Number(payload.generation) > previousGeneration,
      ) ?? null,
    { timeoutMs: 60_000, intervalMs: 250, label },
  );

const assertNoOlderSchedulingAfter = async (
  page: CdpPage,
  event: StructuredEvent,
): Promise<void> => {
  const generation = Number(event.payload.generation);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const stale = scheduledWebAudioEvents(page).filter(
    ({ index, payload }) => index > event.index && Number(payload.generation) < generation,
  );
  expect(stale).toEqual([]);
};

const runLifecycleProbe = async (page: CdpPage): Promise<[number, number, number]> => {
  const initialGeneration = latestWebAudioGeneration(page);

  await tapAria(page, 'Pause', '#tts_player_sheet');
  await waitFor(() => visibleAriaTarget(page, 'Play', '#tts_player_sheet'), {
    label: 'buffered player paused',
  });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(await visibleAriaTarget(page, 'Play', '#tts_player_sheet')).not.toBeNull();

  await tapAria(page, 'Play', '#tts_player_sheet');
  await waitFor(() => visibleAriaTarget(page, 'Pause', '#tts_player_sheet'), {
    label: 'buffered player resumed',
  });

  await tapAria(page, 'Next Sentence', '#tts_player_sheet');
  const forward = await waitForNewWebAudioGeneration(
    page,
    initialGeneration,
    'new WebAudio generation after Next Sentence',
  );
  await assertNoOlderSchedulingAfter(page, forward);
  await waitFor(() => visibleAriaTarget(page, 'Pause', '#tts_player_sheet'), {
    label: 'buffered playback after Next Sentence',
  });

  const forwardGeneration = Number(forward.payload.generation);
  await tapAria(page, 'Previous Sentence', '#tts_player_sheet');
  const backward = await waitForNewWebAudioGeneration(
    page,
    forwardGeneration,
    'new WebAudio generation after Previous Sentence',
  );
  await assertNoOlderSchedulingAfter(page, backward);
  await waitFor(() => visibleAriaTarget(page, 'Pause', '#tts_player_sheet'), {
    label: 'buffered playback after Previous Sentence',
  });

  return [initialGeneration, forwardGeneration, Number(backward.payload.generation)];
};

interface AndroidProcessSample {
  elapsedMs: number;
  appPid: string;
  appTotalPssKb: number | null;
  enginePid: string;
  engineTotalPssKb: number | null;
}

let ttsEnginePackage = '';

const readPackageMemory = async (
  packageName: string,
): Promise<{ pid: string; totalPssKb: number | null }> => {
  const pid = (await adbShell(`pidof ${packageName}`)).trim().split(/\s+/)[0];
  if (!pid) throw new Error(`${packageName} process is not running`);
  const meminfo = await adbShell(`dumpsys meminfo ${packageName}`);
  const totalPss = meminfo.match(/TOTAL PSS:\s*([\d,]+)/)?.[1]?.replaceAll(',', '');
  return { pid, totalPssKb: totalPss === undefined ? null : Number(totalPss) };
};

const readAndroidProcessSample = async (startedAt: number): Promise<AndroidProcessSample> => {
  const [app, engine] = await Promise.all([
    readPackageMemory(APP_PKG),
    readPackageMemory(ttsEnginePackage),
  ]);
  return {
    elapsedMs: Date.now() - startedAt,
    appPid: app.pid,
    appTotalPssKb: app.totalPssKb,
    enginePid: engine.pid,
    engineTotalPssKb: engine.totalPssKb,
  };
};

const runBackgroundSoak = async (startedAt: number): Promise<AndroidProcessSample[]> => {
  const samples = [await readAndroidProcessSample(startedAt)];
  const expectedAppPid = samples[0]!.appPid;
  const expectedEnginePid = samples[0]!.enginePid;
  let lastReportedMinute = 0;
  while (Date.now() - startedAt < SOAK_DURATION_MS) {
    const remainingMs = SOAK_DURATION_MS - (Date.now() - startedAt);
    await new Promise((resolve) => setTimeout(resolve, Math.min(SOAK_POLL_MS, remainingMs)));
    const sample = await readAndroidProcessSample(startedAt);
    if (sample.appPid !== expectedAppPid) {
      throw new Error(`Readest process changed during soak: ${expectedAppPid} -> ${sample.appPid}`);
    }
    if (sample.enginePid !== expectedEnginePid) {
      throw new Error(
        `TTS engine process changed during soak: ${expectedEnginePid} -> ${sample.enginePid}`,
      );
    }
    samples.push(sample);
    const elapsedMinutes = Math.floor(sample.elapsedMs / 60_000);
    if (elapsedMinutes >= lastReportedMinute + 5) {
      lastReportedMinute = elapsedMinutes;
      console.info(
        `[test:android] soak progress: ${String(elapsedMinutes)} min, ` +
          `Readest pid/PSS ${sample.appPid}/${String(sample.appTotalPssKb)} KiB, ` +
          `engine pid/PSS ${sample.enginePid}/${String(sample.engineTotalPssKb)} KiB`,
      );
    }
  }
  return samples;
};

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
    if (
      (backgroundE2E || soakE2E || dialogueE2E || lifecycleE2E) &&
      !androidEnv.serial.startsWith('emulator-')
    ) {
      throw new Error('Buffered extended E2E is restricted to an Android emulator');
    }
    if (soakE2E && !backgroundE2E) {
      throw new Error('Buffered soak E2E requires READEST_ANDROID_BUFFERED_BACKGROUND_E2E=1');
    }
    if (dialogueE2E && !backgroundE2E) {
      throw new Error('Buffered dialogue E2E requires READEST_ANDROID_BUFFERED_BACKGROUND_E2E=1');
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
    ttsEnginePackage = defaultEngine;

    page = await openFixtureBook(FIXTURE);
    const chapterPattern = dialogueE2E ? 'chapter\\s*7' : 'chapter\\s*4';
    const chapterOpened = await waitFor(() => gotoChapter(page, chapterPattern), {
      timeoutMs: 30_000,
      intervalMs: 500,
      label: `stable ${dialogueE2E ? 'Chapter 7' : 'Chapter 4'} navigation`,
    });
    if (!chapterOpened) {
      throw new Error(
        `sample-alice.epub has no ${dialogueE2E ? 'Chapter 7' : 'Chapter 4'} text section`,
      );
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
      { timeoutMs: 30_000, label: `${dialogueE2E ? 'Chapter 7' : 'Chapter 4'} text content` },
    );
    if (dialogueE2E) {
      await waitFor(() => gotoDialogueRegression(page), {
        timeoutMs: 30_000,
        intervalMs: 500,
        label: 'Chapter 7 dialogue regression paragraph',
      });
    }
  }, 120_000);

  afterAll(async () => {
    try {
      if (page) {
        const close = await visibleAriaTarget(page, 'Close', '#tts_player_sheet');
        if (close) await page.tap(close.x, close.y);
        const stop = await visibleAriaTarget(page, 'Stop reading aloud');
        if (stop) await page.tap(stop.x, stop.y);
      }
    } finally {
      if ((backgroundE2E || soakE2E || dialogueE2E) && androidEnv) await wakeAndUnlock();
      page?.close();
      // The package is an isolated debug build. Always terminate it even when
      // a failed assertion leaves the sheet covering Stop, otherwise native
      // synthesis survives CDP teardown and contaminates the next run.
      await adbShell(`am force-stop ${APP_PKG}`);
    }
  });

  it(
    'selects, persists, schedules, and stops the buffered provider without retaining audio',
    async () => {
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

      // This is a dedicated debug package, so seed a deterministic established
      // provider before each run. A prior successful run leaves Buffered
      // preferred; without this reset the test would re-select the active voice
      // instead of exercising a real native -> buffered transition.
      await page.evaluate<void>(`
      localStorage.setItem(
        'ttsPreferredVoices',
        JSON.stringify({ preferredClient: 'native-tts' }),
      );
    `);

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
      if (lifecycleE2E) await selectSpeed(page, 1);
      else if (soakE2E || dialogueE2E) await selectSpeed(page, 1.5);
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
              payload.event === 'scheduled' &&
              typeof payload.marks === 'number' &&
              payload.marks > 1,
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

      if (lifecycleE2E) {
        const generations = await runLifecycleProbe(page);
        expect(generations[1]).toBeGreaterThan(generations[0]);
        expect(generations[2]).toBeGreaterThan(generations[1]);
        console.info(
          `[test:android] lifecycle outcome: pause/resume, next/previous generations ` +
            generations.join(' -> '),
        );
      }

      if (backgroundE2E) {
        const beforeScreenOffEntryCount = page.getConsoleEntries().length;
        try {
          await adbShell('input keyevent KEYCODE_SLEEP');
          await waitFor(async () => ((await getWakefulness()) !== 'Awake' ? true : null), {
            timeoutMs: 15_000,
            label: 'non-awake Android emulator',
          });
          const screenOffStartedAt = Date.now();
          const backgroundEvidence = await waitFor(
            async () => {
              const entries = page.getConsoleEntries();
              const newSchedules = parseStructuredEvents(entries, WEB_AUDIO_EVENT_PREFIX).filter(
                ({ index, payload }) =>
                  index >= beforeScreenOffEntryCount && payload.event === 'scheduled',
              );
              const newComposites = parseStructuredEvents(entries, COMPOSITE_EVENT_PREFIX).filter(
                ({ index, payload }) =>
                  index >= beforeScreenOffEntryCount && payload.event === 'scheduled',
              );
              return newSchedules.length >= 4 && newComposites.length > 0
                ? { newSchedules, newComposites }
                : null;
            },
            {
              timeoutMs: 180_000,
              intervalMs: 500,
              label: 'screen-off WebAudio refill beyond hidden queue headroom',
            },
          );
          expect(backgroundEvidence.newSchedules.length).toBeGreaterThanOrEqual(4);
          expect(backgroundEvidence.newComposites.length).toBeGreaterThan(0);
          console.info(
            `[test:android] screen-off outcome: ${String(backgroundEvidence.newSchedules.length)} ` +
              `new WebAudio chunks, ${String(backgroundEvidence.newComposites.length)} composites`,
          );
          if (dialogueE2E) {
            const dialogueComposite = await waitFor(
              async () =>
                parseStructuredEvents(page.getConsoleEntries(), COMPOSITE_EVENT_PREFIX).find(
                  ({ payload }) =>
                    payload.event === 'scheduled' && payload.marks === 3 && payload.chars === 167,
                ) ?? null,
              {
                timeoutMs: 240_000,
                intervalMs: 500,
                label: 'Chapter 7 short-dialogue composite (3 marks, 167 chars)',
              },
            );
            expect(dialogueComposite.payload.event).toBe('scheduled');
            console.info(
              '[test:android] dialogue regression outcome: 3 marks/167 chars composite scheduled',
            );
          }
          if (soakE2E) {
            const samples = await runBackgroundSoak(screenOffStartedAt);
            const appPssSamples = samples
              .map(({ appTotalPssKb }) => appTotalPssKb)
              .filter((value): value is number => value !== null);
            const enginePssSamples = samples
              .map(({ engineTotalPssKb }) => engineTotalPssKb)
              .filter((value): value is number => value !== null);
            expect(appPssSamples.length).toBe(samples.length);
            expect(enginePssSamples.length).toBe(samples.length);
            console.info(
              `[test:android] soak outcome: ${String(Math.floor(samples.at(-1)!.elapsedMs / 60_000))} ` +
                `min, ${String(samples.length)} samples, Readest pid ${samples[0]!.appPid}, ` +
                `PSS first/min/max/last ${String(appPssSamples[0])}/${String(Math.min(...appPssSamples))}/` +
                `${String(Math.max(...appPssSamples))}/${String(appPssSamples.at(-1))} KiB; ` +
                `engine pid ${samples[0]!.enginePid}, PSS first/min/max/last ` +
                `${String(enginePssSamples[0])}/${String(Math.min(...enginePssSamples))}/` +
                `${String(Math.max(...enginePssSamples))}/${String(enginePssSamples.at(-1))} KiB`,
            );
          }
        } finally {
          await wakeAndUnlock();
        }
      }

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
              .find(
                (payload) => payload.client === BUFFERED_PROVIDER && payload.reason === 'stop',
              ) ?? null
          );
        },
        { timeoutMs: 30_000, label: 'buffered Stop metrics' },
      );
      const playback = finalMetrics.playback as StructuredPayload | undefined;
      const composite = finalMetrics.composite as StructuredPayload | undefined;
      expect(Number(composite?.compositesScheduled)).toBeGreaterThan(0);
      expect(composite?.fallbackSessions).toBe(0);
      if (lifecycleE2E) {
        expect(Number(playback?.['sessionsStarted'])).toBeGreaterThanOrEqual(3);
        expect(finalMetrics.regenerations).toBe(0);
        expect(finalMetrics.retries).toBe(0);
      }
      // Chunk start accounts for the first mark. A second started mark proves
      // that the WebAudio clock crossed a real internal composite boundary;
      // requiring a third made the short lane depend on exactly when Stop won
      // the race after the refill assertion.
      if (backgroundE2E) expect(Number(composite?.logicalMarksStarted)).toBeGreaterThan(1);
      if (soakE2E) {
        expect(Number(composite?.logicalMarksStarted)).toBeGreaterThanOrEqual(500);
        expect(finalMetrics.retries).toBe(0);
        expect(finalMetrics.attempts).toBe(finalMetrics.misses);
        const regenerationsPer100Marks =
          (100 * Number(finalMetrics.regenerations)) / Number(composite?.logicalMarksStarted);
        console.info(
          `[test:android] repeated acoustic requests: ${String(finalMetrics.regenerations)} ` +
            `(${regenerationsPer100Marks.toFixed(2)} per 100 logical marks); ` +
            `streamed playback has one sequential scheduler, so this content-key metric ` +
            `also counts legitimate repeated phrases after ephemeral eviction`,
        );
        // Sentence and paragraph are steady-state transitions. Chapter
        // changes require a new document cursor/session and are reported
        // separately as cold transitions instead of being judged by the
        // steady-state underrun target.
        for (const gaps of [playback?.sentenceGaps, playback?.paragraphGaps] as unknown[]) {
          const diagnostics = gaps as StructuredPayload | undefined;
          if (!diagnostics || Number(diagnostics.transitions) === 0) continue;
          expect(Number(diagnostics.unplannedGapMsP50)).toBeLessThanOrEqual(50);
          expect(Number(diagnostics.unplannedGapMsP95)).toBeLessThanOrEqual(150);
          expect(Number(diagnostics.gapsOver500Ms)).toBe(0);
        }
        console.info(
          `[test:android] cold transition diagnostics: ${JSON.stringify({
            chapter: playback?.chapterGaps,
            refill: playback?.coldStartGaps,
          })}`,
        );
      }
      expect(playback?.currentBufferAheadMs).toBe(0);
      expect(playback?.retainedChunks).toBe(0);
      const unexpectedExceptions = page
        .getExceptions()
        .filter(({ description }) => !description.includes('ResizeObserver loop completed'));
      expect(unexpectedExceptions).toEqual([]);
    },
    BUFFERED_TEST_TIMEOUT_MS,
  );
});
