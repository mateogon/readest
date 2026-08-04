import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adbShell } from './helpers/adb';
import { type CdpPage } from './helpers/cdp';
import { APP_PKG, detectAndroidEnv, openFixtureBook } from './helpers/reader';

const FIXTURE = path.resolve(__dirname, '../fixtures/data/sample-alice.epub');
const enabled = process.env['READEST_ANDROID_BUFFERED_DIALOGUE_PROBE'] === '1';
const androidEnv = enabled ? await detectAndroidEnv() : null;

interface ProbeBoundary {
  offset: number;
  duration: number;
  text: string;
  textStart: number;
  textEnd: number;
}

interface ProbeResult {
  text: string;
  durationSec: number;
  trimStartSec: number;
  boundaries: ProbeBoundary[];
}

describe.runIf(enabled)('Android buffered dialogue boundary probe', () => {
  let page: CdpPage;

  beforeAll(async () => {
    if (!androidEnv) throw new Error(`Android dialogue probe prerequisites missing for ${APP_PKG}`);
    page = await openFixtureBook(FIXTURE);
  }, 60_000);

  afterAll(async () => {
    page?.close();
    await adbShell(`am force-stop ${APP_PKG}`);
  });

  it('maps the real Android ranges for the dialogue batch that fell back in the soak', async () => {
    const units = [
      '“Ah! ',
      'that accounts for it,” said the Hatter. “He wo’n’t stand beating. ',
      'Now, if you only kept on good terms with him, he’d do almost anything you liked with the clock. ',
    ];
    const text = units.join('');
    expect(text.length).toBe(167);

    const result = await page.evaluate<ProbeResult>(`
      const invoke = window.__TAURI_INTERNALS__?.invoke;
      if (!invoke) throw new Error('Tauri invoke is unavailable');
      const init = await invoke('plugin:native-tts|init');
      if (!init?.success || !init.enginePackage) throw new Error('Android TTS init failed');
      const voiceResponse = await invoke('plugin:native-tts|get_all_voices');
      const voice = voiceResponse.voices.find((candidate) =>
        String(candidate.lang ?? candidate.language ?? '').toLowerCase().startsWith('en')
      );
      if (!voice?.id) throw new Error('No English Android TTS voice');
      const payload = {
        text: ${JSON.stringify(text)},
        enginePackage: init.enginePackage,
        voice: voice.id,
        locale: 'en-US',
        pitch: 1,
        rate: 1,
        sessionId: 'dialogue-probe',
        requestId: 'dialogue-probe-1',
        generation: 0,
      };
      const metadata = await invoke('plugin:native-tts|synthesize_to_file', { payload });
      const audio = await invoke('plugin:native-tts|read_synthesis_audio', {
        payload: { assetId: metadata.assetId },
      });
      const context = new AudioContext();
      const decoded = await context.decodeAudioData(audio.slice(0));
      const samples = decoded.getChannelData(0);
      let first = samples.findIndex((sample) => Math.abs(sample) > 0.005);
      if (first < 0) first = 0;
      const trimStartSec = Math.max(0, first / decoded.sampleRate - 0.02);
      await context.close();
      return {
        text: payload.text,
        durationSec: metadata.durationSec,
        trimStartSec,
        boundaries: metadata.boundaries,
      };
    `);

    const spans: Array<[number, number]> = [];
    let cursor = 0;
    for (const unit of units) {
      spans.push([cursor, cursor + unit.length]);
      cursor += unit.length;
    }
    const mapped = units.map(() => [] as ProbeBoundary[]);
    for (const boundary of result.boundaries) {
      expect(result.text.slice(boundary.textStart, boundary.textEnd)).toBe(boundary.text);
      const unitIndex = spans.findIndex(
        ([start, end]) => boundary.textStart >= start && boundary.textEnd <= end,
      );
      expect(unitIndex, JSON.stringify(boundary)).toBeGreaterThanOrEqual(0);
      mapped[unitIndex]!.push(boundary);
    }
    console.info(
      `[test:android] dialogue probe ${JSON.stringify({
        durationSec: result.durationSec,
        trimStartSec: result.trimStartSec,
        boundaryCount: result.boundaries.length,
        spans,
        mappedCounts: mapped.map((boundaries) => boundaries.length),
      })}`,
    );
    expect(mapped.map((boundaries) => boundaries.length)).toEqual([1, 11, 19]);
    expect(result.trimStartSec).toBeLessThan(result.boundaries[1]!.offset / 10_000_000);
  }, 60_000);
});
