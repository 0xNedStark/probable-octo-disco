import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  buildSalesRequest,
  ClaudeSalesAgent,
  guardReply,
  numbersIn,
  type SalesReply,
} from './sales-agent';

const facts = {
  customerFirstName: 'Asha',
  projectCode: 'SOL-2026-00037',
  proposal: {
    systemKw: 3,
    priceInclGstRupees: 197109,
    subsidyRupees: 108000,
    validUntil: '2026-10-20',
    paymentOptions: [{ monthlyEmiRupees: 2060 }],
  },
  loanDocumentsStillNeeded: ['Aadhaar and PAN (shown to the bank; we do not keep copies)'],
  statusPageUrl: 'https://x.test/s/prj_01ABC.sig',
};
const draft = (
  reply: string,
  intent: SalesReply['intent'] = 'price_question',
  escalate = false,
): SalesReply => ({
  intent,
  reply,
  escalate,
  escalation_reason: null,
});

describe('numbersIn', () => {
  it('normalises Indian digit grouping and decimals', () => {
    expect([...numbersIn('₹1,97,109 or 2,060.00/month, 3 kW')]).toEqual(['197109', '2060', '3']);
  });
});

describe('guardReply', () => {
  it('passes replies whose numbers all come from the facts', () => {
    const r = guardReply(
      draft('Your 3 kW system costs ₹1,97,109; subsidy ₹1,08,000 credited later. EMI from ₹2,060.'),
      facts,
      'kitne ka padega?',
    );
    expect(r).toEqual({ ok: true, reasons: [], escalate: false });
  });

  it('blocks invented numbers', () => {
    const r = guardReply(
      draft('Installation will be done in 7 days for ₹1,80,000.'),
      facts,
      'kab hoga?',
    );
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/unsupported numbers: 7, 180000/);
  });

  it('ignores digits in links and project codes on both sides', () => {
    // "37" appears only inside the project code and must not become an allowed claim.
    expect(guardReply(draft('Delivery in 37 days.'), facts, '').reasons[0]).toMatch(
      /unsupported numbers: 37/,
    );
    expect(
      guardReply(draft('Track SOL-2026-00037 here: https://x.test/s/prj_01ABC.sig'), facts, '').ok,
    ).toBe(true);
  });

  it('allows numbers the customer used', () => {
    expect(
      guardReply(draft('Got it, a 5 kW system — our team will check.'), facts, 'mujhe 5 kW chahiye')
        .ok,
    ).toBe(true);
  });

  it('blocks requests for sensitive data but allows listing bank documents', () => {
    expect(guardReply(draft('Please send your Aadhaar number here.'), facts, '').reasons).toContain(
      'asks for sensitive information',
    );
    expect(guardReply(draft('कृपया अपना आधार नंबर भेजें'), facts, '').ok).toBe(false);
    expect(
      guardReply(
        draft(
          'For the bank, keep Aadhaar and PAN ready — you show them at the branch.',
          'documents_needed',
        ),
        facts,
        '',
      ).ok,
    ).toBe(true);
  });

  it('always escalates faults and complaints', () => {
    expect(
      guardReply(draft('Sorry! Our team will call you.', 'generation_problem'), facts, '').escalate,
    ).toBe(true);
    expect(guardReply(draft('Sorry to hear that.', 'complaint'), facts, '').escalate).toBe(true);
  });
});

describe('ClaudeSalesAgent', () => {
  it('sends facts and transcript with structured output and fallback', async () => {
    const req = buildSalesRequest(facts, [{ direction: 'in', text: 'Solar lagwana hai' }]);
    expect(req).toMatchObject({
      model: 'claude-opus-5-5',
      fallbacks: 'default',
      output_config: { effort: 'low' },
    });
    expect(req.messages[0]!.content).toContain('"priceInclGstRupees": 197109');
    expect(req.messages[0]!.content).toContain('Customer: Solar lagwana hai');
  });

  it('returns the parsed reply or a failure outcome', async () => {
    const parse = vi
      .fn()
      .mockResolvedValueOnce({
        model: 'm',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 2 },
        parsed_output: draft('Hi Asha!'),
      })
      .mockResolvedValueOnce({
        model: 'm',
        stop_reason: 'refusal',
        stop_details: { category: 'cyber' },
        usage: { input_tokens: 1, output_tokens: 0 },
        parsed_output: null,
      })
      .mockRejectedValueOnce(new Error('network'));
    const agent = new ClaudeSalesAgent({ beta: { messages: { parse } } } as unknown as Anthropic);
    expect((await agent.reply(facts, [])).reply?.reply).toBe('Hi Asha!');
    expect((await agent.reply(facts, [])).outcome).toBe('refused');
    expect(await agent.reply(facts, [])).toMatchObject({ outcome: 'error', error: 'network' });
  });
});
