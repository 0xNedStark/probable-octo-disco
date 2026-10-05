import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

/** Bump whenever the prompt or schema changes; stored on every ai_actions row. */
export const BILL_PROMPT_VERSION = 'bill-extract-v1';
export const DEFAULT_BILL_MODEL = 'claude-opus-5-5';

export const READING_FIELDS = [
  'consumerNumber',
  'discom',
  'tariffCategory',
  'sanctionedLoadKw',
  'periodStart',
  'periodEnd',
  'unitsKwh',
  'amountRupees',
] as const;
export type ReadingField = (typeof READING_FIELDS)[number];

/** What the model returns (snake_case, nullable when not visible on the bill). */
export const BillOutputSchema = z.object({
  is_electricity_bill: z.boolean().describe('True only for an Indian electricity (DISCOM) bill.'),
  discom: z
    .string()
    .nullable()
    .describe('Distribution company short name, e.g. DVVNL, MVVNL, PVVNL, PuVVNL, KESCO.'),
  consumer_number: z
    .string()
    .nullable()
    .describe('Account / consumer number exactly as printed, digits only where possible.'),
  tariff_category: z
    .string()
    .nullable()
    .describe('Tariff or category code as printed, e.g. LMV-1.'),
  sanctioned_load_kw: z
    .number()
    .nullable()
    .describe(
      'Sanctioned / contracted load in kW (convert kVA or W if needed and say so in notes).',
    ),
  period_start: z.string().nullable().describe('Billing period start date as YYYY-MM-DD.'),
  period_end: z.string().nullable().describe('Billing period end date as YYYY-MM-DD.'),
  units_kwh: z.number().nullable().describe('Units (kWh) consumed in this billing period.'),
  amount_rupees: z
    .number()
    .nullable()
    .describe("This period's bill amount in rupees, excluding arrears if shown separately."),
  monthly_history: z
    .array(z.object({ month: z.string().describe('YYYY-MM'), units: z.number() }))
    .describe(
      'Past consumption printed on the bill (consumption history table/graph values), if legible.',
    ),
  confidence: z
    .object({
      consumer_number: z.number(),
      discom: z.number(),
      tariff_category: z.number(),
      sanctioned_load_kw: z.number(),
      period_start: z.number(),
      period_end: z.number(),
      units_kwh: z.number(),
      amount_rupees: z.number(),
    })
    .describe(
      '0 to 1 per field: how sure you are the value is exactly right as printed. Use 0 when null.',
    ),
  notes: z
    .string()
    .nullable()
    .describe('Anything ambiguous: unit conversions, multiple meters, unreadable areas.'),
});
export type BillOutput = z.infer<typeof BillOutputSchema>;

export interface ExtractedBill {
  isElectricityBill: boolean;
  fields: Partial<{
    consumerNumber: string;
    discom: string;
    tariffCategory: string;
    sanctionedLoadKw: number;
    periodStart: string;
    periodEnd: string;
    unitsKwh: number;
    amountRupees: number;
    monthlyHistory: { month: string; units: number }[];
  }>;
  confidence: Partial<Record<ReadingField, number>>;
  notes: string | null;
}

export type ExtractionOutcome = 'ok' | 'refused' | 'invalid_output' | 'error';

export interface ExtractionResult {
  outcome: ExtractionOutcome;
  extraction: ExtractedBill | null;
  /** Model that actually served the request (may differ after a fallback). */
  model: string;
  promptVersion: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  error: string | null;
}

const SYSTEM_PROMPT = `You read Indian residential electricity bills (mainly Uttar Pradesh DISCOMs such as DVVNL) so a rooftop-solar team can size a system.

Extract only what is printed on the document. If a value is missing, cut off or unreadable, return null for it with confidence 0 — a person will fill it in. Never infer a value from typical bills, and never compute a value the bill does not show, except straightforward unit conversions (explain those in notes).

Bills are often bilingual (Hindi and English) and may be photos taken at an angle. Read numbers carefully; when two printed values conflict (for example billed units vs. meter reading difference), prefer the billed units and mention the conflict in notes.

Confidence reflects whether the value is exactly right as printed, not whether it seems plausible.`;

export interface BillExtractorOptions {
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

type MediaType = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';

/** The request we send, exported for tests and audit. */
export function buildBillRequest(
  body: Uint8Array,
  contentType: MediaType,
  opts: BillExtractorOptions = {},
) {
  const data = Buffer.from(body).toString('base64');
  const file =
    contentType === 'application/pdf'
      ? ({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data },
        } as const)
      : ({ type: 'image', source: { type: 'base64', media_type: contentType, data } } as const);
  return {
    model: opts.model ?? DEFAULT_BILL_MODEL,
    max_tokens: 16000,
    // Server-side fallback: if the model declines, Anthropic re-runs on its recommended fallback.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default' as const,
    output_config: {
      effort: opts.effort ?? 'medium',
      format: betaZodOutputFormat(BillOutputSchema),
    },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user' as const,
        content: [file, { type: 'text' as const, text: 'Extract the bill details.' }],
      },
    ],
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Map the model's output to our field names, dropping malformed values (they become "unread"). */
export function toExtractedBill(o: BillOutput): ExtractedBill {
  const fields: ExtractedBill['fields'] = {};
  const confidence: ExtractedBill['confidence'] = {};
  const set = <K extends ReadingField>(
    k: K,
    v: ExtractedBill['fields'][K] | null,
    c: number,
    ok = true,
  ) => {
    if (v !== null && v !== undefined && ok) {
      fields[k] = v;
      confidence[k] = Math.max(0, Math.min(1, c));
    } else {
      confidence[k] = 0;
    }
  };
  set('consumerNumber', o.consumer_number?.trim() || null, o.confidence.consumer_number);
  set('discom', o.discom?.trim().toUpperCase() || null, o.confidence.discom);
  set('tariffCategory', o.tariff_category?.trim() || null, o.confidence.tariff_category);
  set(
    'sanctionedLoadKw',
    o.sanctioned_load_kw,
    o.confidence.sanctioned_load_kw,
    (o.sanctioned_load_kw ?? 0) > 0,
  );
  set(
    'periodStart',
    o.period_start,
    o.confidence.period_start,
    ISO_DATE.test(o.period_start ?? ''),
  );
  set('periodEnd', o.period_end, o.confidence.period_end, ISO_DATE.test(o.period_end ?? ''));
  set(
    'unitsKwh',
    o.units_kwh != null ? Math.round(o.units_kwh) : null,
    o.confidence.units_kwh,
    (o.units_kwh ?? -1) >= 0,
  );
  set('amountRupees', o.amount_rupees, o.confidence.amount_rupees, (o.amount_rupees ?? -1) >= 0);
  fields.monthlyHistory = o.monthly_history
    .filter((m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m.month) && m.units >= 0)
    .map((m) => ({ month: m.month, units: Math.round(m.units) }));
  return { isElectricityBill: o.is_electricity_bill, fields, confidence, notes: o.notes };
}

export class ClaudeBillExtractor {
  constructor(
    private readonly client: Anthropic,
    private readonly opts: BillExtractorOptions = {},
  ) {}

  async extract(body: Uint8Array, contentType: MediaType): Promise<ExtractionResult> {
    const started = Date.now();
    const base = {
      promptVersion: BILL_PROMPT_VERSION,
      model: this.opts.model ?? DEFAULT_BILL_MODEL,
    };
    try {
      const response = await this.client.beta.messages.parse(
        buildBillRequest(body, contentType, this.opts),
      );
      const common = {
        ...base,
        model: response.model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        latencyMs: Date.now() - started,
      };
      if (response.stop_reason === 'refusal') {
        return {
          ...common,
          outcome: 'refused',
          extraction: null,
          error: response.stop_details?.category ?? 'refused',
        };
      }
      if (response.stop_reason === 'max_tokens' || !response.parsed_output) {
        return {
          ...common,
          outcome: 'invalid_output',
          extraction: null,
          error: `stop_reason=${response.stop_reason}`,
        };
      }
      return {
        ...common,
        outcome: 'ok',
        extraction: toExtractedBill(response.parsed_output),
        error: null,
      };
    } catch (e) {
      const message =
        e instanceof Anthropic.APIError
          ? `API ${e.status ?? ''}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      return {
        ...base,
        outcome: 'error',
        extraction: null,
        inputTokens: null,
        outputTokens: null,
        latencyMs: Date.now() - started,
        error: message,
      };
    }
  }
}

/** Returns null when AI extraction isn't configured; the manual flow still works. */
export function billExtractorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ClaudeBillExtractor | null {
  if (env.AI_BILL_EXTRACTION !== 'on') return null;
  const effort = env.AI_BILL_EFFORT as BillExtractorOptions['effort'] | undefined;
  return new ClaudeBillExtractor(new Anthropic(), {
    model: env.AI_BILL_MODEL || undefined,
    effort,
  });
}
