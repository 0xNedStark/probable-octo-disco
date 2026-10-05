import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { calculate, CALC_VERSION, type CalcInput } from './engine';
import { canonicalJson } from './hash';
import { UP_DVVNL_SEED } from './seed';

/**
 * Golden cases: any change to calculation output must be deliberate. Regenerate
 * with UPDATE_GOLDEN=1 only together with a CALC_VERSION bump (PLAN §7).
 */
const FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '__golden__',
  `calc-${CALC_VERSION}.json`,
);
const versions = {
  site: 'site@1',
  tariff: 'tariff@1',
  subsidy: 'subsidy@1',
  pricebook: 'pricebook@1',
  lenders: 'lenders@1',
};

function cases(): { name: string; input: CalcInput }[] {
  const out: { name: string; input: CalcInput }[] = [];
  const monthlyLevels = [80, 180, 300, 450, 700, 1200];
  const loads = [2, 3, 7];
  const roofs = [undefined, 22, 60];
  for (const units of monthlyLevels) {
    for (const load of loads) {
      for (const roof of roofs) {
        out.push({
          name: `${units}kwh-${load}kw-roof${roof ?? 'na'}`,
          input: {
            grade: 'INDICATIVE',
            city: 'Agra',
            tariffCategory: 'LMV-1-URBAN',
            sanctionedLoadKw: load,
            // Single summer bill when roof is unknown; a full year otherwise.
            monthlyUsage:
              roof === undefined
                ? [{ month: '2026-07', units }]
                : Array.from({ length: 12 }, (_, i) => ({
                    month: `2025-${String(i + 1).padStart(2, '0')}`,
                    units,
                  })),
            roofAreaM2: roof,
          },
        });
      }
    }
  }
  return out;
}

it(`matches golden outputs for calc ${CALC_VERSION} (${cases().length} cases)`, () => {
  const actual = Object.fromEntries(
    cases().map((c) => [
      c.name,
      JSON.parse(canonicalJson(calculate(c.input, UP_DVVNL_SEED, versions))),
    ]),
  );
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(FILE)) {
    if (!process.env.UPDATE_GOLDEN && process.env.CI)
      throw new Error(`Missing golden file ${FILE}`);
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(actual, null, 1) + '\n');
  }
  const expected = JSON.parse(readFileSync(FILE, 'utf8'));
  expect(Object.keys(actual)).toHaveLength(54);
  expect(actual).toEqual(expected);
});
