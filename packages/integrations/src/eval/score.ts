import { READING_FIELDS, type ExtractedBill, type ReadingField } from '../ai/bill-extractor';

/** Hand-labelled truth for one bill in the eval set (same field names as ExtractedBill). */
export type BillLabel = Record<ReadingField, string | number>;

export interface FieldScore {
  field: ReadingField;
  expected: string | number;
  actual: string | number | undefined;
  correct: boolean;
  confidence: number;
}

const norm = (v: string | number | undefined) =>
  typeof v === 'string' ? v.replace(/\s+/g, '').toUpperCase() : v;

/** Exact match after whitespace/case normalisation; numbers within 0.5% (rounding on bills). */
export function scoreBill(label: BillLabel, got: ExtractedBill | null): FieldScore[] {
  return READING_FIELDS.map((field) => {
    const expected = label[field];
    const actual = got?.fields[field] as string | number | undefined;
    let correct: boolean;
    if (typeof expected === 'number') {
      correct =
        typeof actual === 'number' &&
        Math.abs(actual - expected) <= Math.max(0.005 * Math.abs(expected), 1e-9);
    } else {
      correct = norm(actual) === norm(expected);
    }
    return { field, expected, actual, correct, confidence: got?.confidence[field] ?? 0 };
  });
}

export interface EvalSummary {
  bills: number;
  fieldAccuracy: Record<ReadingField, number>;
  overallAccuracy: number;
  /** Of fields at or above the threshold, how many were right (what auto-accept relies on). */
  precisionAboveThreshold: number;
  /** Share of fields at or above the threshold. */
  coverageAboveThreshold: number;
  /** Bills where every field was right and above the threshold. */
  fullyAutomatable: number;
}

export function summarise(scores: FieldScore[][], threshold: number): EvalSummary {
  const flat = scores.flat();
  const fieldAccuracy = Object.fromEntries(
    READING_FIELDS.map((f) => {
      const s = flat.filter((x) => x.field === f);
      return [f, s.length ? s.filter((x) => x.correct).length / s.length : 0];
    }),
  ) as Record<ReadingField, number>;
  const above = flat.filter((x) => x.confidence >= threshold);
  return {
    bills: scores.length,
    fieldAccuracy,
    overallAccuracy: flat.length ? flat.filter((x) => x.correct).length / flat.length : 0,
    precisionAboveThreshold: above.length
      ? above.filter((x) => x.correct).length / above.length
      : 0,
    coverageAboveThreshold: flat.length ? above.length / flat.length : 0,
    fullyAutomatable: scores.filter((b) => b.every((x) => x.correct && x.confidence >= threshold))
      .length,
  };
}
