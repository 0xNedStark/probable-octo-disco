import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { scoreBill, summarise } from '../eval/score';
import {
  buildBillRequest,
  ClaudeBillExtractor,
  toExtractedBill,
  type BillOutput,
} from './bill-extractor';

const output: BillOutput = {
  is_electricity_bill: true,
  discom: 'dvvnl',
  consumer_number: ' 1234567890 ',
  tariff_category: 'LMV-1',
  sanctioned_load_kw: 3,
  period_start: '2026-08-01',
  period_end: '2026-08-31',
  units_kwh: 420.4,
  amount_rupees: 3150,
  monthly_history: [
    { month: '2026-07', units: 450 },
    { month: '2026-13', units: 1 },
  ],
  confidence: {
    consumer_number: 0.99,
    discom: 0.99,
    tariff_category: 0.9,
    sanctioned_load_kw: 0.95,
    period_start: 0.98,
    period_end: 0.98,
    units_kwh: 1.2,
    amount_rupees: 0.97,
  },
  notes: null,
};

function fakeClient(response: unknown, fail?: Error) {
  const parse = vi.fn(async () => {
    if (fail) throw fail;
    return response;
  });
  return { client: { beta: { messages: { parse } } } as unknown as Anthropic, parse };
}

describe('buildBillRequest', () => {
  it('sends PDFs as documents and photos as images, with fallback and structured output', () => {
    const pdf = buildBillRequest(new Uint8Array([1, 2]), 'application/pdf');
    expect(pdf.model).toBe('claude-opus-5-5');
    expect(pdf.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(pdf.fallbacks).toBe('default');
    expect(pdf.output_config.effort).toBe('medium');
    expect(pdf.output_config.format).toBeDefined();
    expect(pdf.messages[0]!.content[0]).toMatchObject({
      type: 'document',
      source: { media_type: 'application/pdf', data: 'AQI=' },
    });
    const jpg = buildBillRequest(new Uint8Array([1]), 'image/jpeg', { effort: 'high', model: 'm' });
    expect(jpg.messages[0]!.content[0]).toMatchObject({
      type: 'image',
      source: { media_type: 'image/jpeg' },
    });
    expect(jpg).toMatchObject({ model: 'm', output_config: { effort: 'high' } });
  });
});

describe('toExtractedBill', () => {
  it('normalises values, clamps confidence and drops malformed history', () => {
    const e = toExtractedBill(output);
    expect(e.fields).toMatchObject({
      consumerNumber: '1234567890',
      discom: 'DVVNL',
      unitsKwh: 420,
    });
    expect(e.fields.monthlyHistory).toEqual([{ month: '2026-07', units: 450 }]);
    expect(e.confidence.unitsKwh).toBe(1);
  });

  it('treats null and malformed fields as unread with zero confidence', () => {
    const e = toExtractedBill({ ...output, units_kwh: null, period_end: '31/08/2026' });
    expect(e.fields.unitsKwh).toBeUndefined();
    expect(e.fields.periodEnd).toBeUndefined();
    expect(e.confidence).toMatchObject({ unitsKwh: 0, periodEnd: 0 });
  });
});

describe('ClaudeBillExtractor', () => {
  const usage = { input_tokens: 1200, output_tokens: 300 };

  it('returns a mapped extraction on success', async () => {
    const { client } = fakeClient({
      model: 'claude-opus-5-5',
      stop_reason: 'end_turn',
      usage,
      parsed_output: output,
    });
    const r = await new ClaudeBillExtractor(client).extract(new Uint8Array([1]), 'image/png');
    expect(r).toMatchObject({
      outcome: 'ok',
      model: 'claude-opus-5-5',
      inputTokens: 1200,
      promptVersion: 'bill-extract-v1',
    });
    expect(r.extraction?.fields.amountRupees).toBe(3150);
  });

  it('reports refusals and unparseable output without throwing', async () => {
    const refused = fakeClient({
      model: 'm',
      stop_reason: 'refusal',
      stop_details: { category: 'cyber' },
      usage,
      parsed_output: null,
    });
    expect(
      await new ClaudeBillExtractor(refused.client).extract(new Uint8Array([1]), 'image/png'),
    ).toMatchObject({ outcome: 'refused', error: 'cyber' });
    const truncated = fakeClient({
      model: 'm',
      stop_reason: 'max_tokens',
      usage,
      parsed_output: null,
    });
    expect(
      await new ClaudeBillExtractor(truncated.client).extract(new Uint8Array([1]), 'image/png'),
    ).toMatchObject({ outcome: 'invalid_output' });
  });

  it('reports API errors as outcome=error', async () => {
    const { client } = fakeClient(null, new Error('socket hang up'));
    const r = await new ClaudeBillExtractor(client).extract(new Uint8Array([1]), 'application/pdf');
    expect(r).toMatchObject({ outcome: 'error', extraction: null, error: 'socket hang up' });
  });
});

describe('eval scoring', () => {
  it('scores fields and summarises precision above threshold', () => {
    const label = {
      consumerNumber: '1234567890',
      discom: 'DVVNL',
      tariffCategory: 'LMV 1',
      sanctionedLoadKw: 3,
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      unitsKwh: 421,
      amountRupees: 3150,
    };
    const scores = scoreBill(label, toExtractedBill(output));
    const wrong = scores.filter((s) => !s.correct).map((s) => s.field);
    expect(wrong).toEqual(['tariffCategory']); // "LMV-1" vs "LMV 1"; 420 vs 421 is within 0.5%
    const s = summarise([scores, scoreBill(label, null)], 0.9);
    expect(s.bills).toBe(2);
    expect(s.fieldAccuracy.unitsKwh).toBe(0.5);
    expect(s.precisionAboveThreshold).toBeCloseTo(7 / 8, 6);
    expect(s.fullyAutomatable).toBe(0);
  });
});
