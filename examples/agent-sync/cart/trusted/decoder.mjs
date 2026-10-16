// The data bridge deliberately decodes records with null prototypes. Normalize
// trusted checker data recursively, retaining all fields for exact assertions.
function plainData(value) {
  if (Array.isArray(value)) return value.map(plainData);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plainData(item)]));
  return value;
}
export function amount(value) {
  if (
    !value ||
    typeof value !== "object" ||
    !Number.isSafeInteger(value.totalCents) ||
    value.totalCents < 0 ||
    !Array.isArray(value.lines)
  )
    throw new Error("CART_RESULT");
  for (const line of value.lines)
    if (
      !line ||
      typeof line.label !== "string" ||
      !Number.isSafeInteger(line.qty) ||
      line.qty <= 0 ||
      !Number.isSafeInteger(line.amountCents) ||
      line.amountCents < 0
    )
      throw new Error("CART_LINE");
  return plainData(value);
}
export function receipt(value) {
  if (typeof value !== "string") throw new Error("CART_RECEIPT");
  return value;
}
