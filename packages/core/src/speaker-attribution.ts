import { compare, fromTime, type SelectionRange } from "@yap/composition";
import { z } from "zod";

const speakerCorrectionValueSchema = z.union([
  z.strictObject({
    state: z.literal("attributed"),
    slot: z.int().nonnegative(),
    displayName: z.string().min(1).optional(),
  }),
  z.strictObject({
    state: z.literal("overlap"),
    slots: z.array(z.int().nonnegative()).min(2).max(8),
  }),
  z.strictObject({ state: z.literal("unknown") }),
]);
export const speakerCorrectionSchema = z.strictObject({
  id: z.string().min(1),
  occurrenceId: z.string().min(1),
  target: z.union([
    z.strictObject({ wordIds: z.array(z.string().min(1)).min(1).max(10000) }),
    z.strictObject({
      range: z.strictObject({
        startUs: z.number().int().nonnegative(),
        endUs: z.number().int().nonnegative(),
      }),
    }),
  ]),
  value: speakerCorrectionValueSchema,
  provenance: z.string().min(1).max(4096),
});

export type SpeakerTurn = {
  slot: number;
  sourceRange: SelectionRange;
};

export type SpeakerAttribution =
  | {
      state: "attributed";
      slot: number;
      displayName?: string;
      correction?: SpeakerCorrectionEvidence;
    }
  | { state: "overlap"; slots: number[]; correction?: SpeakerCorrectionEvidence }
  | { state: "unknown"; correction?: SpeakerCorrectionEvidence };

export type SpeakerCorrectionValue = z.infer<typeof speakerCorrectionValueSchema>;

export type SpeakerCorrection = z.infer<typeof speakerCorrectionSchema>;

export type SpeakerCorrectionEvidence = {
  id: string;
  provenance: string;
  base: SpeakerCorrectionValue;
};

export type AttributableTranscriptWord = {
  id: string;
  sourceRange: SelectionRange;
};

export type SpeakerAttributionOptions = {
  labels?: ReadonlyMap<number, string>;
};

/**
 * Join transcript words to retained acoustic turns without guessing.
 * A word is attributable only when one turn wholly covers its source range and
 * no other speaker intersects it. A competing partial turn is overlap evidence,
 * even when that competitor does not cover the complete word.
 * Crossing a turn boundary, falling in an observation gap, or meeting multiple
 * turns stays explicit as unknown/overlap evidence.
 */
export function attributeTranscriptWords<T extends AttributableTranscriptWord>(
  words: readonly T[],
  turns: readonly SpeakerTurn[],
  options: SpeakerAttributionOptions = {},
): (T & { speaker: SpeakerAttribution })[] {
  return words.map((word) => {
    const covered = turns.some((turn) => whollyCovered(word.sourceRange, turn.sourceRange));
    const matches = (covered ? turns : [])
      .filter((turn) => intersects(word.sourceRange, turn.sourceRange))
      .map((turn) => turn.slot)
      .filter((slot, index, slots) => slots.indexOf(slot) === index)
      .sort((a, b) => a - b);
    const speaker: SpeakerAttribution =
      matches.length === 1
        ? {
            state: "attributed",
            slot: matches[0]!,
            ...(options.labels?.has(matches[0]!)
              ? { displayName: options.labels.get(matches[0]!)! }
              : {}),
          }
        : matches.length > 1
          ? { state: "overlap", slots: matches }
          : { state: "unknown" };
    return { ...word, speaker };
  });
}

/** Apply caller-authored corrections to exact word identities/ranges only. */
export function applySpeakerCorrections<
  T extends AttributableTranscriptWord & { speaker: SpeakerAttribution },
>(rows: readonly T[], occurrenceId: string, corrections: readonly SpeakerCorrection[]): T[] {
  return rows.map((row) => {
    const matches = corrections.filter(
      (correction) =>
        correction.occurrenceId === occurrenceId &&
        ("wordIds" in correction.target
          ? correction.target.wordIds.includes(row.id)
          : compare(fromTime(row.sourceRange.startUs), fromTime(correction.target.range.startUs)) >=
              0 &&
            compare(fromTime(row.sourceRange.endUs), fromTime(correction.target.range.endUs)) <= 0),
    );
    const correction = matches.at(-1);
    if (!correction) return row;
    const base: SpeakerCorrectionValue =
      row.speaker.state === "attributed"
        ? {
            state: "attributed",
            slot: row.speaker.slot,
            ...(row.speaker.displayName === undefined
              ? {}
              : { displayName: row.speaker.displayName }),
          }
        : row.speaker.state === "overlap"
          ? { state: "overlap", slots: [...row.speaker.slots] }
          : { state: "unknown" };
    return {
      ...row,
      speaker: {
        ...correction.value,
        correction: { id: correction.id, provenance: correction.provenance, base },
      },
    } as T;
  });
}

function intersects(word: SelectionRange, turn: SelectionRange): boolean {
  const wordStart = fromTime(word.startUs);
  const wordEnd = fromTime(word.endUs);
  const turnStart = fromTime(turn.startUs);
  const turnEnd = fromTime(turn.endUs);
  return compare(wordStart, wordEnd) === 0
    ? compare(turnStart, wordStart) <= 0 && compare(wordStart, turnEnd) < 0
    : compare(turnStart, wordEnd) < 0 && compare(wordStart, turnEnd) < 0;
}

function whollyCovered(word: SelectionRange, turn: SelectionRange): boolean {
  const wordStart = fromTime(word.startUs);
  const wordEnd = fromTime(word.endUs);
  const turnStart = fromTime(turn.startUs);
  const turnEnd = fromTime(turn.endUs);
  return compare(wordStart, wordEnd) === 0
    ? compare(turnStart, wordStart) <= 0 && compare(wordStart, turnEnd) < 0
    : compare(turnStart, wordStart) <= 0 && compare(wordEnd, turnEnd) <= 0;
}
