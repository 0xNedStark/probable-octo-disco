import type { ConfigBundle } from './config';

/**
 * Seed configuration for the UP / DVVNL pilot (PLAN §3A).
 *
 * Status of each document:
 * - tariff: UPPCL LMV-1 domestic urban as published on third-party calculators;
 *   verify against the current UPERC tariff order before go-live.
 * - subsidy: PM Surya Ghar central CFA + UPNEDA state top-up; re-verify.
 * - pricebook: PLACEHOLDER figures — replace with supplier quotes. Quotes from a
 *   placeholder price book cannot be sent to customers.
 * - lenders: SBI PM Surya Ghar terms as publicly reported; PLACEHOLDER until confirmed.
 * - commercial: booking token, survey fee and refund terms proposed in PLAN §3C;
 *   pending legal/CA review.
 * - site: yield and seasonal profiles are approximations for Agra; calibrate with
 *   PVGIS and the 12-month history printed on real bills.
 */

const rupees = (r: number) => Math.round(r * 100);

const INVERTER_PRICE: Record<number, number> = {
  2: 18000,
  3: 22000,
  4: 28000,
  5: 32000,
  6: 40000,
  8: 55000,
  10: 65000,
};

function pkg(size: number) {
  const moduleWp = 545;
  const count = Math.ceil((size * 1000) / moduleWp);
  return {
    id: `dcr-${size}kw`,
    kw: size,
    module: { sku: `DCR-TOPCON-${moduleWp}`, wp: moduleWp, count, dcr: true },
    inverter: { sku: `ONGRID-${size}KW`, kw: size },
    lines: [
      {
        code: 'modules',
        label: `${count} × ${moduleWp} Wp DCR modules`,
        amountPaise: rupees(28000 * size),
      },
      {
        code: 'inverter',
        label: `${size} kW on-grid inverter`,
        amountPaise: rupees(INVERTER_PRICE[size]!),
      },
      { code: 'structure', label: 'Mounting structure', amountPaise: rupees(7000 * size) },
      {
        code: 'bos',
        label: 'Cables, earthing, protection (BOS)',
        amountPaise: rupees(6000 * size),
      },
      {
        code: 'installation',
        label: 'Installation and commissioning',
        amountPaise: rupees(5000 * size),
      },
      { code: 'discom', label: 'Net meter and DISCOM fees', amountPaise: rupees(6000) },
      {
        code: 'service',
        label: 'Project management and paperwork',
        amountPaise: rupees(5000 * size),
      },
    ],
  };
}

export const UP_DVVNL_SEED: ConfigBundle = {
  site: {
    discom: 'DVVNL',
    specificYield: { defaultKwhPerKwp: 1450, byCity: { agra: 1450 } },
    generationMonthlyProfile: [0.85, 0.95, 1.1, 1.15, 1.15, 1.05, 0.9, 0.9, 1.0, 1.05, 0.95, 0.95],
    consumptionSeasonality: [0.8, 0.75, 0.85, 1.05, 1.3, 1.35, 1.25, 1.2, 1.1, 0.95, 0.75, 0.8],
    roofAreaM2PerKw: 10,
    degradation: { firstYearPct: 2, annualPct: 0.5 },
    tariffEscalationPct: 0,
    targetOffset: 1,
    minSystemKw: 1,
    maxSystemKw: 10,
    sweetSpotKw: 3,
    lifetimeYears: 25,
    scenarioYieldFactors: { low: 0.9, high: 1.1 },
    settlementStartMonth: 4,
  },
  tariff: {
    defaultCategory: 'LMV-1-URBAN',
    categories: {
      'LMV-1-URBAN': {
        label: 'Domestic, urban (metered)',
        energySlabs: [
          { uptoKwh: 150, ratePaise: 550 },
          { uptoKwh: 300, ratePaise: 600 },
          { uptoKwh: null, ratePaise: 650 },
        ],
        fixedChargePaisePerKwMonth: 11000,
        meterRentPaisePerMonth: 2000,
        dutyPct: 5,
      },
    },
    netMetering: { excessSettlementPaisePerKwh: 0 },
  },
  subsidy: {
    schemes: [
      {
        id: 'pm-surya-ghar-central',
        label: 'PM Surya Ghar central subsidy',
        recipient: 'customer',
        requiresDcr: true,
        slabs: [
          { uptoKw: 2, perKwPaise: rupees(30000) },
          { uptoKw: 3, perKwPaise: rupees(18000) },
        ],
        capPaise: rupees(78000),
      },
      {
        id: 'up-state',
        label: 'Uttar Pradesh state subsidy (UPNEDA)',
        recipient: 'customer',
        requiresDcr: true,
        slabs: [{ uptoKw: 2, perKwPaise: rupees(15000) }],
        capPaise: rupees(30000),
      },
    ],
  },
  pricebook: {
    placeholder: true,
    validUntil: '2026-12-31',
    gst: { goodsShare: 0.7, goodsRatePct: 5, servicesRatePct: 18 },
    packages: [2, 3, 4, 5, 6, 8, 10].map(pkg),
  },
  lenders: {
    products: [
      {
        id: 'sbi-psg-upto3kw',
        label: 'SBI rooftop solar loan (up to 3 kW)',
        lender: 'SBI',
        minSystemKw: 0,
        maxSystemKw: 3,
        maxLoanPaise: rupees(200000),
        marginPct: 10,
        annualRatePct: 7,
        tenorMonths: 120,
        placeholder: true,
        documents: [
          'Aadhaar and PAN (shown to the bank; we do not keep copies)',
          'Last 6 months bank statement',
          'Latest electricity bill',
          'Income proof (salary slips or ITR)',
          'PM Surya Ghar application number',
          'House ownership proof (registry or house tax receipt)',
        ],
      },
      {
        id: 'sbi-rooftop-3-10kw',
        label: 'SBI rooftop solar loan (3–10 kW)',
        lender: 'SBI',
        minSystemKw: 3.01,
        maxSystemKw: 10,
        maxLoanPaise: rupees(600000),
        marginPct: 20,
        annualRatePct: 10.15,
        tenorMonths: 120,
        placeholder: true,
        documents: [
          'Aadhaar and PAN (shown to the bank; we do not keep copies)',
          'Last 6 months bank statement',
          'Latest electricity bill',
          'Income proof (salary slips or ITR)',
          'PM Surya Ghar application number',
          'House ownership proof (registry or house tax receipt)',
        ],
      },
    ],
  },
  commercial: {
    bookingTokenPaise: rupees(5000),
    surveyFeePaise: rupees(2000),
    finalPriceTolerancePct: 5,
    refundPolicyVersion: 'refund-v1-2026-10',
    refundPolicySummary: [
      'Booking token is fully refundable before the site survey.',
      'Full refund of everything paid if the roof is unsuitable, the final price is more than 5% above this quote, DVVNL rejects the application, or the loan is rejected.',
      'If you cancel for your own reasons after the survey, we keep a ₹2,000 survey and design fee.',
      'Refunds are made within 7 working days to the original payment method.',
    ],
    fundsSecuredOn: 'sanction',
  },
};
