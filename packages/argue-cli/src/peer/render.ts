import type { PeerResultV1 } from "@onevcat/argue";

const labelNames: Record<PeerResultV1["claims"][number]["label"], string> = {
  jointly_accepted: "Jointly accepted",
  jointly_rejected: "Jointly rejected",
  disputed: "Disputed",
  uncertain: "Uncertain",
  incomplete_review: "Incomplete review"
};
const labelOrder = Object.keys(labelNames) as Array<keyof typeof labelNames>;

/** CommonMark character references render literally and cannot form links, images or raw HTML. */
function literalMarkdown(value: string): string {
  return value.replace(/[\p{P}\p{S}]/gu, (char) => `&#${char.codePointAt(0)};`);
}

function sourceFence(content: string): string {
  const longestRun = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longestRun + 1));
}

export function usageCoverage(result: PeerResultV1): string {
  const observed = result.attempts.filter(
    (attempt) => attempt.runtime && Object.keys(attempt.runtime.usage).some((key) => key.endsWith("Tokens"))
  ).length;
  const fields = (["inputTokens", "outputTokens", "totalTokens"] as const).flatMap((key) =>
    result.usage[key] === undefined ? [] : [`${key}: ${result.usage[key]}`]
  );
  return `Observed usage (${observed}/${result.attempts.length} attempts with token usage): ${fields.join(", ") || "unknown"}. Cost: unknown unless individually recorded.`;
}

export function renderPeerMarkdown(result: PeerResultV1): string {
  const m = literalMarkdown;
  const lines: string[] = [
    `# Peer report: ${m(result.question)}`,
    "",
    `Session: ${m(result.sessionId)} · Segment: ${result.segmentId} · Status: ${result.status} · Review: ${result.reviewStatus === "incomplete_review" ? "Incomplete review" : result.reviewStatus}`,
    `Members: member-a (${m(result.members["member-a"].modelId)}); member-b (${m(result.members["member-b"].modelId)})`,
    usageCoverage(result),
    ""
  ];
  if (result.integrity.pauseReason)
    lines.push(`Pause: ${m(result.integrity.pauseReason.code)} — ${m(result.integrity.pauseReason.message)}`, "");
  if (result.goal) lines.push(`Goal: ${m(result.goal)}`, "");
  if (result.constraints.length) lines.push("## Constraints", "", ...result.constraints.map((x) => `- ${m(x)}`), "");
  lines.push("## Sources", "");
  if (!result.sources.length) lines.push("No supplied sources.");
  for (const source of result.sources) {
    const fence = sourceFence(source.content);
    lines.push(
      `### ${m(source.sourceId)}${source.name ? ` — ${m(source.name)}` : ""}`,
      "",
      fence,
      source.content,
      fence,
      ""
    );
  }
  lines.push("## Member conclusions", "");
  for (const memberId of ["member-a", "member-b"] as const) {
    const conclusion = result.conclusions.find((x) => x.memberId === memberId);
    lines.push(
      `### ${memberId}`,
      "",
      conclusion ? `${m(conclusion.conclusion)} (${conclusion.origin})` : "No committed conclusion.",
      ""
    );
  }
  lines.push("## Claim assessments", "");
  if (!result.claims.length) lines.push("No active claims to review.", "");
  for (const label of labelOrder) {
    const claims = result.claims.filter((item) => item.label === label);
    if (!claims.length) continue;
    lines.push(`### ${labelNames[label]}`, "");
    for (const item of claims) {
      lines.push(
        `#### ${m(item.version.versionId)} — ${item.version.authorId}`,
        "",
        m(item.version.statement),
        "",
        `Rationale: ${m(item.version.rationale)}`
      );
      for (const position of item.positions)
        lines.push(`${position.memberId}: ${position.position.stance} — ${m(position.position.rationale)}`);
      if (item.positions.length < 2) lines.push(`Missing positions: ${2 - item.positions.length}`);
      lines.push("");
    }
  }
  lines.push("## Original claim version history", "");
  for (const version of result.claimVersions)
    lines.push(
      `- ${m(version.versionId)} (${version.authorId}, v${version.version}${version.withdrawn ? ", withdrawn" : ""}): ${m(version.statement)}`
    );
  lines.push("", "## Messages and unresolved replies", "");
  for (const message of result.messages)
    lines.push(
      `- ${m(message.messageId)} ${message.authorId} → ${message.recipientId} ${message.kind}: ${m(message.rationale)}${message.respondedBy.length ? `; replies: ${message.respondedBy.map(m).join(", ")}` : ""}`
    );
  lines.push(
    "",
    "Unresponded: " + (result.unrespondedMessages.map((x) => m(x.messageId)).join(", ") || "none"),
    "",
    "## Evidence requests",
    ""
  );
  for (const request of result.evidenceRequests)
    lines.push(`- ${request.memberId}: ${m(request.request)} — ${m(request.rationale)}`);
  lines.push("", "## Committed rounds", "");
  for (const round of result.rounds) {
    lines.push(`### Segment ${round.segmentId}, ${round.phase} ${round.roundIndex}`, "");
    for (const reply of round.replies) lines.push(`- ${reply.memberId}: ${m(JSON.stringify(reply.payload))}`);
    lines.push("");
  }
  lines.push(
    "## Uncommitted diagnostic attempts",
    "",
    "These attempts did not change claims, messages or assessments."
  );
  for (const attempt of result.attempts) {
    const committed =
      attempt.status === "valid" &&
      attempt.acceptance === "accepted" &&
      result.rounds.some((round) => round.replies.some((reply) => reply.jobId === attempt.jobId));
    if (committed) continue;
    lines.push(
      `- ${m(attempt.attemptId)} ${attempt.memberId} ${attempt.status}: ${m(attempt.error?.code ?? "no error")}`
    );
    if (attempt.rawContent !== undefined) lines.push(`  Raw response: ${m(attempt.rawContent)}`);
  }
  lines.push("");
  return lines.join("\n");
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!
  );
}

/** Plain, self-contained document. Never injects report text into executable content. */
export function renderPeerHtml(result: PeerResultV1): string {
  const esc = escapeHtml;
  const pre = (value: string) => `<pre>${esc(value)}</pre>`;
  const details = (title: string, content: string) => `<details><summary>${esc(title)}</summary>${content}</details>`;
  const refs = (items: Array<{ sourceId: string; startLine: number; endLine: number }>) =>
    items.map((ref) => `${ref.sourceId}:${ref.startLine}-${ref.endLine}`).join(", ") || "none";
  const members = (["member-a", "member-b"] as const)
    .map((memberId) => {
      const initial = result.initialJudgments.find((item) => item.memberId === memberId);
      const latest = result.conclusions.find((item) => item.memberId === memberId);
      return `<article class="member-card"><h3>${esc(memberId)}</h3><p class="model">${esc(result.members[memberId].modelId)}</p><h4>Opening</h4><p>${esc(initial?.conclusion ?? "No committed opening")}</p><h4>Latest signed position</h4><p>${esc(latest?.conclusion ?? "No committed conclusion")}</p></article>`;
    })
    .join("");
  const claims = labelOrder
    .flatMap((label) =>
      result.claims
        .filter((item) => item.label === label)
        .map(
          (item) =>
            `<article class="claim"><p class="eyebrow">${esc(labelNames[label])} · ${esc(item.version.versionId)} · ${esc(item.version.authorId)}</p><h3>${esc(item.version.statement)}</h3><p><strong>Author rationale:</strong> ${esc(item.version.rationale)}</p><p><strong>Assumptions:</strong> ${esc(item.version.assumptions.join("; ") || "none stated")}</p><p><strong>Source refs:</strong> ${esc(refs(item.version.sourceRefs))}</p><div class="positions">${item.positions.map(({ memberId, position }) => `<div><strong>${esc(memberId)} · ${esc(position.stance)}</strong><p>${esc(position.rationale)}</p><small>Source refs: ${esc(refs(position.sourceRefs))}</small></div>`).join("")}${item.positions.length < 2 ? `<div class="missing">Missing ${2 - item.positions.length} assessment(s).</div>` : ""}</div></article>`
        )
    )
    .join("");
  const unresponded = result.unrespondedMessages.length
    ? result.unrespondedMessages
        .map(
          (message) =>
            `<article><h3>${esc(message.messageId)} · ${esc(message.kind)}</h3><p>${esc(message.authorId)} → ${esc(message.recipientId)}: ${esc(message.rationale)}</p></article>`
        )
        .join("")
    : "<p>None recorded.</p>";
  const evidence = result.evidenceRequests.length
    ? result.evidenceRequests
        .map(
          (request) =>
            `<article><h3>${esc(request.memberId)}</h3><p>${esc(request.request)}</p><p>${esc(request.rationale)}</p></article>`
        )
        .join("")
    : "<p>None recorded.</p>";
  const committedIds = new Set(result.rounds.flatMap((round) => round.replies.map((reply) => reply.jobId)));
  const uncommitted = result.attempts.filter(
    (attempt) => !(attempt.status === "valid" && attempt.acceptance === "accepted" && committedIds.has(attempt.jobId))
  );
  const sourceDetails =
    result.sources
      .map(
        (source) =>
          `<h3>${esc(source.sourceId)}${source.name ? ` · ${esc(source.name)}` : ""}</h3>${pre(source.content)}`
      )
      .join("") || "<p>None supplied.</p>";
  const versionDetails =
    result.claimVersions
      .map(
        (version) =>
          `<h3>${esc(version.versionId)} · ${esc(version.authorId)} · v${version.version}${version.withdrawn ? " · withdrawn" : ""}</h3><p>${esc(version.statement)}</p><p>${esc(version.rationale)}</p>`
      )
      .join("") || "<p>No versions.</p>";
  const messageDetails =
    result.messages
      .map(
        (message) =>
          `<h3>${esc(message.messageId)} · ${esc(message.kind)}</h3><p>${esc(message.authorId)} → ${esc(message.recipientId)}: ${esc(message.rationale)}</p><p>Replies: ${esc(message.respondedBy.join(", ") || "none")}</p>`
      )
      .join("") || "<p>No messages.</p>";
  const roundDetails =
    result.rounds
      .map(
        (round) =>
          `<h3>Segment ${round.segmentId} · ${esc(round.phase)} ${round.roundIndex}</h3>${round.replies.map((reply) => `<h4>${esc(reply.memberId)}</h4>${pre(JSON.stringify(reply.payload, null, 2))}`).join("")}`
      )
      .join("") || "<p>No committed rounds.</p>";
  const attemptDetails =
    uncommitted
      .map(
        (attempt) =>
          `<h3>${esc(attempt.attemptId)} · ${esc(attempt.memberId)} · ${esc(attempt.status)}</h3><p>${esc(attempt.error?.code ?? "No recorded error")}</p>${attempt.rawContent === undefined ? "" : pre(attempt.rawContent)}`
      )
      .join("") || "<p>No uncommitted attempts.</p>";
  const review = result.reviewStatus === "incomplete_review" ? "Incomplete review" : result.reviewStatus;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Peer report</title><style>
:root{color-scheme:light}*{box-sizing:border-box}body{max-width:1100px;margin:0 auto;padding:2rem 1.2rem 5rem;background:#f8f7f3;color:#252824;font:16px/1.6 system-ui,sans-serif}h1,h2,h3,h4{line-height:1.25}h1{font-size:clamp(1.8rem,4vw,3rem);max-width:23ch}h2{font-size:1.35rem;margin:2.5rem 0 1rem}h3{font-size:1.05rem}h4{margin:1.1rem 0 .2rem;font-size:.85rem;text-transform:uppercase;letter-spacing:.06em}p{margin:.5rem 0 1rem}small,.model,.eyebrow,.meta{color:#62685e}.eyebrow{font-size:.8rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em}.meta{border-bottom:1px solid #d8d8cf;padding-bottom:1rem}.members,.positions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}.member-card,.claim,section.notice article,details{border:1px solid #d8d8cf;border-radius:10px;background:white;padding:1rem 1.2rem}.member-card{min-width:0}.member-card h3{margin:.2rem 0}.claim{margin:1rem 0}.claim h3{overflow-wrap:anywhere}.positions{border-top:1px solid #e5e5dc;padding-top:1rem}.positions>*{min-width:0}.missing{color:#a43f26;font-weight:700}.notice article{margin:.7rem 0}.audit details{margin:.7rem 0}.audit summary{cursor:pointer;font-weight:700}.audit pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 ui-monospace,monospace;background:#f4f4f0;padding:.8rem;border-radius:6px}section{margin-top:2rem}@media(max-width:680px){.members,.positions{grid-template-columns:1fr}body{padding:1.2rem .8rem 3rem}}
</style></head><body><header><p class="eyebrow">Argue · Peer report</p><h1>${esc(result.question)}</h1><p class="meta">Session ${esc(result.sessionId)} · Segment ${result.segmentId} · ${esc(result.status)} · ${esc(review)}<br>${esc(usageCoverage(result))}</p>${result.integrity.pauseReason ? `<p class="missing">Pause: ${esc(result.integrity.pauseReason.code)} — ${esc(result.integrity.pauseReason.message)}</p>` : ""}</header><main><section class="members"><h2 style="grid-column:1/-1">Independent member positions</h2>${members}</section><section><h2>Claim assessments</h2>${claims || "<p>No active claims to review.</p>"}</section><section class="notice"><h2>Unresponded messages</h2>${unresponded}</section><section class="notice"><h2>Evidence requests</h2>${evidence}</section><section class="audit"><h2>Sources and full audit</h2><p>Uncommitted attempts are diagnostic only. They did not change claims, messages or assessments.</p>${details("Copied sources", sourceDetails)}${details("Original claim versions", versionDetails)}${details("All messages", messageDetails)}${details("Full committed rounds", roundDetails)}${details("Uncommitted diagnostic attempts", attemptDetails)}${details("Full peer JSON", pre(JSON.stringify(result, null, 2)))}</section></main></body></html>
`;
}
