import type { CartSummary } from "./domain.js";
export function renderReceipt(summary: CartSummary): string {
  return `total: $${(summary.totalCents / 100).toFixed(2)}\n`;
}
