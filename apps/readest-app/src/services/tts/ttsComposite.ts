import { normalizeSynthesisLocale, type SpeechSynthesisRequest } from './providers/types';
import type { TTSMark, TTSPlaybackTransition } from './types';

export interface TTSCompositePolicy {
  startupTargetChars: number;
  steadyTargetChars: number;
  targetDurationSec: number;
  maxChars: number;
  maxDurationSec: number;
  maxUnits: number;
}

export const DEFAULT_TTS_COMPOSITE_POLICY = {
  startupTargetChars: 60,
  steadyTargetChars: 150,
  targetDurationSec: 8,
  maxChars: 200,
  maxDurationSec: 15,
  maxUnits: 32,
} as const satisfies TTSCompositePolicy;

export interface TTSCompositeUnit {
  blockOffset: number;
  mark: TTSMark;
  lang: string;
  voice: string;
  pitch: number;
  generation: number;
  estimatedDurationSec: number;
  transitionFromPrevious: TTSPlaybackTransition;
}

export interface TTSCompositeLogicalUnit {
  blockOffset: number;
  mark: TTSMark;
  estimatedDurationSec: number;
  transitionFromPrevious: TTSPlaybackTransition;
  textStart: number;
  textEnd: number;
}

export type TTSCompositeTransition = 'sentence' | TTSPlaybackTransition;

export interface TTSCompositeBatch {
  request: SpeechSynthesisRequest;
  generation: number;
  estimatedDurationSec: number;
  logicalUnits: TTSCompositeLogicalUnit[];
  transitionAfter: TTSCompositeTransition;
}

interface CompositeBatchBuilder extends Omit<TTSCompositeBatch, 'transitionAfter'> {}

const hasSameIdentity = (batch: CompositeBatchBuilder, unit: TTSCompositeUnit): boolean =>
  batch.request.lang === normalizeSynthesisLocale(unit.lang) &&
  batch.request.voice === unit.voice &&
  batch.request.pitch === unit.pitch &&
  batch.generation === unit.generation;

const separatorBefore = (previous: TTSCompositeLogicalUnit, next: TTSCompositeUnit): string => {
  if (previous.blockOffset !== next.blockOffset || next.transitionFromPrevious === 'paragraph') {
    return '\n\n';
  }

  if (!previous.mark.text || !next.mark.text) return '';
  return /\s$/u.test(previous.mark.text) || /^\s/u.test(next.mark.text) ? '' : ' ';
};

const transitionBefore = (
  previous: TTSCompositeLogicalUnit,
  next: TTSCompositeUnit,
): Exclude<TTSCompositeTransition, null> => {
  if (next.transitionFromPrevious === 'chapter') return 'chapter';
  if (next.transitionFromPrevious === 'paragraph' || previous.blockOffset !== next.blockOffset) {
    return 'paragraph';
  }
  return 'sentence';
};

const startBatch = (unit: TTSCompositeUnit): CompositeBatchBuilder => ({
  request: {
    lang: normalizeSynthesisLocale(unit.lang),
    text: unit.mark.text,
    voice: unit.voice,
    pitch: unit.pitch,
  },
  generation: unit.generation,
  estimatedDurationSec: unit.estimatedDurationSec,
  logicalUnits: [
    {
      blockOffset: unit.blockOffset,
      mark: unit.mark,
      estimatedDurationSec: unit.estimatedDurationSec,
      transitionFromPrevious: unit.transitionFromPrevious,
      textStart: 0,
      textEnd: unit.mark.text.length,
    },
  ],
});

const appendUnit = (
  batch: CompositeBatchBuilder,
  unit: TTSCompositeUnit,
  separator: string,
): void => {
  const textStart = batch.request.text.length + separator.length;
  batch.request.text += separator + unit.mark.text;
  batch.estimatedDurationSec += unit.estimatedDurationSec;
  batch.logicalUnits.push({
    blockOffset: unit.blockOffset,
    mark: unit.mark,
    estimatedDurationSec: unit.estimatedDurationSec,
    transitionFromPrevious: unit.transitionFromPrevious,
    textStart,
    textEnd: textStart + unit.mark.text.length,
  });
};

const reachedTarget = (
  batch: CompositeBatchBuilder,
  policy: TTSCompositePolicy,
  batchIndex: number,
): boolean => {
  const targetChars = batchIndex === 0 ? policy.startupTargetChars : policy.steadyTargetChars;
  return (
    batch.request.text.length >= targetChars ||
    batch.estimatedDurationSec >= policy.targetDurationSec ||
    batch.logicalUnits.length >= policy.maxUnits
  );
};

const canAppend = (
  batch: CompositeBatchBuilder,
  unit: TTSCompositeUnit,
  separator: string,
  policy: TTSCompositePolicy,
): boolean =>
  unit.transitionFromPrevious !== 'chapter' &&
  hasSameIdentity(batch, unit) &&
  batch.logicalUnits.length < policy.maxUnits &&
  batch.request.text.length + separator.length + unit.mark.text.length <= policy.maxChars &&
  batch.estimatedDurationSec + unit.estimatedDurationSec <= policy.maxDurationSec;

// Streams bounded batches from a document cursor. The planner retains at most
// one unit beyond the current batch, which is enough to expose transitionAfter
// without materializing a chapter or creating another scheduler.
export async function* planTTSCompositeBatches(
  units: AsyncIterable<TTSCompositeUnit>,
  policy: TTSCompositePolicy = DEFAULT_TTS_COMPOSITE_POLICY,
): AsyncGenerator<TTSCompositeBatch> {
  const iterator = units[Symbol.asyncIterator]();
  let lookahead: TTSCompositeUnit | undefined;
  let exhausted = false;
  let batchIndex = 0;

  try {
    while (!exhausted || lookahead) {
      let first = lookahead;
      lookahead = undefined;
      if (!first) {
        const next = await iterator.next();
        if (next.done) return;
        first = next.value;
      }

      const batch = startBatch(first);
      while (true) {
        const next = await iterator.next();
        if (next.done) {
          exhausted = true;
          yield { ...batch, transitionAfter: null };
          break;
        }

        lookahead = next.value;
        if (reachedTarget(batch, policy, batchIndex)) {
          yield {
            ...batch,
            transitionAfter: transitionBefore(batch.logicalUnits.at(-1)!, lookahead),
          };
          break;
        }

        const separator = separatorBefore(batch.logicalUnits.at(-1)!, lookahead);
        if (!canAppend(batch, lookahead, separator, policy)) {
          yield {
            ...batch,
            transitionAfter: transitionBefore(batch.logicalUnits.at(-1)!, lookahead),
          };
          break;
        }

        appendUnit(batch, lookahead, separator);
        lookahead = undefined;
      }
      batchIndex += 1;
    }
  } finally {
    await iterator.return?.();
  }
}
