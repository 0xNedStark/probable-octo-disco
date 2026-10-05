/**
 * Normalise an Indian mobile number to E.164 (+91XXXXXXXXXX). Returns null if it
 * is not a plausible Indian mobile (10 digits starting 6-9).
 */
export function normaliseIndianMobile(input: string): string | null {
  let digits = input.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (!/^[6-9]\d{9}$/.test(digits)) return null;
  return `+91${digits}`;
}
