export interface Item {
  label: string;
  unitCents: number;
  qty: number;
}
export interface CartSummary {
  totalCents: number;
  lines: { label: string; qty: number; amountCents: number }[];
}
