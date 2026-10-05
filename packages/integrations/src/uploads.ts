export const MAX_BILL_BYTES = 10 * 1024 * 1024;

const SIGNATURES: { type: string; ext: string; magic: number[]; offset?: number }[] = [
  { type: 'application/pdf', ext: 'pdf', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  { type: 'image/jpeg', ext: 'jpg', magic: [0xff, 0xd8, 0xff] },
  { type: 'image/png', ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: 'image/webp', ext: 'webp', magic: [0x57, 0x45, 0x42, 0x50], offset: 8 }, // RIFF....WEBP
];

export type BillFileCheck =
  { ok: true; contentType: string; ext: string } | { ok: false; error: string };

/**
 * Identify a bill upload by its bytes, not the browser-supplied MIME type or name.
 * Accepts PDF, JPEG, PNG and WebP up to 10 MB.
 */
export function checkBillFile(body: Uint8Array): BillFileCheck {
  if (body.byteLength === 0) return { ok: false, error: 'The file is empty.' };
  if (body.byteLength > MAX_BILL_BYTES)
    return { ok: false, error: 'The file is larger than 10 MB.' };
  for (const sig of SIGNATURES) {
    const offset = sig.offset ?? 0;
    if (sig.magic.every((b, i) => body[offset + i] === b)) {
      return { ok: true, contentType: sig.type, ext: sig.ext };
    }
  }
  return { ok: false, error: 'Upload a PDF or a photo (JPG, PNG or WebP) of your bill.' };
}
