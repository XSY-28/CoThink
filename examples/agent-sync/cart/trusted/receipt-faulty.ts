import type { CartSummary } from "./domain.js";
export function renderReceipt(summary: CartSummary): string {
  return (
    summary.lines.map((line) => `${line.label} x${line.qty}: $${line.amountCents.toFixed(2)}\n`).join("") +
    `total: $${summary.totalCents.toFixed(2)}\n`
  );
}
