'use client';

export function PrintButton() {
  return (
    <button type="button" className="secondary no-print" onClick={() => window.print()}>
      Save as PDF / print
    </button>
  );
}
