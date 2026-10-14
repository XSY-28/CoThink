import { expect, it } from "vitest";
import { FinalResultSchema, type FinalResult } from "@onevcat/argue";
import { renderFinalResult } from "../../src/discussion/render.js";

const formats = ["txt", "md", "json", "html"] as const;
const internalRecords = {
  rounds: [{ rawContent: "INTERNAL_DISCUSSION_SENTINEL" }],
  extraDiagnostics: "INTERNAL_DISCUSSION_SENTINEL"
};
const answer = "Original answer.\n\n  Preserve indentation and <syntax> & quotes.\n";
const result: FinalResult = {
  resultVersion: "discussion.result.v1",
  sessionId: "session-render",
  segmentId: 2,
  outcome: "consensus",
  answer,
  selectedAnswerVersionIds: ["answer-a-3"],
  importantDissent: [
    {
      objectionId: "objection-b-1",
      authorId: "member-b",
      targetAnswerVersionId: "answer-a-3",
      targetClaimVersionId: "claim-a-2",
      severity: "material",
      summary: "Capacity remains uncertain.",
      impact: "Production load may exceed capacity.",
      evidenceNeeded: "Measure peak throughput."
    }
  ],
  limitations: ["Public limitation: synthetic evidence only.", "No live benchmark."],
  reviewEpochId: 3,
  reviewSetHash: "review-hash"
};

it.each(["txt", "md"] as const)(
  "keeps the original selected answer, limitations and necessary dissent in %s",
  (format) => {
    const output = renderFinalResult(result, format);
    expect(output).toContain(answer);
    expect(output).toContain("consensus");
    for (const value of [
      ...result.limitations,
      "session-render",
      "2",
      "member-b",
      "material",
      "Capacity remains uncertain.",
      "Production load may exceed capacity.",
      "Measure peak throughput."
    ])
      expect(output).toContain(value);
  }
);

it.each(formats)("renders weighted fallback distinctly in %s without claiming consensus", (format) => {
  const output = renderFinalResult({ ...result, outcome: "weighted_fallback" }, format);
  expect(output).toContain("weighted_fallback");
  expect(output).not.toContain("consensus");
});

it.each(["txt", "md", "html"] as const)(
  "does not invent important dissent for an empty fallback result in %s",
  (format) => {
    const output = renderFinalResult({ ...result, outcome: "weighted_fallback", importantDissent: [] }, format);
    expect(output).toContain("Selected by decision preference.");
    expect(output).not.toMatch(/important dissent/i);
  }
);

it.each(["txt", "md", "html"] as const)(
  "shows real tied alternatives and their individual limitations in %s",
  (format) => {
    const output = renderFinalResult(
      {
        ...result,
        outcome: "tied_preferences",
        answer: "",
        selectedAnswerVersionIds: ["answer-a-3", "answer-b-4"],
        limitations: ["Preferences remain tied."],
        alternatives: [
          {
            authorId: "member-a",
            answerVersionId: "answer-a-3",
            body: "Choose local deployment.",
            limitations: ["Local storage required."]
          },
          {
            authorId: "member-b",
            answerVersionId: "answer-b-4",
            body: "Choose hosted deployment.",
            limitations: ["Network connection required."]
          }
        ]
      },
      format
    );
    for (const value of [
      "tied_preferences",
      "member-a",
      "member-b",
      "Choose local deployment.",
      "Choose hosted deployment.",
      "Local storage required.",
      "Network connection required.",
      "Preferences remain tied."
    ])
      expect(output).toContain(value);
    expect(output).not.toContain(answer);
  }
);

it.each(["txt", "md", "html"] as const)("omits implementation source references from human output in %s", (format) => {
  const tied: FinalResult = {
    ...result,
    outcome: "tied_preferences",
    answer: "",
    selectedAnswerVersionIds: ["answer-a-3", "answer-b-4"],
    alternatives: [
      { authorId: "member-a", answerVersionId: "answer-a-3", body: "Local deployment.", limitations: [] },
      { authorId: "member-b", answerVersionId: "answer-b-4", body: "Hosted deployment.", limitations: [] }
    ]
  };
  for (const value of [result, tied]) {
    const output = renderFinalResult(value, format);
    for (const internalReference of ["review-hash", "answer-a-3", "answer-b-4", "objection-b-1", "claim-a-2"])
      expect(output).not.toContain(internalReference);
    expect(output).not.toMatch(
      /Source review:|Review set:|Source answers?:|Source objection:|Target answer:|Target claim:/
    );
    expect(output).toContain("Session: session-render | Segment: 2");
    expect(output).toContain("Capacity remains uncertain.");
    expect(output).toContain("Production load may exceed capacity.");
    expect(output).toContain("Measure peak throughput.");
    expect(output).toContain("member-b");
    expect(output).toContain("material");
  }
});

it.each([
  "missing_valid_answer",
  "incomplete_review",
  "abnormal_stop",
  "discussion_continues",
  "round_limit_not_reached",
  "constraint_failed"
] as const)("keeps incomplete reason %s and recovery limitations", (incompleteReason) => {
  const incomplete: FinalResult = {
    resultVersion: "discussion.result.v1",
    sessionId: "session-render",
    segmentId: 2,
    outcome: "incomplete",
    answer: "",
    selectedAnswerVersionIds: [],
    importantDissent: [],
    limitations: ["Saved successfully. Run an explicit retry."],
    incompleteReason,
    ...(incompleteReason === "missing_valid_answer" ? { missingAnswerMemberIds: ["member-b"] } : {}),
    ...(incompleteReason === "constraint_failed" ? { failedCheckIds: ["check-host-1"] } : {})
  };
  for (const format of formats) {
    const output = renderFinalResult(incomplete, format);
    expect(output).toContain("incomplete");
    expect(output).toContain(incompleteReason);
    expect(output).toContain("Saved successfully. Run an explicit retry.");
    expect(output).toContain("session-render");
    if (incomplete.missingAnswerMemberIds) expect(output).toContain("member-b");
    if (incomplete.failedCheckIds) expect(output).toContain("check-host-1");
  }
});

it("serializes a single complete FinalResult object without wrappers or internal records", () => {
  const fixture = { finalResult: result, internalRecords };
  const output = renderFinalResult(fixture.finalResult, "json");
  expect(JSON.parse(output)).toEqual(result);
  expect(FinalResultSchema.parse(JSON.parse(output))).toEqual(result);
  expect(output).not.toContain("INTERNAL_DISCUSSION_SENTINEL");
});

it.each(formats)("does not consume records outside FinalResult in %s", (format) => {
  const fixture = { finalResult: result, internalRecords };
  expect(renderFinalResult(fixture.finalResult, format)).not.toContain("INTERNAL_DISCUSSION_SENTINEL");
});

it("renders every dynamic HTML field as escaped text without executable markup or a hidden payload", () => {
  const attack = '<script>alert("x")</script><img src=x onerror="alert(1)">&\'';
  const hostile: FinalResult = {
    ...result,
    sessionId: attack,
    answer: attack,
    selectedAnswerVersionIds: [attack],
    reviewSetHash: attack,
    limitations: [attack],
    importantDissent: [
      {
        ...result.importantDissent[0]!,
        objectionId: attack,
        authorId: attack,
        targetAnswerVersionId: attack,
        targetClaimVersionId: attack,
        summary: attack,
        impact: attack,
        evidenceNeeded: attack
      }
    ]
  };
  const output = renderFinalResult(hostile, "html");
  expect(output).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  expect(output).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;");
  expect(output).not.toMatch(
    /<script|<img|<iframe|<form|<input|<a\b|<details|hidden|display\s*:\s*none|application\/json/i
  );
  expect(output).toContain("<!doctype html>");
});

it.each(formats)("rejects unknown FinalResult fields and never echoes their values in %s errors", (format) => {
  const invalid = [
    { ...result, internalRecords },
    { ...result, importantDissent: [{ ...result.importantDissent[0], extraDiagnostics: internalRecords }] },
    Object.assign(Object.create({ extraDiagnostics: internalRecords }), result),
    {
      ...result,
      importantDissent: [
        Object.assign(Object.create({ extraDiagnostics: internalRecords }), result.importantDissent[0])
      ]
    },
    { ...result, outcome: "INTERNAL_DISCUSSION_SENTINEL" },
    { ...result, answer: "", selectedAnswerVersionIds: [] },
    { ...result, sessionId: "" },
    Object.defineProperty({ ...result }, "extraDiagnostics", { value: internalRecords }),
    { ...result, limitations: [""] }
  ];
  for (const raw of invalid) {
    let failure: unknown;
    try {
      renderFinalResult(raw as FinalResult, format);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toMatch(/SENTINEL|extraDiagnostics|rawContent|unrecognized_keys|issues/);
  }
});
