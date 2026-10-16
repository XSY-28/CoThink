import { expect, test } from "vitest";
import { BuildCheckReceiptSchema, BuildPublishReceiptSchema, hashBuildValue } from "@onevcat/argue";
const H = hashBuildValue("context"),
  V = "a".repeat(40);
const check = {
  checkVersion: "build-check-v1",
  receiptId: "check",
  attemptId: "attempt",
  candidateHash: H,
  checksHash: H,
  groups: ["common"],
  toolchainHash: H,
  isolationHash: H,
  exitCode: 0,
  passed: true
};
test("new check context is complete, immutable-source and fixed-digest evidence", () => {
  expect(BuildCheckReceiptSchema.safeParse({ ...check, baseVersion: V }).success).toBe(false);
  const full = {
    ...check,
    baseVersion: V,
    version: V,
    planHash: H,
    imageDigest: `fixture@sha256:${"b".repeat(64)}`,
    sourceHashBefore: H,
    sourceHashAfter: H
  };
  expect(BuildCheckReceiptSchema.safeParse(full).success).toBe(true);
  expect(BuildCheckReceiptSchema.safeParse({ ...full, imageDigest: "node:latest" }).success).toBe(false);
  expect(BuildCheckReceiptSchema.safeParse({ ...full, sourceHashAfter: hashBuildValue("changed") }).success).toBe(
    false
  );
});
test("publication requires complete request, owner, input and verifier binding together", () => {
  const old = {
    publishVersion: "build-publish-v1",
    receiptId: "publish",
    attemptId: "attempt",
    requestId: "finish",
    checkReceiptId: "check",
    baseVersion: V,
    acceptedVersion: V,
    candidateHash: H,
    checksHash: H
  };
  expect(BuildPublishReceiptSchema.safeParse(old).success).toBe(true);
  expect(BuildPublishReceiptSchema.safeParse({ ...old, requestHash: H }).success).toBe(false);
  expect(
    BuildPublishReceiptSchema.safeParse({
      ...old,
      requestHash: H,
      planHash: H,
      ownerEpoch: 1,
      leaseEpoch: 1,
      inputHash: H,
      overlayHash: H,
      toolchainHash: H,
      isolationHash: H,
      imageDigest: `fixture@sha256:${"b".repeat(64)}`
    }).success
  ).toBe(true);
});
