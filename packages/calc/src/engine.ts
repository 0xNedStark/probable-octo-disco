import type { ConfigBundle, ConfigVersions, PriceBookConfig, TariffConfig } from './config';

/** Bump on any change to calculation logic; stored on every quote (PLAN §7). */
export const CALC_VERSION = '1.0.0';

export interface MonthlyUsage {
  /** YYYY-MM */
  month: string;
  units: number;
}

export interface CalcInput {
  grade: 'INDICATIVE' | 'FINAL';
  city: string;
  tariffCategory: string;
  sanctionedLoadKw: number;
  /** At least one month; duplicates for a month are not allowed. */
  monthlyUsage: MonthlyUsage[];
  /** Usable shadow-free roof area; optional for indicative quotes. */
  roofAreaM2?: number;
  /** Overrides the site default target offset (share of consumption to cover). */
  targetOffset?: number;
  /** Force a specific package (engineer override on final quotes). */
  packageId?: string;
}

export type Flag =
  | 'extrapolated_consumption'
  | 'consumption_below_smallest_package'
  | 'roof_limited'
  | 'sanctioned_load_exceeded'
  | 'max_system_size_limited'
  | 'placeholder_prices'
  | 'placeholder_lender_terms'
  | 'sweet_spot'
  | 'package_override';

export interface Assumption {
  key: string;
  label: string;
  value: string | number;
  source: string;
}

export interface FinanceOption {
  id: string;
  label: string;
  loanPaise: number;
  /** What the customer pays to the vendor before installation (margin money or full price). */
  payNowPaise: number;
  emiPaise: number | null;
  annualRatePct: number | null;
  tenorMonths: number | null;
  illustrative: boolean;
}

export interface Scenario {
  yieldFactor: number;
  year1SavingsPaise: number;
  paybackYears: number | null;
}

export interface CalcOutput {
  calcVersion: string;
  grade: CalcInput['grade'];
  sizing: {
    annualConsumptionKwh: number;
    monthsOfData: number;
    specificYieldKwhPerKwp: number;
    targetKw: number;
    roofCapKw: number | null;
    recommendedKw: number;
  };
  system: {
    packageId: string;
    kw: number;
    moduleSku: string;
    moduleWp: number;
    moduleCount: number;
    dcr: boolean;
    inverterSku: string;
    inverterKw: number;
  };
  generation: { year1Kwh: number; monthlyKwh: number[] };
  price: {
    lines: { code: string; label: string; amountPaise: number }[];
    subtotalPaise: number;
    gstPaise: number;
    totalPaise: number;
  };
  subsidy: {
    schemes: {
      id: string;
      label: string;
      amountPaise: number;
      eligible: boolean;
      reason: string | null;
    }[];
    totalPaise: number;
    recipient: 'customer' | 'vendor' | 'mixed';
  };
  netCostAfterSubsidyPaise: number;
  finance: FinanceOption[];
  savings: {
    monthlyBillBeforePaise: number[];
    monthlyBillAfterPaise: number[];
    year1SavingsPaise: number;
    lifetimeSavingsPaise: number;
    lifetimeYears: number;
    paybackYears: number | null;
    scenarios: Scenario[];
  };
  flags: Flag[];
  assumptions: Assumption[];
}

export class CalcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalcError';
  }
}

const round = (n: number) => Math.round(n);
const round2 = (n: number) => Math.round(n * 100) / 100;
const toRupee = (paise: number) => Math.round(paise / 100) * 100;

function normalise(profile: number[]): number[] {
  const mean = profile.reduce((a, b) => a + b, 0) / profile.length;
  return profile.map((v) => v / mean);
}

function monthIndex(month: string): number {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  const idx = m ? Number(m[2]) - 1 : NaN;
  if (!(idx >= 0 && idx < 12)) throw new CalcError(`Invalid month: ${month}`);
  return idx;
}

/**
 * Twelve calendar-month consumption values (Jan..Dec). With 12+ months of data
 * the latest actual per calendar month is used; otherwise the available months
 * are de-seasonalised, averaged and re-profiled.
 */
export function monthlyConsumption(
  usage: MonthlyUsage[],
  seasonality: number[],
): { monthly: number[]; monthsOfData: number } {
  if (usage.length === 0) throw new CalcError('At least one month of consumption is required.');
  const latest = new Map<number, { month: string; units: number }>();
  for (const u of usage) {
    if (!(Number.isFinite(u.units) && u.units >= 0))
      throw new CalcError(`Invalid units for ${u.month}`);
    const idx = monthIndex(u.month);
    const prev = latest.get(idx);
    if (!prev || u.month > prev.month) latest.set(idx, u);
  }
  const s = normalise(seasonality);
  if (latest.size === 12) {
    return {
      monthly: Array.from({ length: 12 }, (_, i) => latest.get(i)!.units),
      monthsOfData: 12,
    };
  }
  const deseasonalised = [...latest.entries()].map(([i, u]) => u.units / s[i]!);
  const base = deseasonalised.reduce((a, b) => a + b, 0) / deseasonalised.length;
  return { monthly: s.map((f) => base * f), monthsOfData: latest.size };
}

/** One month's bill for a given billable kWh under a tariff category. */
export function monthlyBillPaise(
  tariff: TariffConfig['categories'][string],
  units: number,
  sanctionedLoadKw: number,
): number {
  let remaining = units;
  let lower = 0;
  let energy = 0;
  for (const slab of tariff.energySlabs) {
    const width = slab.uptoKwh === null ? Infinity : slab.uptoKwh - lower;
    const inSlab = Math.min(remaining, width);
    energy += inSlab * slab.ratePaise;
    remaining -= inSlab;
    if (slab.uptoKwh !== null) lower = slab.uptoKwh;
    if (remaining <= 0) break;
  }
  const fixed = tariff.fixedChargePaisePerKwMonth * sanctionedLoadKw;
  return (energy + fixed) * (1 + tariff.dutyPct / 100) + tariff.meterRentPaisePerMonth;
}

/**
 * Bills for one year before and after solar, with net-metering banking across
 * the settlement year. Returns per calendar month (Jan..Dec) plus the year-end
 * settlement credit for unused banked units.
 */
function simulateYear(
  bundle: ConfigBundle,
  category: TariffConfig['categories'][string],
  sanctionedLoadKw: number,
  consumption: number[],
  generation: number[],
): { before: number[]; after: number[]; settlementCredit: number } {
  const before = new Array<number>(12).fill(0);
  const after = new Array<number>(12).fill(0);
  let banked = 0;
  for (let k = 0; k < 12; k++) {
    const i = (bundle.site.settlementStartMonth - 1 + k) % 12;
    before[i] = monthlyBillPaise(category, consumption[i]!, sanctionedLoadKw);
    let net = consumption[i]! - generation[i]!;
    if (net < 0) {
      banked += -net;
      net = 0;
    } else {
      const used = Math.min(banked, net);
      banked -= used;
      net -= used;
    }
    after[i] = monthlyBillPaise(category, net, sanctionedLoadKw);
  }
  return {
    before,
    after,
    settlementCredit: banked * bundle.tariff.netMetering.excessSettlementPaisePerKwh,
  };
}

function choosePackage(
  packages: PriceBookConfig['packages'],
  targetKw: number,
  capKw: number,
): PriceBookConfig['packages'][number] {
  const sorted = [...packages].sort((a, b) => a.kw - b.kw);
  const allowed = sorted.filter((p) => p.kw <= capKw + 1e-9);
  const pool = allowed.length ? allowed : [sorted[0]!];
  let best = pool[0]!;
  for (const p of pool) {
    const d = Math.abs(p.kw - targetKw);
    const bd = Math.abs(best.kw - targetKw);
    if (d < bd || (d === bd && p.kw > best.kw)) best = p;
  }
  return best;
}

function subsidyFor(
  schemeSlabs: { uptoKw: number; perKwPaise: number }[],
  kw: number,
  cap: number,
) {
  let lower = 0;
  let total = 0;
  for (const slab of schemeSlabs) {
    const portion = Math.min(kw, slab.uptoKw) - lower;
    if (portion > 0) total += portion * slab.perKwPaise;
    lower = slab.uptoKw;
  }
  return round(Math.min(total, cap));
}

function emi(principalPaise: number, annualRatePct: number, months: number): number {
  if (principalPaise <= 0) return 0;
  const r = annualRatePct / 12 / 100;
  if (r === 0) return toRupee(principalPaise / months);
  const f = Math.pow(1 + r, months);
  return toRupee((principalPaise * r * f) / (f - 1));
}

function paybackYears(netCost: number, yearlySavings: number[]): number | null {
  let cumulative = 0;
  for (let y = 0; y < yearlySavings.length; y++) {
    const s = yearlySavings[y]!;
    if (s > 0 && cumulative + s >= netCost) return round2(y + (netCost - cumulative) / s);
    cumulative += s;
  }
  return null;
}

/** Year-by-year savings over the system lifetime for a given yield factor. */
function lifetimeSavings(
  bundle: ConfigBundle,
  category: TariffConfig['categories'][string],
  sanctionedLoadKw: number,
  consumption: number[],
  year1Generation: number[],
  yieldFactor: number,
) {
  const { degradation, tariffEscalationPct, lifetimeYears } = bundle.site;
  const yearly: number[] = [];
  let first: ReturnType<typeof simulateYear> | null = null;
  for (let y = 0; y < lifetimeYears; y++) {
    // year1Generation already includes first-year degradation.
    const genFactor = yieldFactor * Math.pow(1 - degradation.annualPct / 100, y);
    const sim = simulateYear(
      bundle,
      category,
      sanctionedLoadKw,
      consumption,
      year1Generation.map((g) => g * genFactor),
    );
    if (y === 0) first = sim;
    const escalation = Math.pow(1 + tariffEscalationPct / 100, y);
    const sum = (a: number[]) => a.reduce((x, z) => x + z, 0);
    yearly.push((sum(sim.before) - sum(sim.after) + sim.settlementCredit) * escalation);
  }
  return { yearly, first: first! };
}

export function calculate(
  input: CalcInput,
  bundle: ConfigBundle,
  versions: ConfigVersions,
): CalcOutput {
  const { site, tariff, subsidy, pricebook, lenders } = bundle;
  const flags: Flag[] = [];
  const assumptions: Assumption[] = [];
  const note = (
    key: string,
    label: string,
    value: string | number,
    kind: keyof ConfigVersions | 'input',
  ) => assumptions.push({ key, label, value, source: kind === 'input' ? 'input' : versions[kind] });

  if (!(input.sanctionedLoadKw > 0)) throw new CalcError('Sanctioned load must be positive.');
  const category = tariff.categories[input.tariffCategory];
  if (!category) throw new CalcError(`Unknown tariff category ${input.tariffCategory}.`);

  // 1. Consumption
  const { monthly: consumption, monthsOfData } = monthlyConsumption(
    input.monthlyUsage,
    site.consumptionSeasonality,
  );
  const annualConsumptionKwh = consumption.reduce((a, b) => a + b, 0);
  if (monthsOfData < 12) flags.push('extrapolated_consumption');
  note('months_of_data', 'Months of consumption data', monthsOfData, 'input');

  // 2. Target size
  const cityKey = input.city.trim().toLowerCase();
  const specificYield = site.specificYield.byCity[cityKey] ?? site.specificYield.defaultKwhPerKwp;
  note('specific_yield', 'Expected generation per kWp per year (kWh)', specificYield, 'site');
  const offset = input.targetOffset ?? site.targetOffset;
  note(
    'target_offset',
    'Share of consumption the system aims to cover',
    offset,
    input.targetOffset ? 'input' : 'site',
  );
  const targetKw = (annualConsumptionKwh * offset) / specificYield;

  // 3. Caps
  let capKw = site.maxSystemKw;
  const roofCapKw = input.roofAreaM2 != null ? input.roofAreaM2 / site.roofAreaM2PerKw : null;
  if (roofCapKw != null) {
    note('roof_area', 'Usable roof area (m²)', input.roofAreaM2!, 'input');
    note('roof_area_per_kw', 'Roof area needed per kW (m²)', site.roofAreaM2PerKw, 'site');
    if (roofCapKw < capKw) capKw = roofCapKw;
  }

  // 4. Package
  let pkg;
  if (input.packageId) {
    pkg = pricebook.packages.find((p) => p.id === input.packageId);
    if (!pkg) throw new CalcError(`Unknown package ${input.packageId}.`);
    flags.push('package_override');
  } else {
    pkg = choosePackage(pricebook.packages, Math.max(targetKw, site.minSystemKw), capKw);
  }
  const smallest = Math.min(...pricebook.packages.map((p) => p.kw));
  if (targetKw < smallest) flags.push('consumption_below_smallest_package');
  if (roofCapKw != null && targetKw > roofCapKw && pkg.kw <= roofCapKw + 1e-9)
    flags.push('roof_limited');
  if (targetKw > site.maxSystemKw) flags.push('max_system_size_limited');
  if (pkg.kw > input.sanctionedLoadKw + 1e-9) flags.push('sanctioned_load_exceeded');
  if (Math.abs(pkg.kw - site.sweetSpotKw) < 1e-9) flags.push('sweet_spot');

  // 5. Generation
  const g = normalise(site.generationMonthlyProfile);
  const year1Kwh = specificYield * pkg.kw * (1 - site.degradation.firstYearPct / 100);
  const monthlyGen = g.map((f) => (year1Kwh / 12) * f);
  note(
    'first_year_degradation',
    'First-year degradation (%)',
    site.degradation.firstYearPct,
    'site',
  );
  note(
    'annual_degradation',
    'Annual degradation after year 1 (%)',
    site.degradation.annualPct,
    'site',
  );

  // 6. Price
  if (pricebook.placeholder) flags.push('placeholder_prices');
  const subtotal = pkg.lines.reduce((a, l) => a + l.amountPaise, 0);
  const gst =
    round(subtotal * pricebook.gst.goodsShare * (pricebook.gst.goodsRatePct / 100)) +
    round(subtotal * (1 - pricebook.gst.goodsShare) * (pricebook.gst.servicesRatePct / 100));
  const total = subtotal + gst;
  note(
    'gst',
    'GST: goods share / goods rate / services rate',
    `${pricebook.gst.goodsShare} / ${pricebook.gst.goodsRatePct}% / ${pricebook.gst.servicesRatePct}%`,
    'pricebook',
  );
  note('price_valid_until', 'Prices valid until', pricebook.validUntil, 'pricebook');

  // 7. Subsidy
  const schemes = subsidy.schemes.map((s) => {
    const eligible = !s.requiresDcr || pkg.module.dcr;
    return {
      id: s.id,
      label: s.label,
      eligible,
      reason: eligible ? null : 'Requires DCR (made-in-India) modules',
      amountPaise: eligible ? subsidyFor(s.slabs, pkg.kw, s.capPaise) : 0,
      recipient: s.recipient,
    };
  });
  const subsidyTotal = schemes.reduce((a, s) => a + s.amountPaise, 0);
  const recipients = new Set(schemes.filter((s) => s.amountPaise > 0).map((s) => s.recipient));
  const recipient = recipients.size > 1 ? 'mixed' : ([...recipients][0] ?? 'customer');
  note(
    'subsidy_rules',
    'Subsidy rules',
    subsidy.schemes.map((s) => s.label).join(' + '),
    'subsidy',
  );

  // 8. Finance
  const finance: FinanceOption[] = [
    {
      id: 'cash',
      label: 'Pay in full',
      loanPaise: 0,
      payNowPaise: total,
      emiPaise: null,
      annualRatePct: null,
      tenorMonths: null,
      illustrative: false,
    },
  ];
  for (const p of lenders.products) {
    if (pkg.kw < p.minSystemKw - 1e-9 || pkg.kw > p.maxSystemKw + 1e-9) continue;
    const loan = Math.min(
      p.maxLoanPaise,
      Math.floor((total * (1 - p.marginPct / 100)) / 100) * 100,
    );
    finance.push({
      id: p.id,
      label: p.label,
      loanPaise: loan,
      payNowPaise: total - loan,
      emiPaise: emi(loan, p.annualRatePct, p.tenorMonths),
      annualRatePct: p.annualRatePct,
      tenorMonths: p.tenorMonths,
      illustrative: true,
    });
    if (p.placeholder && !flags.includes('placeholder_lender_terms'))
      flags.push('placeholder_lender_terms');
  }

  // 9. Savings
  const netCost = total - subsidyTotal;
  const base = lifetimeSavings(
    bundle,
    category,
    input.sanctionedLoadKw,
    consumption,
    monthlyGen,
    1,
  );
  note('tariff', 'Tariff category', `${input.tariffCategory} (${category.label})`, 'tariff');
  note('tariff_escalation', 'Assumed yearly tariff increase (%)', site.tariffEscalationPct, 'site');
  note(
    'net_metering_settlement',
    'Payment per unused banked kWh at year end (paise)',
    tariff.netMetering.excessSettlementPaisePerKwh,
    'tariff',
  );
  const scenarios: Scenario[] = [
    site.scenarioYieldFactors.low,
    1,
    site.scenarioYieldFactors.high,
  ].map((f) => {
    const run =
      f === 1
        ? base
        : lifetimeSavings(bundle, category, input.sanctionedLoadKw, consumption, monthlyGen, f);
    return {
      yieldFactor: f,
      year1SavingsPaise: round(run.yearly[0]!),
      paybackYears: paybackYears(netCost, run.yearly),
    };
  });

  return {
    calcVersion: CALC_VERSION,
    grade: input.grade,
    sizing: {
      annualConsumptionKwh: round(annualConsumptionKwh),
      monthsOfData,
      specificYieldKwhPerKwp: specificYield,
      targetKw: round2(targetKw),
      roofCapKw: roofCapKw != null ? round2(roofCapKw) : null,
      recommendedKw: pkg.kw,
    },
    system: {
      packageId: pkg.id,
      kw: pkg.kw,
      moduleSku: pkg.module.sku,
      moduleWp: pkg.module.wp,
      moduleCount: pkg.module.count,
      dcr: pkg.module.dcr,
      inverterSku: pkg.inverter.sku,
      inverterKw: pkg.inverter.kw,
    },
    generation: { year1Kwh: round(year1Kwh), monthlyKwh: monthlyGen.map(round) },
    price: {
      lines: pkg.lines.map((l) => ({ ...l })),
      subtotalPaise: subtotal,
      gstPaise: gst,
      totalPaise: total,
    },
    subsidy: {
      schemes: schemes.map(({ recipient: _r, ...s }) => s),
      totalPaise: subsidyTotal,
      recipient,
    },
    netCostAfterSubsidyPaise: netCost,
    finance,
    savings: {
      monthlyBillBeforePaise: base.first.before.map(round),
      monthlyBillAfterPaise: base.first.after.map(round),
      year1SavingsPaise: round(base.yearly[0]!),
      lifetimeSavingsPaise: round(base.yearly.reduce((a, b) => a + b, 0)),
      lifetimeYears: site.lifetimeYears,
      paybackYears: paybackYears(netCost, base.yearly),
      scenarios,
    },
    flags,
    assumptions,
  };
}
