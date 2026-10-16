import type { CartSummary } from "./domain.js";
function money(cents: number): string {
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
export function renderReceipt(summary: CartSummary): string {
  return (
    summary.lines.map((line) => `${line.label} x${line.qty}: $${money(line.amountCents)}\n`).join("") +
    `total: $${money(summary.totalCents)}\n`
  );
}
