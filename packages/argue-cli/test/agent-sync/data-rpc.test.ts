import { describe, it, expect } from "vitest";
import { encode, decode, readEnvelope } from "../../../../tools/agent-sync-validator/protocol.mjs";
const limits = { maxDepth: 8, maxElements: 32, maxRpcBytes: 1024, maxResultBytes: 1024 };
describe("bounded data RPC", () => {
  it("preserves tagged undefined, nonfinite numbers, Unicode and inert passed data", () => {
    const value = { a: undefined, b: [NaN, Infinity, -Infinity, -0, "你好"], passed: true };
    expect(decode(encode(value, limits), limits)).toEqual(value);
  });
  it("rejects unbounded input and prototype payloads", () => {
    expect(() => encode(Array(33).fill(0), limits)).toThrow();
    expect(() => encode(new Date(), limits)).toThrow();
    expect(() =>
      decode(
        [
          "object",
          [
            ["a", ["number", "1"]],
            ["a", ["number", "2"]]
          ]
        ],
        limits
      )
    ).toThrow();
  });
  it("rejects duplicate/extra fields, identity mismatch and truncation", () => {
    const request = {
      rpcVersion: "agent-sync-data-rpc-v1",
      requestId: "id",
      operationId: "read",
      input: ["number", "1"]
    };
    const good = {
      rpcVersion: request.rpcVersion,
      requestId: "id",
      operationId: "read",
      ok: true,
      value: ["number", "1"]
    };
    expect(readEnvelope(JSON.stringify(good), request, limits)).toEqual(1);
    for (const text of [
      JSON.stringify({ ...good, extra: true }),
      JSON.stringify({ ...good, requestId: "other" }),
      '{"rpcVersion":"bad","rpcVersion":"agent-sync-data-rpc-v1"}',
      JSON.stringify(good).slice(0, -1)
    ])
      expect(() => readEnvelope(text, request, limits)).toThrow();
  });
});
