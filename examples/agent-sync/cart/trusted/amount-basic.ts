import type { Item, CartSummary } from "./domain.js";
export function calculateCart(input: unknown): CartSummary {
  const lines = (input as Item[]).map((item) => ({
    label: item.label,
    qty: item.qty,
    amountCents: item.unitCents * item.qty
  }));
  return { lines, totalCents: lines.reduce((sum, line) => sum + line.amountCents, 0) };
}
