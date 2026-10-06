import { expect, test, type Page } from '@playwright/test';
import { UP_DVVNL_SEED } from '@solar/calc';
import {
  createDb,
  createLead,
  enterBillReadings,
  generateQuote,
  publishConfig,
  schema,
  sendQuote,
  sql,
  type ServiceActor,
} from '@solar/db';
import { newId } from '@solar/domain';
import { createHmac } from 'node:crypto';
import { E2E_DATABASE_URL, E2E_WHATSAPP_SECRET } from '../playwright.config';
import { ADMIN } from './global-setup';

const { db, close } = createDb(E2E_DATABASE_URL, { max: 2 });
test.afterAll(close);

async function signIn(page: Page) {
  await page.goto('/ops/login');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('New leads today')).toBeVisible();
}

/** A project with a sent indicative quote, set up through the services. Returns the proposal URL. */
async function sentProposal(phone: string, name: string) {
  const [admin] = await db.execute<{ id: string }>(
    sql`select id from users where email = ${ADMIN.email}`,
  );
  const actor: ServiceActor = { type: 'user', id: admin!.id, role: 'admin' };
  await publishConfig(
    db,
    actor,
    'pricebook',
    { ...UP_DVVNL_SEED.pricebook, placeholder: false },
    'e2e: real prices',
  );
  const billId = newId('bill');
  const { projectId, projectCode } = await createLead(db, {
    name,
    phone,
    city: 'Agra',
    source: 'web',
    consent: { contact: true, whatsapp: true, textVersion: 'e2e', channel: 'web' },
    bill: {
      id: billId,
      storageKey: `bills/e2e/${billId}.pdf`,
      originalFilename: 'bill.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
      sha256: 'e2e',
    },
  });
  await enterBillReadings(db, actor, projectId, {
    billId,
    consumerNumber: '5556667778',
    discom: 'DVVNL',
    tariffCategory: 'LMV-1-URBAN',
    sanctionedLoadKw: 5,
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    unitsKwh: 420,
    amountRupees: 3150,
    monthlyHistory: [],
  });
  const q = await generateQuote(db, actor, projectId, { grade: 'INDICATIVE' });
  const { url } = await sendQuote(db, actor, q.id, 'http://localhost:3100');
  // Leave the shared e2e database with the placeholder price book other specs expect.
  await publishConfig(db, actor, 'pricebook', UP_DVVNL_SEED.pricebook, 'e2e: restore placeholder');
  return { projectId, projectCode, url };
}

async function latestOtp(projectId: string): Promise<string> {
  const rows = await db
    .select()
    .from(schema.outbox)
    .where(sql`${schema.outbox.projectId} = ${projectId} and ${schema.outbox.template} = 'otp'`);
  return String(rows.at(-1)!.payload.code);
}

test('customer accepts with OTP, pays the booking token, project is booked and trackable', async ({
  page,
  browser,
}) => {
  const { projectId, projectCode, url } = await sentProposal('9811122233', 'Meera Singh');
  const customer = await (await browser.newContext()).newPage();
  await customer.goto(url);

  await expect(customer.getByText('Accept this proposal and book your survey')).toBeVisible();
  await expect(customer.getByText(/Booking token: ₹5,000/)).toBeVisible();
  await customer.getByRole('button', { name: 'Send me a confirmation code' }).click();
  await expect(customer.locator('.alert.error')).toContainText(/tick the box/);
  await customer.getByLabel(/I accept this proposal and the refund terms/).check();
  await customer.getByRole('button', { name: 'Send me a confirmation code' }).click();
  await expect(
    customer.getByText(/We sent a 6-digit code on WhatsApp to \+91••••••33/),
  ).toBeVisible();

  await customer.getByLabel('Confirmation code').fill('000000');
  await customer.getByRole('button', { name: /Confirm and continue/ }).click();
  const code = await latestOtp(projectId);
  if (code !== '000000') await expect(customer.locator('.alert.error')).toContainText(/not right/);
  await customer.getByLabel('Confirmation code').fill(code);
  await customer.getByRole('button', { name: /Confirm and continue/ }).click();

  // Dev gateway checkout → signed webhook → booked.
  await expect(customer.getByText('Test payment gateway')).toBeVisible();
  await customer.getByRole('button', { name: /Pay ₹5,000.00 \(simulated UPI\)/ }).click();
  await expect(customer.getByRole('heading', { name: /Payment received/ })).toBeVisible();
  await customer.getByRole('link', { name: 'Track your project' }).click();
  await expect(customer.getByRole('heading', { name: /Namaste Meera/ })).toBeVisible();
  await expect(customer.getByRole('heading', { name: 'Booked' })).toBeVisible();
  await expect(customer.getByText('₹5,000 ·')).toBeVisible();

  // Ops sees the booked project with payment, ledger balance and a survey task.
  await signIn(page);
  await page
    .getByRole('row', { name: new RegExp(projectCode) })
    .getByRole('link', { name: projectCode })
    .click();
  await expect(page.locator('h1 + .row .badge').first()).toHaveText('Booked');
  await expect(page.getByText(/Held for customer: ₹5,000.00/)).toBeVisible();
  await expect(page.getByText('Schedule site survey').first()).toBeVisible();
  await expect(page.locator('.timeline')).toContainText('payment received');

  // Finance: SBI loan path through to sanction sets funds secured.
  await page.getByRole('button', { name: 'Set finance path' }).click();
  await expect(page.getByText('Finance path set.')).toBeVisible();
  await page.getByPlaceholder('Bank / JanSamarth reference').fill('JS-2026-001');
  await page.getByRole('button', { name: 'Mark submitted' }).click();
  await page.getByPlaceholder('Sanctioned ₹').fill('177398');
  await page.getByRole('button', { name: 'Mark sanctioned' }).click();
  await expect(page.getByText('Loan updated.')).toBeVisible();
  await expect(
    page.locator('details', { hasText: 'Funds secured' }).locator('.badge.ok'),
  ).toBeVisible();

  // The proposal link now shows it as accepted.
  await customer.goto(url);
  await expect(customer.getByText('You accepted this proposal.')).toBeVisible();
});

test('payment webhook rejects bad signatures', async ({ request }) => {
  const res = await request.post('/api/webhooks/payments', {
    data: { event: 'payment_link.paid' },
    headers: { 'x-razorpay-signature': 'deadbeef' },
  });
  expect(res.status()).toBe(401);
});

test('inbound WhatsApp creates a lead; staff reply from the console', async ({ page, request }) => {
  const body = JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: '919700011122', profile: { name: 'Sunil Yadav' } }],
              messages: [
                {
                  id: `wamid.e2e.${Date.now()}`,
                  from: '919700011122',
                  type: 'text',
                  text: { body: 'Solar lagwana hai, kitna kharcha hoga?' },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const sig = `sha256=${createHmac('sha256', E2E_WHATSAPP_SECRET).update(body).digest('hex')}`;
  const bad = await request.post('/api/webhooks/whatsapp', {
    data: body,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00' },
  });
  expect(bad.status()).toBe(401);
  const ok = await request.post('/api/webhooks/whatsapp', {
    data: body,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
  });
  expect(await ok.json()).toEqual({ recorded: 1 });
  const again = await request.post('/api/webhooks/whatsapp', {
    data: body,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
  });
  expect(await again.json()).toEqual({ recorded: 0 });

  await signIn(page);
  await page
    .getByRole('row', { name: /Sunil Yadav/ })
    .getByRole('link', { name: /SOL-/ })
    .click();
  await expect(page.getByText('via whatsapp')).toBeVisible();
  await expect(page.getByText('Solar lagwana hai, kitna kharcha hoga?')).toBeVisible();
  await page
    .getByPlaceholder('Reply to the customer…')
    .fill('Namaste Sunil! Please send a photo of your latest electricity bill.');
  await page.getByRole('button', { name: 'Send on WhatsApp' }).click();
  await expect(page.getByText('Reply queued on WhatsApp.')).toBeVisible();
});
