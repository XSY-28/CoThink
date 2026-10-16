import type { CartSummary } from "./domain.js";
export function calculateCart(input: unknown): CartSummary {
  if (!Array.isArray(input)) throw new Error("E_INPUT");
  const lines: CartSummary["lines"] = [];
  let totalCents = 0;
  for (const item of input) {
    if (
      item === null ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof item.label !== "string" ||
      !Number.isSafeInteger(item.unitCents) ||
      item.unitCents < 0 ||
      !Number.isSafeInteger(item.qty) ||
      item.qty <= 0
    )
      throw new Error("E_INPUT");
    const amountCents = item.unitCents * item.qty;
    if (!Number.isSafeInteger(amountCents) || !Number.isSafeInteger(totalCents + amountCents))
      throw new Error("E_INPUT");
    totalCents += amountCents;
    lines.push({ label: item.label, qty: item.qty, amountCents });
  }
  return { totalCents, lines };
}
