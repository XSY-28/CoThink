import type { MemberId, PeerResultV1 } from "@onevcat/argue";

const order: PeerResultV1["claims"][number]["label"][] = [
  "jointly_accepted",
  "jointly_rejected",
  "disputed",
  "uncertain",
  "incomplete_review"
];

/** Arrange only signed records. Missing positions remain missing. */
export function buildPeerViewModel(result: PeerResultV1) {
  const members = (["member-a", "member-b"] as MemberId[]).map((memberId) => ({
    memberId,
    modelId: result.members[memberId].modelId,
    conclusion: result.conclusions.find((item) => item.memberId === memberId) ?? null,
    initial: result.initialJudgments.find((item) => item.memberId === memberId) ?? null
  }));
  const attemptsWithUsage = result.attempts.filter(
    (attempt) => attempt.runtime && Object.keys(attempt.runtime.usage).some((key) => key.endsWith("Tokens"))
  ).length;
  const committedJobIds = new Set(result.rounds.flatMap((round) => round.replies.map((reply) => reply.jobId)));
  return {
    members,
    reviewStatus: result.reviewStatus,
    usageCoverage: `${attemptsWithUsage}/${result.attempts.length}`,
    orderedClaims: order.flatMap((label) => result.claims.filter((claim) => claim.label === label)),
    uncommittedAttempts: result.attempts.filter(
      (attempt) =>
        !(attempt.status === "valid" && attempt.acceptance === "accepted" && committedJobIds.has(attempt.jobId))
    )
  };
}
