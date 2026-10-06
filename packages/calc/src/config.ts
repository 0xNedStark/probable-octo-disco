import { z } from 'zod';

/**
 * Versioned configuration consumed by the engine. Every number a customer sees
 * traces back to one of these documents (PLAN §7). Money is integer paise.
 */

const paise = z.number().int().nonnegative();
const twelve = z.array(z.number().positive()).length(12);

export const SiteConfigSchema = z.object({
  discom: z.string(),
  /** Annual kWh per kWp, by lower-cased city, with a default. */
  specificYield: z.object({
    defaultKwhPerKwp: z.number().positive(),
    byCity: z.record(z.string(), z.number().positive()).default({}),
  }),
  /** Relative monthly generation, Jan..Dec; normalised to mean 1 by the engine. */
  generationMonthlyProfile: twelve,
  /** Relative monthly household consumption, Jan..Dec; normalised to mean 1. */
  consumptionSeasonality: twelve,
  roofAreaM2PerKw: z.number().positive(),
  degradation: z.object({
    firstYearPct: z.number().min(0).max(10),
    annualPct: z.number().min(0).max(5),
  }),
  tariffEscalationPct: z.number().min(0).max(20),
  targetOffset: z.number().positive().max(1.5),
  minSystemKw: z.number().positive(),
  maxSystemKw: z.number().positive(),
  sweetSpotKw: z.number().positive(),
  lifetimeYears: z.number().int().min(1).max(40),
  scenarioYieldFactors: z.object({ low: z.number().positive(), high: z.number().positive() }),
  /** Month (1-12) the net-metering settlement year starts. */
  settlementStartMonth: z.number().int().min(1).max(12),
});

export const TariffConfigSchema = z.object({
  defaultCategory: z.string(),
  categories: z.record(
    z.string(),
    z.object({
      label: z.string(),
      /** Progressive slabs; the last one has uptoKwh null (unbounded). */
      energySlabs: z
        .array(z.object({ uptoKwh: z.number().positive().nullable(), ratePaise: paise }))
        .min(1)
        .refine((s) => s[s.length - 1]!.uptoKwh === null, 'last slab must be unbounded'),
      fixedChargePaisePerKwMonth: paise,
      meterRentPaisePerMonth: paise.default(0),
      dutyPct: z.number().min(0).max(50),
    }),
  ),
  netMetering: z.object({
    /** Paid per banked kWh left at the end of the settlement year. */
    excessSettlementPaisePerKwh: paise,
  }),
});

export const SubsidyConfigSchema = z.object({
  schemes: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      recipient: z.enum(['customer', 'vendor']),
      requiresDcr: z.boolean(),
      /** Cumulative kW bands: first band covers 0..uptoKw[0], next uptoKw[0]..uptoKw[1], … */
      slabs: z.array(z.object({ uptoKw: z.number().positive(), perKwPaise: paise })).min(1),
      capPaise: paise,
    }),
  ),
});

export const PriceBookConfigSchema = z.object({
  /** True until real supplier quotes are entered; quotes from it cannot be sent. */
  placeholder: z.boolean(),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  gst: z.object({
    /** Share of the EPC price taxed as goods; the rest is taxed as services. */
    goodsShare: z.number().min(0).max(1),
    goodsRatePct: z.number().min(0).max(28),
    servicesRatePct: z.number().min(0).max(28),
  }),
  packages: z
    .array(
      z.object({
        id: z.string(),
        kw: z.number().positive(),
        module: z.object({
          sku: z.string(),
          wp: z.number().int().positive(),
          count: z.number().int().positive(),
          dcr: z.boolean(),
        }),
        inverter: z.object({ sku: z.string(), kw: z.number().positive() }),
        /** Pre-GST line items. */
        lines: z
          .array(z.object({ code: z.string(), label: z.string(), amountPaise: paise }))
          .min(1),
      }),
    )
    .min(1),
});

export const LenderConfigSchema = z.object({
  products: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      lender: z.string(),
      minSystemKw: z.number().nonnegative().default(0),
      maxSystemKw: z.number().positive(),
      maxLoanPaise: paise,
      /** Customer's own contribution as a % of system price. */
      marginPct: z.number().min(0).max(100),
      annualRatePct: z.number().min(0).max(40),
      tenorMonths: z.number().int().positive(),
      /** True until terms are confirmed with the lender. */
      placeholder: z.boolean(),
      /** What the customer must have ready for the bank. We track readiness, never store copies. */
      documents: z.array(z.string()).default([]),
    }),
  ),
});

/**
 * Commercial terms shown to customers (PLAN §3C). Not used by the calculation
 * engine, but versioned alongside it so every booking records the terms in force.
 */
export const CommercialConfigSchema = z.object({
  bookingTokenPaise: paise,
  /** Kept from refunds when the customer cancels after the survey for their own reasons. */
  surveyFeePaise: paise,
  /** A final quote more than this % above the indicative one allows a full refund. */
  finalPriceTolerancePct: z.number().min(0).max(100),
  refundPolicyVersion: z.string().min(1),
  /** Short policy text shown at acceptance; the full policy lives on the website. */
  refundPolicySummary: z.array(z.string().min(1)).min(1),
  /** When a loan counts as "funds secured" for procurement. */
  fundsSecuredOn: z.enum(['sanction', 'disbursement']),
});

export type SiteConfig = z.infer<typeof SiteConfigSchema>;
export type TariffConfig = z.infer<typeof TariffConfigSchema>;
export type SubsidyConfig = z.infer<typeof SubsidyConfigSchema>;
export type PriceBookConfig = z.infer<typeof PriceBookConfigSchema>;
export type LenderConfig = z.infer<typeof LenderConfigSchema>;
export type CommercialConfig = z.infer<typeof CommercialConfigSchema>;

export const CONFIG_SCHEMAS = {
  site: SiteConfigSchema,
  tariff: TariffConfigSchema,
  subsidy: SubsidyConfigSchema,
  pricebook: PriceBookConfigSchema,
  lenders: LenderConfigSchema,
  commercial: CommercialConfigSchema,
} as const;

export type ConfigKind = keyof typeof CONFIG_SCHEMAS;
export const CONFIG_KINDS = Object.keys(CONFIG_SCHEMAS) as ConfigKind[];

export interface ConfigBundle {
  site: SiteConfig;
  tariff: TariffConfig;
  subsidy: SubsidyConfig;
  pricebook: PriceBookConfig;
  lenders: LenderConfig;
  commercial: CommercialConfig;
}

/** Version labels for traceability in outputs, e.g. { pricebook: 'pricebook@3' }. */
export type ConfigVersions = Record<ConfigKind, string>;

export function isConfigKind(value: string): value is ConfigKind {
  return value in CONFIG_SCHEMAS;
}

export function parseConfig<K extends ConfigKind>(kind: K, body: unknown): ConfigBundle[K] {
  return CONFIG_SCHEMAS[kind].parse(body) as ConfigBundle[K];
}
