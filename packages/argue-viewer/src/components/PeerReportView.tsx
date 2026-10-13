import type { PeerResultV1 } from "@onevcat/argue";
import { buildPeerViewModel } from "../lib/peer-view-model.js";

const labelText = {
  jointly_accepted: "Jointly accepted",
  jointly_rejected: "Jointly rejected",
  disputed: "Disputed",
  uncertain: "Uncertain",
  incomplete_review: "Incomplete review"
};

export function PeerReportView({ result, onReset }: { result: PeerResultV1; onReset: () => void }) {
  const view = buildPeerViewModel(result);
  return (
    <main className="report-layout peer-report">
      <header className="report-header">
        <strong>Argue · Peer</strong>
      </header>
      <article className="report-content">
        <h1>{result.question}</h1>
        <p>
          Session {result.sessionId} · Segment {result.segmentId} · {result.status} ·{" "}
          {result.reviewStatus === "incomplete_review" ? "Incomplete review" : result.reviewStatus}
        </p>
        {result.integrity.pauseReason && (
          <p role="status">
            Paused: {result.integrity.pauseReason.code} — {result.integrity.pauseReason.message}
          </p>
        )}
        <p>
          Observed token usage: {view.usageCoverage} attempts with usage.{" "}
          {result.usage.inputTokens === undefined
            ? "Input tokens unknown"
            : `Known input tokens: ${result.usage.inputTokens}`}
          ;{" "}
          {result.usage.outputTokens === undefined
            ? "output tokens unknown"
            : `known output tokens: ${result.usage.outputTokens}`}
          . Cost unknown unless recorded per attempt.
        </p>
        {result.goal && (
          <section>
            <h2>Goal</h2>
            <p>{result.goal}</p>
          </section>
        )}
        {result.constraints.length > 0 && (
          <section>
            <h2>Constraints</h2>
            <ul>
              {result.constraints.map((item) => (
                <li>{item}</li>
              ))}
            </ul>
          </section>
        )}
        <section>
          <h2>Supplied sources</h2>
          {result.sources.length ? (
            result.sources.map((source) => (
              <article>
                <h3>
                  {source.name ?? source.sourceId} · {source.sourceId}
                </h3>
                <pre>{source.content}</pre>
              </article>
            ))
          ) : (
            <p>None supplied.</p>
          )}
        </section>
        <section>
          <h2>Member positions</h2>
          {view.members.map((member) => (
            <article>
              <h3>
                {member.memberId} · {member.modelId}
              </h3>
              <p>Opening: {member.initial?.conclusion ?? "No committed opening"}</p>
              <p>Latest: {member.conclusion?.conclusion ?? "No committed conclusion"}</p>
            </article>
          ))}
        </section>
        <section>
          <h2>Claim assessments</h2>
          {view.orderedClaims.length ? (
            view.orderedClaims.map(({ version, label, positions }) => (
              <article>
                <h3>
                  {labelText[label]} · {version.versionId}
                </h3>
                <p>
                  {version.authorId}: {version.statement}
                </p>
                <p>Rationale: {version.rationale}</p>
                <p>Assumptions: {version.assumptions.join("; ") || "none stated"}</p>
                <p>
                  Source references:{" "}
                  {version.sourceRefs.map((x) => `${x.sourceId}:${x.startLine}-${x.endLine}`).join(", ") || "none"}
                </p>
                {positions.map(({ memberId, position }) => (
                  <p>
                    {memberId}: {position.stance} — {position.rationale} ·{" "}
                    {position.sourceRefs.map((x) => `${x.sourceId}:${x.startLine}-${x.endLine}`).join(", ") ||
                      "no source refs"}
                  </p>
                ))}
                {positions.length < 2 && <p>Missing {2 - positions.length} assessment(s).</p>}
              </article>
            ))
          ) : (
            <p>No active claims to review.</p>
          )}
        </section>
        <section>
          <h2>Original claim versions</h2>
          {result.claimVersions.map((version) => (
            <p>
              {version.versionId} · {version.authorId} · v{version.version}
              {version.withdrawn ? " · withdrawn" : ""}: {version.statement}
            </p>
          ))}
        </section>
        <section>
          <h2>Messages</h2>
          {result.messages.map((message) => (
            <article>
              <h3>
                {message.messageId} · {message.kind}
              </h3>
              <p>
                {message.authorId} → {message.recipientId}: {message.rationale}
              </p>
              <p>Replies: {message.respondedBy.join(", ") || "none"}</p>
            </article>
          ))}
          <p>Unresponded: {result.unrespondedMessages.map((x) => x.messageId).join(", ") || "none"}</p>
        </section>
        <section>
          <h2>Evidence requests</h2>
          {result.evidenceRequests.map((item) => (
            <p>
              {item.memberId}: {item.request} — {item.rationale}
            </p>
          ))}
        </section>
        <section>
          <h2>Committed rounds</h2>
          {result.rounds.map((round) => (
            <article>
              <h3>
                Segment {round.segmentId} · {round.phase} {round.roundIndex}
              </h3>
              {round.replies.map((reply) => (
                <div>
                  <strong>{reply.memberId}</strong>
                  <pre>{JSON.stringify(reply.payload, null, 2)}</pre>
                </div>
              ))}
            </article>
          ))}
        </section>
        <section>
          <h2>Uncommitted diagnostic attempts</h2>
          <p>These records did not change claims, messages or assessments.</p>
          {view.uncommittedAttempts.map((attempt) => (
            <article>
              <h3>
                {attempt.memberId} · {attempt.status}
              </h3>
              <p>{attempt.error?.code ?? "No recorded error"}</p>
              {attempt.rawContent !== undefined && <pre>{attempt.rawContent}</pre>}
            </article>
          ))}
        </section>
      </article>
      <div className="report-reset">
        <button type="button" onClick={onReset}>
          ← Check Another Report
        </button>
      </div>
    </main>
  );
}
