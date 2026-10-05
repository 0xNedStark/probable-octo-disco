import { describe, expect, it } from 'vitest';
import { CONFIG_KINDS, parseConfig, type ConfigBundle, type ConfigVersions } from './config';
import {
  calculate,
  CalcError,
  monthlyBillPaise,
  monthlyConsumption,
  type CalcInput,
} from './engine';
import { canonicalJson, hashConfig } from './hash';
import { UP_DVVNL_SEED } from './seed';

const versions: ConfigVersions = {
  site: 'site@1',
  tariff: 'tariff@1',
  subsidy: 'subsidy@1',
  pricebook: 'pricebook@1',
  lenders: 'lenders@1',
};
const bundle = UP_DVVNL_SEED;
const year = (units: number) =>
  Array.from({ length: 12 }, (_, i) => ({
    month: `2025-${String(i + 1).padStart(2, '0')}`,
    units,
  }));

function input(overrides: Partial<CalcInput> = {}): CalcInput {
  return {
    grade: 'INDICATIVE',
    city: 'Agra',
    tariffCategory: 'LMV-1-URBAN',
    sanctionedLoadKw: 5,
    monthlyUsage: year(400),
    ...overrides,
  };
}

describe('seed config', () => {
  it('validates against every schema', () => {
    for (const kind of CONFIG_KINDS) expect(() => parseConfig(kind, bundle[kind])).not.toThrow();
  });
});

describe('monthlyBillPaise', () => {
  it('applies telescopic slabs, fixed charge, duty and meter rent', () => {
    const cat = bundle.tariff.categories['LMV-1-URBAN']!;
    // 150×5.50 + 150×6.00 + 100×6.50 = 2375; + 3 kW × 110 = 2705; × 1.05 = 2840.25; + 20 meter rent
    expect(monthlyBillPaise(cat, 400, 3)).toBeCloseTo(286025, 6);
    // Zero units still pays fixed charge, duty and meter rent.
    expect(monthlyBillPaise(cat, 0, 3)).toBeCloseTo(33000 * 1.05 + 2000, 6);
  });
});

describe('monthlyConsumption', () => {
  it('uses actuals with 12 months of history', () => {
    const r = monthlyConsumption(year(300), bundle.site.consumptionSeasonality);
    expect(r).toEqual({ monthly: new Array(12).fill(300), monthsOfData: 12 });
  });

  it('de-seasonalises a single summer bill instead of annualising it naively', () => {
    const r = monthlyConsumption(
      [{ month: '2026-06', units: 600 }],
      bundle.site.consumptionSeasonality,
    );
    const annual = r.monthly.reduce((a, b) => a + b, 0);
    expect(r.monthsOfData).toBe(1);
    expect(annual).toBeLessThan(600 * 12);
    expect(r.monthly[5]).toBeCloseTo(600, 6); // June reproduces the actual
  });

  it('keeps the latest reading when a calendar month repeats', () => {
    const r = monthlyConsumption(
      [...year(100), { month: '2026-01', units: 220 }],
      bundle.site.consumptionSeasonality,
    );
    expect(r.monthly[0]).toBe(220);
  });

  it('rejects bad input', () => {
    expect(() => monthlyConsumption([], bundle.site.consumptionSeasonality)).toThrow(CalcError);
    expect(() =>
      monthlyConsumption([{ month: '2026-13', units: 1 }], bundle.site.consumptionSeasonality),
    ).toThrow(/month/);
    expect(() =>
      monthlyConsumption([{ month: '2026-01', units: -1 }], bundle.site.consumptionSeasonality),
    ).toThrow(/units/);
  });
});

describe('calculate — 3 kW reference case', () => {
  const out = calculate(input(), bundle, versions);

  it('sizes 4,800 kWh/year to the 3 kW sweet spot', () => {
    expect(out.sizing.annualConsumptionKwh).toBe(4800);
    expect(out.sizing.targetKw).toBeCloseTo(3.31, 2);
    expect(out.system).toMatchObject({ kw: 3, moduleCount: 6, dcr: true });
    expect(out.flags).toContain('sweet_spot');
    expect(out.flags).toContain('placeholder_prices');
  });

  it('prices with the 70:30 GST split', () => {
    expect(out.price.subtotalPaise).toBe(18_100_000);
    expect(out.price.gstPaise).toBe(633_500 + 977_400);
    expect(out.price.totalPaise).toBe(19_710_900);
  });

  it('applies central and UP subsidies with caps', () => {
    expect(out.subsidy.schemes.map((s) => s.amountPaise)).toEqual([7_800_000, 3_000_000]);
    expect(out.subsidy).toMatchObject({ totalPaise: 10_800_000, recipient: 'customer' });
    expect(out.netCostAfterSubsidyPaise).toBe(19_710_900 - 10_800_000);
  });

  it('offers cash and the SBI ≤3 kW loan with a standard EMI', () => {
    expect(out.finance.map((f) => f.id)).toEqual(['cash', 'sbi-psg-upto3kw']);
    const sbi = out.finance[1]!;
    expect(sbi.loanPaise).toBe(17_739_800); // 90% of ₹1,97,109, floored to the rupee
    expect(sbi.payNowPaise).toBe(19_710_900 - 17_739_800);
    const r = 0.07 / 12;
    const expected = (177398 * r * (1 + r) ** 120) / ((1 + r) ** 120 - 1);
    expect(sbi.emiPaise).toBe(Math.round(expected) * 100);
    expect(sbi.illustrative).toBe(true);
  });

  it('produces savings, payback and ordered scenarios', () => {
    expect(out.savings.monthlyBillBeforePaise).toHaveLength(12);
    expect(out.savings.year1SavingsPaise).toBeGreaterThan(0);
    expect(out.savings.paybackYears).toBeGreaterThan(1);
    expect(out.savings.paybackYears).toBeLessThan(10);
    const [low, mid, high] = out.savings.scenarios;
    expect(low!.year1SavingsPaise).toBeLessThan(mid!.year1SavingsPaise);
    expect(mid!.year1SavingsPaise).toBeLessThan(high!.year1SavingsPaise);
    expect(mid!.year1SavingsPaise).toBe(out.savings.year1SavingsPaise);
  });

  it('records the source of every assumption', () => {
    for (const a of out.assumptions)
      expect(['input', ...Object.values(versions)]).toContain(a.source);
    expect(out.assumptions.find((a) => a.key === 'specific_yield')?.source).toBe('site@1');
  });
});

describe('calculate — constraints and flags', () => {
  it('limits size by roof area', () => {
    const out = calculate(input({ roofAreaM2: 25 }), bundle, versions);
    expect(out.system.kw).toBe(2);
    expect(out.flags).toContain('roof_limited');
  });

  it('flags systems above sanctioned load', () => {
    const out = calculate(input({ sanctionedLoadKw: 2 }), bundle, versions);
    expect(out.system.kw).toBe(3);
    expect(out.flags).toContain('sanctioned_load_exceeded');
  });

  it('caps at the maximum system size', () => {
    const out = calculate(input({ monthlyUsage: year(3000) }), bundle, versions);
    expect(out.system.kw).toBe(10);
    expect(out.flags).toContain('max_system_size_limited');
  });

  it('uses the smallest package for low consumption', () => {
    const out = calculate(input({ monthlyUsage: year(60) }), bundle, versions);
    expect(out.system.kw).toBe(2);
    expect(out.flags).toContain('consumption_below_smallest_package');
  });

  it('gives no subsidy for non-DCR modules', () => {
    const nonDcr: ConfigBundle = structuredClone(bundle);
    for (const p of nonDcr.pricebook.packages) p.module.dcr = false;
    const out = calculate(input(), nonDcr, versions);
    expect(out.subsidy.totalPaise).toBe(0);
    expect(out.subsidy.schemes.every((s) => !s.eligible && s.reason)).toBe(true);
  });

  it('honours a package override', () => {
    const out = calculate(input({ packageId: 'dcr-5kw' }), bundle, versions);
    expect(out.system.kw).toBe(5);
    expect(out.flags).toContain('package_override');
    expect(out.finance.map((f) => f.id)).toEqual(['cash', 'sbi-rooftop-3-10kw']);
    expect(() => calculate(input({ packageId: 'nope' }), bundle, versions)).toThrow(
      /Unknown package/,
    );
  });

  it('rejects unknown tariff categories and bad loads', () => {
    expect(() => calculate(input({ tariffCategory: 'X' }), bundle, versions)).toThrow(/tariff/);
    expect(() => calculate(input({ sanctionedLoadKw: 0 }), bundle, versions)).toThrow(/Sanctioned/);
  });

  it('year-1 savings never fall as the system grows (heavy consumer)', () => {
    let prev = -1;
    for (const p of bundle.pricebook.packages) {
      const s = calculate(
        input({ monthlyUsage: year(1500), sanctionedLoadKw: 10, packageId: p.id }),
        bundle,
        versions,
      ).savings.year1SavingsPaise;
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });

  it('is deterministic', () => {
    expect(canonicalJson(calculate(input(), bundle, versions))).toBe(
      canonicalJson(calculate(input(), structuredClone(bundle), versions)),
    );
  });
});

describe('hashConfig', () => {
  it('ignores key order but not values', () => {
    expect(hashConfig({ a: 1, b: { c: 2, d: 3 } })).toBe(hashConfig({ b: { d: 3, c: 2 }, a: 1 }));
    expect(hashConfig({ a: 1 })).not.toBe(hashConfig({ a: 2 }));
  });
});
