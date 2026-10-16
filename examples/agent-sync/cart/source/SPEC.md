# Tiny cart

`calculateCart(unknown)` returns `CartSummary`. Preserve item order and labels, multiply unitCents by qty, and sum the amounts. Empty input returns zero and no lines.

Accept only arrays of objects with a string label (including empty strings), a nonnegative safe integer unitCents, and a positive safe integer qty. Reject invalid values, unsafe products, and unsafe sums by throwing Error("E_INPUT"). No coercion. No coupons, taxes, or currency conversion.

`renderReceipt(CartSummary)` returns each line as `label xqty: $amount` followed by `total: $amount`, always with two decimal places and a trailing newline. All valid safe integer cents, including Number.MAX_SAFE_INTEGER, must format exactly.

Example: pen at 250 cents times 2 and book at 750 cents times 1 gives `pen x2: $5.00\nbook x1: $7.50\ntotal: $12.50\n`. Empty input gives `total: $0.00\n`.
