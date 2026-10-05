import { expect, test } from '@playwright/test';
import { ADMIN } from './global-setup';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

test('lead with bill → ops enters readings → project qualifies', async ({ page }) => {
  // Customer submits the lead form with a bill.
  await page.goto('/');
  await page.getByLabel('Your name').fill('Asha Verma');
  await page.getByLabel('Mobile number').fill('98765 43210');
  await page.getByLabel('City / town').fill('Agra');
  await page
    .getByLabel(/Electricity bill/)
    .setInputFiles({ name: 'bill.pdf', mimeType: 'application/pdf', buffer: PDF });
  await page.getByLabel(/agree to be contacted/).check();
  await page.getByRole('button', { name: 'Get my free assessment' }).click();
  await expect(page.getByRole('heading', { name: /we’ve got it/ })).toBeVisible();

  // Ops console requires sign-in.
  await page.goto('/ops');
  await expect(page).toHaveURL(/\/ops\/login/);
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // The new lead is on the dashboard.
  await expect(page.getByText('New leads today')).toBeVisible();
  const row = page.getByRole('row', { name: /Asha Verma/ });
  await expect(row).toContainText('Lead');
  await row.getByRole('link', { name: /SOL-/ }).click();

  // QUALIFIED is gated on bill readings.
  const qualify = page.locator('form', { hasText: '→ Qualified' });
  await expect(qualify.getByRole('button', { name: 'Move' })).toBeDisabled();

  // The bill opens for staff.
  const billLink = page.getByRole('link', { name: 'bill.pdf' });
  const res = await page.request.get((await billLink.getAttribute('href'))!);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('application/pdf');

  await page.getByLabel('Tariff category').fill('LMV-1');
  await page.getByLabel('Account / consumer number').fill('1234567890');
  await page.getByLabel('Sanctioned load (kW)').fill('3');
  await page.getByLabel('Period start').fill('2026-08-01');
  await page.getByLabel('Period end').fill('2026-08-31');
  await page.getByLabel('Units (kWh)').fill('420');
  await page.getByLabel('Bill amount (₹)').fill('3150');
  await page.getByRole('button', { name: 'Save readings and confirm bill' }).click();
  await expect(page.getByText('Bill readings saved.')).toBeVisible();

  await page
    .locator('form', { hasText: '→ Qualified' })
    .getByRole('button', { name: 'Move' })
    .click();
  await expect(page.getByText('Moved to QUALIFIED.')).toBeVisible();
  await expect(page.locator('.timeline')).toContainText('stage changed LEAD → QUALIFIED');

  // Complete the first-contact task with effort captured.
  const task = page.locator('form', { hasText: 'Call Asha Verma' });
  await task.getByPlaceholder('Minutes spent').fill('6');
  await task.getByPlaceholder('Outcome').fill('Explained process');
  await task.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('Task completed.')).toBeVisible();
});

test('unauthenticated users cannot read bills', async ({ request }) => {
  const res = await request.get('/ops/files/bills/bil_doesnotexist', { maxRedirects: 0 });
  expect(res.status()).toBe(401);
});

test('lead form validates consent and phone', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Your name').fill('Test');
  await page.getByLabel('Mobile number').fill('12345');
  await page.getByRole('button', { name: 'Get my free assessment' }).click();
  await expect(page.locator('.alert.error')).toContainText(/agree to be contacted/);
  await page.getByLabel(/agree to be contacted/).check();
  await page.getByRole('button', { name: 'Get my free assessment' }).click();
  await expect(page.locator('.alert.error')).toContainText(/valid 10-digit/);
  await expect(page.getByLabel('Mobile number')).toHaveValue('12345');
});
