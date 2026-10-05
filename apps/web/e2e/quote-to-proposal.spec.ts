import { expect, test, type Page } from '@playwright/test';
import { ADMIN } from './global-setup';

async function signIn(page: Page) {
  await page.goto('/ops/login');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('New leads today')).toBeVisible();
}

test('quote: placeholder prices block sending; real prices → send → customer proposal → accept', async ({
  page,
  browser,
}) => {
  // Lead with a bill.
  await page.goto('/');
  await page.getByLabel('Your name').fill('Ravi Kumar');
  await page.getByLabel('Mobile number').fill('91234 56789');
  await page.getByLabel(/Electricity bill/).setInputFiles({
    name: 'bill.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n%%EOF\n'),
  });
  await page.getByLabel(/agree to be contacted/).check();
  await page.getByRole('button', { name: 'Get my free assessment' }).click();
  await expect(page.getByRole('heading', { name: /we’ve got it/ })).toBeVisible();

  await signIn(page);
  await page
    .getByRole('row', { name: /Ravi Kumar/ })
    .getByRole('link', { name: /SOL-/ })
    .click();
  await page.waitForURL(/\/ops\/projects\//);
  const projectUrl = page.url();

  // No quote before the bill is confirmed.
  await expect(page.getByText('Confirm the bill readings first.')).toBeVisible();
  await page.getByLabel('Tariff category', { exact: true }).fill('LMV-1');
  await page.getByLabel('Account / consumer number').fill('9988776655');
  await page.getByLabel('Sanctioned load (kW)').fill('5');
  await page.getByLabel('Period start').fill('2026-08-01');
  await page.getByLabel('Period end').fill('2026-08-31');
  await page.getByLabel('Units (kWh)').fill('400');
  await page.getByLabel('Bill amount (₹)').fill('2900');
  await page.getByLabel(/Monthly history/).fill('2026-07: 450\n2026-06: 520');
  await page.getByRole('button', { name: 'Save readings and confirm bill' }).click();
  await expect(page.getByText('Bill readings saved.')).toBeVisible();

  // Placeholder price book: quote calculates but cannot be sent.
  await page.getByRole('button', { name: 'Calculate quote' }).click();
  await expect(page.getByText('Quote calculated.')).toBeVisible();
  await expect(page.getByText(/v1 · indicative · 3 kW/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send to customer' })).toBeDisabled();
  await expect(page.getByText(/Can’t send: .*placeholder/)).toBeVisible();

  // Staff preview reproduces exactly.
  await page.getByRole('link', { name: 'Preview proposal' }).click();
  await expect(page.getByText('Reproduced exactly from stored inputs and config')).toBeVisible();
  await expect(page.getByText(/Placeholder prices: not for customers/)).toBeVisible();

  // Admin publishes real prices.
  await page.goto('/ops/config');
  const pb = page.locator('section', { hasText: 'Price book' });
  await pb.getByText('View / publish new version').click();
  const textarea = pb.getByLabel('pricebook JSON');
  await textarea.fill(
    (await textarea.inputValue()).replace('"placeholder": true', '"placeholder": false'),
  );
  await pb.getByPlaceholder('What changed and why').fill('Supplier quotes received');
  await pb.getByRole('button', { name: /Publish pricebook/ }).click();
  await expect(page.getByText(/Published pricebook v2/)).toBeVisible();

  // Re-quote and send.
  await page.goto(projectUrl);
  await page.getByText('New quote').click();
  await page.getByRole('button', { name: 'Calculate quote' }).click();
  await expect(page.getByText(/v2 · indicative/)).toBeVisible();
  await expect(page.getByText('superseded')).toBeVisible();
  await page.getByRole('button', { name: 'Send to customer' }).click();
  const flash = page.getByText(/Customer link \(copy now, shown once\)/);
  await expect(flash).toBeVisible();
  const link = (await flash.textContent())!.match(/(http\S+\/p\/[\w-]+)/)![1]!;

  // Customer opens the link in a fresh, signed-out browser.
  const customer = await (await browser.newContext()).newPage();
  await customer.goto(link);
  await expect(
    customer.getByRole('heading', { name: /Ravi, here is your 3 kW rooftop solar proposal/ }),
  ).toBeVisible();
  await expect(customer.getByRole('cell', { name: 'PM Surya Ghar central subsidy' })).toBeVisible();
  await expect(customer.getByText(/credits ₹1,08,000 directly to your bank account/)).toBeVisible();
  await expect(
    customer.getByRole('cell', { name: 'SBI rooftop solar loan (up to 3 kW)' }),
  ).toBeVisible();
  await expect(customer.getByText(/Staff preview/)).toHaveCount(0);

  // Ops records acceptance; the view shows on the timeline.
  await page.reload();
  await expect(page.locator('.timeline')).toContainText('proposal viewed');
  await page.getByPlaceholder('How did the customer confirm?').fill('Said yes on WhatsApp');
  await page.getByRole('button', { name: 'Record acceptance' }).click();
  await expect(page.getByText('Acceptance recorded.')).toBeVisible();
  await expect(
    page.locator('details', { hasText: 'Customer accepted indicative quote' }).locator('.badge.ok'),
  ).toBeVisible();
});

test('unknown proposal links 404', async ({ page }) => {
  const res = await page.goto('/p/not-a-real-token-1234567890');
  expect(res?.status()).toBe(404);
});
