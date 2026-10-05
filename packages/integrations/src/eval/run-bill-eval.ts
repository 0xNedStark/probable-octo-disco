/**
 * Bill Agent eval (PLAN §8 gate: ≥95% field accuracy before auto-quoting).
 *
 * Usage: AI_BILL_EXTRACTION=on pnpm --filter @solar/integrations eval:bills <dir> [threshold]
 * <dir> holds bill files (pdf/jpg/png/webp) with a sibling <name>.json label each,
 * using the BillLabel shape. Bills are personal data: keep the set out of git.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { billExtractorFromEnv } from '../ai/bill-extractor';
import { checkBillFile } from '../uploads';
import { scoreBill, summarise, type BillLabel, type FieldScore } from './score';

const [dir, thresholdArg] = process.argv.slice(2);
if (!dir) throw new Error('usage: eval:bills <dir> [threshold]');
const threshold = Number(thresholdArg ?? 0.9);
const extractor = billExtractorFromEnv();
if (!extractor)
  throw new Error('Set AI_BILL_EXTRACTION=on (and Anthropic credentials) to run the eval.');

const files = (await readdir(dir)).filter((f) => /\.(pdf|jpe?g|png|webp)$/i.test(f)).sort();
const all: FieldScore[][] = [];
const perBill: Record<string, unknown> = {};
for (const f of files) {
  const name = basename(f, extname(f));
  const label = JSON.parse(await readFile(join(dir, `${name}.json`), 'utf8')) as BillLabel;
  const body = new Uint8Array(await readFile(join(dir, f)));
  const kind = checkBillFile(body);
  if (!kind.ok) throw new Error(`${f}: ${kind.error}`);
  const r = await extractor.extract(body, kind.contentType as 'application/pdf');
  const scores = scoreBill(label, r.extraction);
  all.push(scores);
  perBill[name] = {
    outcome: r.outcome,
    model: r.model,
    latencyMs: r.latencyMs,
    tokens: [r.inputTokens, r.outputTokens],
    scores,
  };
  console.log(
    `${name}: ${scores.filter((s) => s.correct).length}/${scores.length} correct (${r.outcome}, ${r.latencyMs} ms)`,
  );
}
const summary = summarise(all, threshold);
console.log(JSON.stringify(summary, null, 2));
const out = join(dir, `eval-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await writeFile(out, JSON.stringify({ threshold, summary, perBill }, null, 2));
console.log(`report written to ${out}`);
