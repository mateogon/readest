import { describe, expect, test } from 'vitest';

import {
  DEFAULT_TTS_COMPOSITE_POLICY,
  planTTSCompositeBatches,
  type TTSCompositeBatch,
  type TTSCompositeUnit,
} from '@/services/tts/ttsComposite';

const unit = (
  text: string,
  overrides: Partial<Omit<TTSCompositeUnit, 'mark'>> & {
    mark?: Partial<TTSCompositeUnit['mark']>;
  } = {},
): TTSCompositeUnit => {
  const { mark, ...unitOverrides } = overrides;
  return {
    blockOffset: 0,
    mark: {
      offset: 0,
      name: 'sentence-0',
      text,
      language: 'en',
      ...mark,
    },
    lang: 'en-US',
    voice: 'voice-a',
    pitch: 1,
    generation: 7,
    estimatedDurationSec: 1,
    transitionFromPrevious: null,
    ...unitOverrides,
  };
};

const source = async function* (units: TTSCompositeUnit[]): AsyncGenerator<TTSCompositeUnit> {
  yield* units;
};

const collect = async (units: AsyncIterable<TTSCompositeUnit>): Promise<TTSCompositeBatch[]> => {
  const batches: TTSCompositeBatch[] = [];
  for await (const batch of planTTSCompositeBatches(units)) batches.push(batch);
  return batches;
};

const assertExactSpans = (batch: TTSCompositeBatch): void => {
  for (const logicalUnit of batch.logicalUnits) {
    expect(batch.request.text.slice(logicalUnit.textStart, logicalUnit.textEnd)).toBe(
      logicalUnit.mark.text,
    );
  }
};

describe('planTTSCompositeBatches', () => {
  test('exports the conservative measured policy', () => {
    expect(DEFAULT_TTS_COMPOSITE_POLICY).toEqual({
      startupTargetChars: 60,
      steadyTargetChars: 150,
      targetDurationSec: 8,
      maxChars: 200,
      maxDurationSec: 15,
      maxUnits: 32,
    });
  });

  test('uses the startup character target once, then the steady target', async () => {
    const batches = await collect(
      source([
        unit('a'.repeat(30)),
        unit('b'.repeat(29), { mark: { name: 'sentence-1' } }),
        unit('c'.repeat(50), { mark: { name: 'sentence-2' } }),
        unit('d'.repeat(49), { mark: { name: 'sentence-3' } }),
        unit('e'.repeat(49), { mark: { name: 'sentence-4' } }),
      ]),
    );

    expect(batches.map((batch) => batch.request.text.length)).toEqual([60, 150]);
    expect(batches.map((batch) => batch.logicalUnits.length)).toEqual([2, 3]);
  });

  test('closes a batch at the estimated duration target', async () => {
    const batches = await collect(
      source([
        unit('First', { estimatedDurationSec: 4 }),
        unit('second', { estimatedDurationSec: 4, mark: { name: 'sentence-1' } }),
        unit('third', { estimatedDurationSec: 1, mark: { name: 'sentence-2' } }),
      ]),
    );

    expect(batches.map((batch) => batch.logicalUnits.length)).toEqual([2, 1]);
    expect(batches[0]?.estimatedDurationSec).toBe(8);
  });

  test('does not add a unit that would cross either hard cap', async () => {
    const batches = await collect(
      source([
        unit('s'.repeat(60), { estimatedDurationSec: 1 }),
        unit('a'.repeat(120), { estimatedDurationSec: 10, mark: { name: 'sentence-1' } }),
        unit('b'.repeat(81), { estimatedDurationSec: 1, mark: { name: 'sentence-2' } }),
        unit('c'.repeat(20), { estimatedDurationSec: 10, mark: { name: 'sentence-3' } }),
        unit('d'.repeat(20), { estimatedDurationSec: 6, mark: { name: 'sentence-4' } }),
      ]),
    );

    expect(batches.map((batch) => batch.logicalUnits.length)).toEqual([1, 1, 2, 1]);
    expect(batches[1]?.request.text.length).toBe(120);
    expect(batches[2]?.estimatedDurationSec).toBe(11);
  });

  test('keeps an oversized logical unit whole and alone', async () => {
    const oversized = 'x'.repeat(DEFAULT_TTS_COMPOSITE_POLICY.maxChars + 1);
    const batches = await collect(
      source([
        unit(oversized, { estimatedDurationSec: 20 }),
        unit('next', { mark: { name: 'sentence-1' } }),
      ]),
    );

    expect(batches).toHaveLength(2);
    expect(batches[0]?.request.text).toBe(oversized);
    expect(batches[0]?.logicalUnits).toHaveLength(1);
  });

  test.each([
    ['lang', { lang: 'es-ES' }],
    ['voice', { voice: 'voice-b' }],
    ['pitch', { pitch: 1.1 }],
    ['generation', { generation: 8 }],
  ] as const)('does not group across a %s change', async (_key, changed) => {
    const batches = await collect(
      source([unit('first'), unit('second', { ...changed, mark: { name: 'sentence-1' } })]),
    );

    expect(batches.map((batch) => batch.logicalUnits.length)).toEqual([1, 1]);
  });

  test('groups equivalent locale spellings under a canonical request language', async () => {
    const batches = await collect(
      source([
        unit('first', { lang: 'en_US' }),
        unit('second', { lang: 'en-US', mark: { name: 'sentence-1' } }),
      ]),
    );

    expect(batches).toHaveLength(1);
    expect(batches[0]?.request.lang).toBe('en-US');
    expect(batches[0]?.logicalUnits).toHaveLength(2);
  });

  test('preserves punctuation and uses paragraph or sentence separators deliberately', async () => {
    const batches = await collect(
      source([
        unit('Hola,'),
        unit('mundo.', { mark: { name: 'sentence-1' } }),
        unit(' —Sí.', { mark: { name: 'sentence-2' } }),
        unit('Nuevo párrafo.', {
          blockOffset: 1,
          transitionFromPrevious: 'paragraph',
          mark: { name: 'sentence-0' },
        }),
        unit('Cambio de bloque.', {
          blockOffset: 2,
          transitionFromPrevious: null,
          mark: { name: 'sentence-0' },
        }),
      ]),
    );

    expect(batches).toHaveLength(1);
    expect(batches[0]?.request.text).toBe(
      'Hola, mundo. —Sí.\n\nNuevo párrafo.\n\nCambio de bloque.',
    );
    assertExactSpans(batches[0]!);
  });

  test('tracks repeated mark names by block and exact UTF-16 spans', async () => {
    const batches = await collect(
      source([
        unit('😀'),
        unit('cafe\u{301}', {
          blockOffset: 1,
          transitionFromPrevious: 'paragraph',
          mark: { name: 'sentence-0', language: 'es' },
        }),
      ]),
    );
    const batch = batches[0]!;

    expect(batch.logicalUnits.map(({ blockOffset, mark }) => [blockOffset, mark.name])).toEqual([
      [0, 'sentence-0'],
      [1, 'sentence-0'],
    ]);
    expect(batch.request.text).toBe('😀\n\ncafe\u{301}');
    expect(batch.logicalUnits.map(({ textStart, textEnd }) => [textStart, textEnd])).toEqual([
      [0, 2],
      [4, 9],
    ]);
    assertExactSpans(batch);
  });

  test('reports the single lookahead transition and null at EOF', async () => {
    const batches = await collect(
      source([
        unit('a'.repeat(60)),
        unit('Next paragraph', {
          blockOffset: 1,
          transitionFromPrevious: 'paragraph',
          mark: { name: 'sentence-0' },
        }),
      ]),
    );

    expect(batches[0]?.transitionAfter).toBe('paragraph');
    expect(batches[1]?.transitionAfter).toBeNull();
  });

  test('distinguishes a same-block sentence lookahead from EOF', async () => {
    const batches = await collect(
      source([unit('a'.repeat(60)), unit('Next sentence', { mark: { name: 'sentence-1' } })]),
    );

    expect(batches[0]?.transitionAfter).toBe('sentence');
    expect(batches[1]?.transitionAfter).toBeNull();
  });

  test('does not cross a chapter boundary', async () => {
    const batches = await collect(
      source([
        unit('End of chapter'),
        unit('Start of chapter', {
          blockOffset: 0,
          transitionFromPrevious: 'chapter',
          mark: { name: 'sentence-0' },
        }),
      ]),
    );

    expect(batches.map((batch) => batch.logicalUnits.length)).toEqual([1, 1]);
    expect(batches[0]?.transitionAfter).toBe('chapter');
  });

  test('pulls at most the current maxUnits batch plus one unit from a long chapter', async () => {
    let pulls = 0;
    const longChapter = async function* (): AsyncGenerator<TTSCompositeUnit> {
      for (let index = 0; index < 10_000; index += 1) {
        pulls += 1;
        yield unit('x', {
          estimatedDurationSec: 0.01,
          mark: { name: `sentence-${index}` },
        });
      }
    };
    const batches = planTTSCompositeBatches(longChapter(), {
      ...DEFAULT_TTS_COMPOSITE_POLICY,
      startupTargetChars: DEFAULT_TTS_COMPOSITE_POLICY.maxChars,
      steadyTargetChars: DEFAULT_TTS_COMPOSITE_POLICY.maxChars,
      targetDurationSec: DEFAULT_TTS_COMPOSITE_POLICY.maxDurationSec,
    });

    const first = await batches.next();

    expect(first.done).toBe(false);
    expect(first.value.logicalUnits).toHaveLength(DEFAULT_TTS_COMPOSITE_POLICY.maxUnits);
    expect(pulls).toBe(DEFAULT_TTS_COMPOSITE_POLICY.maxUnits + 1);
    await batches.return(undefined);
  });
});
