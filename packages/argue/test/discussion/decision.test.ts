import { expect, it } from "vitest";
import {
  createDiscussionSession,
  applyDiscussionBatch,
  freezeDiscussionReview,
  resumeDiscussionAfterReview,
  sealDiscussionReply
} from "../../src/discussion/protocol.js";
import { latestDiscussionAnswers } from "../../src/discussion/answers.js";
import { selectFinalResult, consensusAnswerContentHash } from "../../src/discussion/decision.js";
import {
  parseFinalResultSources,
  FinalResultSchema,
  discussionConstraintContextHash,
  type ConstraintCheck
} from "../../src/discussion/result.js";
import type { DiscussionSession, DiscussionAction, DiscussionReviewTurn } from "../../src/discussion/contracts.js";
import { openingTurn, exchangeTurn, reviewTurn, discussionEnvelope } from "./stage2-fixtures.js";

function reviewed(
  weights: Record<string, { decisionWeight: number; participationWeight?: number }> = {
    a: { decisionWeight: 1 },
    b: { decisionWeight: 9 }
  },
  options: {
    memberIds?: string[];
    rounds?: number;
    maxRounds?: number;
    actions?: Readonly<Record<string, readonly DiscussionAction[]>>;
    transform?: (turn: DiscussionReviewTurn, id: string) => unknown;
    allAccept?: boolean;
    sameBody?: boolean;
  } = {}
): DiscussionSession {
  const ids = options.memberIds ?? Object.keys(weights),
    rounds = options.rounds ?? 1;
  let state = createDiscussionSession({
    sessionId: "selection-test",
    question: "Q",
    memberIds: ids,
    policy: { weights, maxRounds: options.maxRounds ?? rounds }
  });
  state = applyDiscussionBatch(
    state,
    ids.map((id) => discussionEnvelope(state, id, openingTurn()))
  );
  for (let round = 0; round < rounds; round++) {
    state = applyDiscussionBatch(
      state,
      ids.map((id) => {
        const template = exchangeTurn(state, id, round === 0 ? (options.actions?.[id] ?? []) : []);
        return discussionEnvelope(state, id, {
          ...template,
          answer: {
            ...template.answer,
            body: options.sameBody ? "Identical saved text" : `Saved ${id} answer ${state.roundIndex}  \n`,
            limitations: [`Saved limit ${id}`]
          }
        });
      })
    );
  }
  state = freezeDiscussionReview(state);
  return applyDiscussionBatch(
    state,
    ids.map((id) => {
      const turn = reviewTurn(state, id);
      const signed = {
        ...turn,
        positions: turn.positions.map((position) =>
          position.kind === "answer" && !options.allAccept
            ? {
                ...position,
                stance:
                  state.reviewEpochs
                    .at(-1)!
                    .answerVersions.find((answer) => answer.answerVersionId === position.answerVersionId)!.authorId ===
                  id
                    ? "accept"
                    : "reject"
              }
            : position
        )
      } as DiscussionReviewTurn;
      return discussionEnvelope(state, id, options.transform?.(signed, id) ?? signed);
    })
  );
}
function check(
  state: DiscussionSession,
  answerVersionId: string | null,
  status: "failed" | "passed" = "failed"
): ConstraintCheck {
  return {
    checkId: "host-check",
    source: "host",
    contextHash: discussionConstraintContextHash(state),
    answerVersionId,
    status,
    evidence: "Synthetic executable check trace"
  };
}
function objectionAction(): DiscussionAction {
  return {
    kind: "object",
    objection: {
      targetAnswerVersionId: "selection-test:s1:member:b:answer:v1",
      severity: "material",
      summary: "Initial concern",
      impact: "Initial impact",
      evidenceNeeded: "Initial check"
    }
  };
}
function final(state: DiscussionSession, stopReason: "round_limit" | "checkpoint" | "budget_limit" = "round_limit") {
  return selectFinalResult({ session: state, stopReason });
}

it("falls back to the highest decision preference's last committed answer, preserving exact body bytes", () => {
  const state = reviewed(),
    winner = latestDiscussionAnswers(state).find((answer) => answer.authorId === "b")!;
  const result = final(state);
  expect(result.outcome).toBe("weighted_fallback");
  expect(result.answer).toBe(winner.body);
  expect(result.answer).not.toBe(state.answerVersions.find((answer) => answer.authorId === "b")!.body);
  expect(result.selectedAnswerVersionIds).toEqual([winner.answerVersionId]);
  expect(result.limitations).toEqual(winner.limitations);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.selectedAnswerVersionIds)).toBe(true);
});
it("swapping only decision preferences changes source while preserving the discussion record", () => {
  const b = reviewed(),
    a = reviewed({ a: { decisionWeight: 9 }, b: { decisionWeight: 1 } });
  expect(a.committedBatches).toEqual(b.committedBatches);
  expect(a.reviewEpochs).toEqual(b.reviewEpochs);
  expect(final(a).answer).toBe(latestDiscussionAnswers(a)[0]!.body);
  expect(final(b).answer).toBe(latestDiscussionAnswers(b)[1]!.body);
});
it("participation weights do not select a winner", () => {
  const state = reviewed({
    a: { decisionWeight: 1, participationWeight: 100 },
    b: { decisionWeight: 9, participationWeight: 0.1 }
  });
  expect(final(state).answer).toBe(latestDiscussionAnswers(state).find((answer) => answer.authorId === "b")!.body);
});
it("does not pick a fixed member when highest preferences tie", () => {
  const state = reviewed({ a: { decisionWeight: 1 }, b: { decisionWeight: 1 } }),
    result = final(state);
  expect(result.outcome).toBe("tied_preferences");
  expect(result.answer).toBe("");
  expect(result.selectedAnswerVersionIds).toEqual(
    latestDiscussionAnswers(state).map((answer) => answer.answerVersionId)
  );
  expect(result.alternatives!.map((answer) => answer.body)).toEqual(
    latestDiscussionAnswers(state).map((answer) => answer.body)
  );
});
it("keeps all highest preferences in a three-member tie and no lower alternative", () => {
  const state = reviewed({ c: { decisionWeight: 7 }, a: { decisionWeight: 7 }, b: { decisionWeight: 1 } }),
    result = final(state);
  expect(result.outcome).toBe("tied_preferences");
  expect(result.alternatives!.map((answer) => answer.authorId)).toEqual(["a", "c"]);
});
it("allows consensus before the round limit and never substitutes a preferred but unaccepted answer", () => {
  const state = reviewed(undefined, {
    maxRounds: 3,
    transform: (turn) => ({
      ...turn,
      positions: turn.positions.map((position) =>
        position.kind === "answer"
          ? { ...position, stance: position.answerVersionId.includes(":member:a:") ? "accept" : "reject" }
          : position
      )
    })
  });
  expect(final(state, "checkpoint").outcome).toBe("consensus");
  expect(final(state, "checkpoint").answer).toBe(latestDiscussionAnswers(state)[0]!.body);
});
it("chooses preference only among fully confirmed consensus candidates", () => {
  const state = reviewed(undefined, { allAccept: true }),
    result = final(state, "checkpoint");
  expect(result.outcome).toBe("consensus");
  expect(result.answer).toBe(latestDiscussionAnswers(state)[1]!.body);
});
it("uses a deterministic saved-content hash for equally preferred accepted candidates", () => {
  const state = reviewed({ a: { decisionWeight: 1 }, b: { decisionWeight: 1 } }, { allAccept: true });
  const sorted = [...latestDiscussionAnswers(state)].sort((a, b) =>
    consensusAnswerContentHash(a) < consensusAnswerContentHash(b) ? -1 : 1
  );
  expect(final(state, "checkpoint").outcome).toBe("consensus");
  expect(final(state, "checkpoint").selectedAnswerVersionIds).toEqual([sorted[0]!.answerVersionId]);
  expect(final(state, "checkpoint")).toEqual(final(state, "checkpoint"));
});
it("a non-consensus checkpoint cannot pretend it normally reached the cap", () => {
  const state = reviewed(undefined, { maxRounds: 3 });
  expect(final(state, "checkpoint").incompleteReason).toBe("discussion_continues");
  expect(final(state).incompleteReason).toBe("round_limit_not_reached");
});
it.each(["interrupted", "deadline", "model_failure"] as const)(
  "returns incomplete on %s, not a weighted fallback",
  (stopReason) => {
    expect(selectFinalResult({ session: reviewed(), stopReason })).toMatchObject({
      outcome: "incomplete",
      answer: "",
      selectedAnswerVersionIds: [],
      incompleteReason: "abnormal_stop"
    });
  }
);
it("requires a current complete review and never promotes a sealed response", () => {
  const original = createDiscussionSession({
    sessionId: "partial",
    question: "Q",
    memberIds: ["a", "b"],
    policy: { weights: { a: { decisionWeight: 9 }, b: { decisionWeight: 1 } } }
  });
  const sealed = sealDiscussionReply(original, discussionEnvelope(original, "a", openingTurn()));
  expect(final(sealed)).toMatchObject({
    outcome: "incomplete",
    answer: "",
    selectedAnswerVersionIds: [],
    incompleteReason: "missing_valid_answer"
  });
  const state = reviewed(),
    resumed = resumeDiscussionAfterReview(state);
  expect(final(resumed).incompleteReason).toBe("incomplete_review");
});
it("uses the new answer version after a later complete review, not opening or an older confirmation", () => {
  const state = reviewed(undefined, { rounds: 2 });
  const winner = latestDiscussionAnswers(state).find((answer) => answer.authorId === "b")!;
  expect(final(state).selectedAnswerVersionIds).toEqual([winner.answerVersionId]);
  expect(winner.answerVersionId.endsWith(":v3")).toBe(true);
});
it("preserves low-preference dissent from its owner's final review and never reuses initial wording", () => {
  const state = reviewed(undefined, {
    actions: { a: [objectionAction()] },
    transform: (turn, id) =>
      id !== "a"
        ? turn
        : {
            ...turn,
            positions: turn.positions.map((position) =>
              position.kind === "objection"
                ? {
                    ...position,
                    summary: "Owner's latest concern",
                    impact: "Owner's latest impact",
                    evidenceNeeded: "Owner's latest test"
                  }
                : position
            )
          }
  });
  expect(final(state).outcome).toBe("weighted_fallback");
  expect(final(state).importantDissent).toHaveLength(1);
  expect(final(state).importantDissent[0]).toMatchObject({
    authorId: "a",
    summary: "Owner's latest concern",
    impact: "Owner's latest impact",
    evidenceNeeded: "Owner's latest test",
    targetAnswerVersionId: state.objections[0]!.targetAnswerVersionId
  });
});
it("preserves different objection IDs with identical text instead of similarity deduplication", () => {
  const same = objectionAction();
  const state = reviewed(
    { a: { decisionWeight: 1 }, b: { decisionWeight: 9 }, c: { decisionWeight: 1 } },
    { actions: { a: [same], c: [same] } }
  );
  expect(final(state).importantDissent).toHaveLength(2);
  expect(new Set(final(state).importantDissent.map((item) => item.objectionId)).size).toBe(2);
});
it("owner-resolved dissent does not appear as unresolved in the result", () => {
  const state = reviewed(undefined, {
    actions: { a: [objectionAction()] },
    transform: (turn, id) =>
      id !== "a"
        ? turn
        : {
            ...turn,
            positions: turn.positions.map((position) =>
              position.kind === "objection" ? { ...position, status: "resolved" } : position
            )
          }
  });
  expect(final(state).importantDissent).toEqual([]);
});
it("known failure for the preferred answer prevents fallback to an unpreferred member", () => {
  const state = reviewed(),
    id = latestDiscussionAnswers(state)[1]!.answerVersionId;
  const result = selectFinalResult({ session: state, stopReason: "round_limit", constraintChecks: [check(state, id)] });
  expect(result).toMatchObject({
    outcome: "incomplete",
    answer: "",
    selectedAnswerVersionIds: [],
    incompleteReason: "constraint_failed",
    failedCheckIds: ["host-check"]
  });
});
it("known global failure prevents even unanimous consensus", () => {
  const state = reviewed(undefined, { allAccept: true });
  expect(
    selectFinalResult({ session: state, stopReason: "checkpoint", constraintChecks: [check(state, null)] }).outcome
  ).toBe("incomplete");
});
it("rejects stale and unknown constraint evidence rather than applying it to a new version", () => {
  const state = reviewed(),
    current = latestDiscussionAnswers(state)[1]!.answerVersionId;
  for (const evidence of [
    { ...check(state, current), contextHash: "old" },
    check(state, "forged"),
    check(state, state.answerVersions[0]!.answerVersionId)
  ])
    expect(() =>
      selectFinalResult({ session: state, stopReason: "round_limit", constraintChecks: [evidence] })
    ).toThrow(/scope/i);
});
it("cannot forge result text, a foreign dissent author or paraphrase an owner's summary", () => {
  const state = reviewed(undefined, { actions: { a: [objectionAction()] } }),
    result = final(state);
  expect(() => parseFinalResultSources({ ...result, answer: "Invented conclusion" }, state)).toThrow(/content/i);
  expect(() =>
    parseFinalResultSources({ ...result, importantDissent: [{ ...result.importantDissent[0], authorId: "b" }] }, state)
  ).toThrow(/author/i);
  expect(() =>
    parseFinalResultSources(
      { ...result, importantDissent: [{ ...result.importantDissent[0], summary: "Paraphrased" }] },
      state
    )
  ).toThrow(/author/i);
});
it("rejects duplicate result IDs and a fake combined tied answer", () => {
  const state = reviewed({ a: { decisionWeight: 1 }, b: { decisionWeight: 1 } }),
    result = final(state);
  expect(() => FinalResultSchema.parse({ ...result, answer: "A combined new conclusion" })).toThrow();
  expect(() =>
    FinalResultSchema.parse({
      ...result,
      selectedAnswerVersionIds: [result.selectedAnswerVersionIds[0], result.selectedAnswerVersionIds[0]]
    })
  ).toThrow();
});
it("rejects invalid runtime stop reason and does not mutate valid input", () => {
  const state = reviewed(),
    before = JSON.stringify(state);
  final(state);
  expect(JSON.stringify(state)).toBe(before);
  expect(() => selectFinalResult({ session: state, stopReason: "model_said_consensus" as never })).toThrow();
});
it("allows explicit normal budget stop only with a complete review", () => {
  const state = reviewed(undefined, { maxRounds: 3 });
  expect(final(state, "budget_limit").outcome).toBe("weighted_fallback");
  expect(final(resumeDiscussionAfterReview(state), "budget_limit").outcome).toBe("incomplete");
});
it("a known failure in one tied preferred answer cannot silently remove it and select the other", () => {
  const state = reviewed({ a: { decisionWeight: 1 }, b: { decisionWeight: 1 } });
  const result = selectFinalResult({
    session: state,
    stopReason: "round_limit",
    constraintChecks: [check(state, latestDiscussionAnswers(state)[1]!.answerVersionId)]
  });
  expect(result).toMatchObject({ outcome: "incomplete", answer: "", selectedAnswerVersionIds: [] });
});
it("a failed alternative does not block a different unanimously accepted and valid candidate", () => {
  const state = reviewed(undefined, { allAccept: true });
  const result = selectFinalResult({
    session: state,
    stopReason: "checkpoint",
    constraintChecks: [check(state, latestDiscussionAnswers(state)[1]!.answerVersionId)]
  });
  expect(result.outcome).toBe("consensus");
  expect(result.selectedAnswerVersionIds).toEqual([latestDiscussionAnswers(state)[0]!.answerVersionId]);
});
it("retains every blocking objection but excludes unrelated material objections during fallback", () => {
  const material: DiscussionAction = {
    kind: "object",
    objection: {
      targetAnswerVersionId: "selection-test:s1:member:c:answer:v1",
      severity: "material",
      summary: "Alternative concern",
      impact: "Impact",
      evidenceNeeded: "Check"
    }
  };
  const blocking: DiscussionAction = { ...material, objection: { ...material.objection, severity: "blocking" } };
  const weights = { a: { decisionWeight: 1 }, b: { decisionWeight: 9 }, c: { decisionWeight: 1 } };
  expect(final(reviewed(weights, { actions: { a: [material] } })).importantDissent).toEqual([]);
  expect(final(reviewed(weights, { actions: { a: [blocking] } })).importantDissent).toHaveLength(1);
});
it("does not manufacture consensus from identical answer bodies with distinct own-version votes", () => {
  const state = reviewed({ a: { decisionWeight: 1 }, b: { decisionWeight: 1 } }, { sameBody: true }),
    result = final(state);
  expect(result.outcome).toBe("tied_preferences");
  expect(result.alternatives![0]!.body).toBe(result.alternatives![1]!.body);
  const forged = {
    ...result,
    alternatives: result.alternatives!.map((item) => ({ ...item, body: "Identical invented text" }))
  };
  expect(() => parseFinalResultSources(forged, state)).toThrow(/saved version/i);
});
it("rejects duplicate or model-sourced host check metadata", () => {
  const state = reviewed(),
    evidence = check(state, null, "passed");
  expect(() =>
    selectFinalResult({ session: state, stopReason: "round_limit", constraintChecks: [evidence, evidence] })
  ).toThrow(/Duplicate/i);
  expect(() =>
    selectFinalResult({
      session: state,
      stopReason: "round_limit",
      constraintChecks: [{ ...evidence, source: "model" as never }]
    })
  ).toThrow();
});
it("identifies missing highest-preference members without presenting sealed bodies as answers", () => {
  const state = createDiscussionSession({
    sessionId: "missing-owner",
    question: "Q",
    memberIds: ["a", "b"],
    policy: { weights: { a: { decisionWeight: 9 }, b: { decisionWeight: 1 } } }
  });
  const result = final(state);
  expect(result.incompleteReason).toBe("missing_valid_answer");
  expect(result).toMatchObject({ missingAnswerMemberIds: ["a"], answer: "", selectedAnswerVersionIds: [] });
});
