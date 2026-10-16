import assert from "node:assert/strict";
export const sample = [
  { label: "pen", unitCents: 250, qty: 2 },
  { label: "book", unitCents: 750, qty: 1 }
];
export const summary = {
  totalCents: 1250,
  lines: [
    { label: "pen", qty: 2, amountCents: 500 },
    { label: "book", qty: 1, amountCents: 750 }
  ]
};
export const text = "pen x2: $5.00\nbook x1: $7.50\ntotal: $12.50\n";
export const caseIds = {
  money: ["quantity-order-total", "empty", "zero-and-empty-label", "safe-boundary"],
  lines: ["nonzero-lines", "empty", "safe-boundary"],
  invalid: ["not-array", "not-object", "label-type", "unit-domain", "qty-domain", "product-overflow", "sum-overflow"],
  joint: ["joint-1250-cents", "joint-empty", "joint-safe-boundary"],
  zero: ["zero-only"]
};
export default async function oracle(ctx) {
  const {
    invoke,
    parameters: { group }
  } = ctx;
  const run = (id, fn) => ctx.case(id, fn);
  if (group === "money") {
    await run("quantity-order-total", () => assert.deepEqual(invoke("amount", sample), summary));
    await run("empty", () => assert.deepEqual(invoke("amount", []), { totalCents: 0, lines: [] }));
    await run("zero-and-empty-label", () =>
      assert.deepEqual(invoke("amount", [{ label: "", unitCents: 0, qty: 2 }]), {
        totalCents: 0,
        lines: [{ label: "", qty: 2, amountCents: 0 }]
      })
    );
    await run("safe-boundary", () => {
      for (const cents of [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1])
        assert.equal(invoke("amount", [{ label: "edge", unitCents: cents, qty: 1 }]).totalCents, cents);
    });
  } else if (group === "lines") {
    await run("nonzero-lines", () => assert.equal(invoke("receipt", summary), text));
    await run("empty", () => assert.equal(invoke("receipt", { totalCents: 0, lines: [] }), "total: $0.00\n"));
    await run("safe-boundary", () => {
      for (const [cents, expected] of [
        [9007199254740991, "90071992547409.91"],
        [9007199254740990, "90071992547409.90"]
      ])
        assert.equal(
          invoke("receipt", { totalCents: cents, lines: [{ label: "edge", qty: 1, amountCents: cents }] }),
          `edge x1: $${expected}\ntotal: $${expected}\n`
        );
    });
  } else if (group === "invalid") {
    const rejects = (inputs) => {
      for (const input of inputs) assert.throws(() => invoke("amount", input), /^Error: E_INPUT$/);
    };
    await run("not-array", () => rejects([null, {}, "items", 1]));
    await run("not-object", () => rejects([[null], [1], ["x"], [[]]]));
    await run("label-type", () => rejects([[{ unitCents: 1, qty: 1 }], [{ label: 1, unitCents: 1, qty: 1 }]]));
    await run("unit-domain", () =>
      rejects([-1, 0.5, NaN, Infinity, 9007199254740992, "1"].map((unitCents) => [{ label: "x", unitCents, qty: 1 }]))
    );
    await run("qty-domain", () =>
      rejects([0, -1, 0.5, NaN, Infinity, 9007199254740992, "1"].map((qty) => [{ label: "x", unitCents: 1, qty }]))
    );
    await run("product-overflow", () => rejects([[{ label: "x", unitCents: Number.MAX_SAFE_INTEGER, qty: 2 }]]));
    await run("sum-overflow", () =>
      rejects([
        [
          { label: "x", unitCents: Number.MAX_SAFE_INTEGER, qty: 1 },
          { label: "y", unitCents: 1, qty: 1 }
        ]
      ])
    );
  } else if (group === "joint") {
    await run("joint-1250-cents", () => assert.equal(invoke("receipt", invoke("amount", sample)), text));
    await run("joint-empty", () => assert.equal(invoke("receipt", invoke("amount", [])), "total: $0.00\n"));
    await run("joint-safe-boundary", () =>
      assert.equal(
        invoke("receipt", invoke("amount", [{ label: "edge", unitCents: Number.MAX_SAFE_INTEGER, qty: 1 }])),
        "edge x1: $90071992547409.91\ntotal: $90071992547409.91\n"
      )
    );
  } else if (group === "zero") {
    await run("zero-only", () => assert.equal(invoke("receipt", { totalCents: 0, lines: [] }), "total: $0.00\n"));
  } else throw new Error("UNKNOWN_CART_GROUP");
}
