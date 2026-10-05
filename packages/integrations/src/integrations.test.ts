import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LogNotifier, maskPhone } from './notifier';
import { LocalStorage, sha256 } from './storage';
import { checkBillFile, MAX_BILL_BYTES } from './uploads';

const bytes = (...b: number[]) => new Uint8Array(b);

describe('checkBillFile', () => {
  it('identifies files by content', () => {
    expect(checkBillFile(new TextEncoder().encode('%PDF-1.7 ...'))).toMatchObject({
      ok: true,
      ext: 'pdf',
    });
    expect(checkBillFile(bytes(0xff, 0xd8, 0xff, 0xe0))).toMatchObject({
      ok: true,
      contentType: 'image/jpeg',
    });
    expect(checkBillFile(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toMatchObject({
      ok: true,
      ext: 'png',
    });
    expect(checkBillFile(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toMatchObject({
      ok: true,
      ext: 'webp',
    });
  });

  it('rejects empty, oversized and unknown files', () => {
    expect(checkBillFile(bytes()).ok).toBe(false);
    expect(checkBillFile(new Uint8Array(MAX_BILL_BYTES + 1)).ok).toBe(false);
    expect(checkBillFile(new TextEncoder().encode('<html>')).ok).toBe(false);
  });
});

describe('LocalStorage', () => {
  let dir = '';
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('round-trips, refuses overwrites and path traversal', async () => {
    dir = await mkdtemp(join(tmpdir(), 'solar-storage-'));
    const s = new LocalStorage(dir);
    await s.put('bills/2026/a.pdf', bytes(1, 2, 3), 'application/pdf');
    expect([...(await s.get('bills/2026/a.pdf'))]).toEqual([1, 2, 3]);
    await expect(s.put('bills/2026/a.pdf', bytes(9), 'application/pdf')).rejects.toThrow();
    await expect(s.get('../etc/passwd')).rejects.toThrow(/Invalid storage key/);
  });

  it('hashes content', () => {
    expect(sha256(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('notifier', () => {
  it('masks phone numbers in logs', async () => {
    const lines: string[] = [];
    await new LogNotifier((l) => lines.push(l)).send({
      id: 'x',
      channel: 'whatsapp',
      template: 'lead_received',
      recipient: '+919876543210',
      payload: {},
    });
    expect(lines[0]).toContain('+9198XXXXXX10');
    expect(maskPhone('+919876543210')).toBe('+9198XXXXXX10');
  });
});
