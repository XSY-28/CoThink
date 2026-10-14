import { FinalResultSchema, type FinalResult } from "@onevcat/argue";

const outcomes: Record<FinalResult["outcome"], string> = {
  consensus: "All members accepted this answer in the saved review.",
  weighted_fallback: "Selected by decision preference.",
  tied_preferences: "Decision preferences are tied; the original alternatives follow.",
  incomplete: "No final answer selected. Use the session ID to resume explicitly."
};
const reasons: Record<NonNullable<FinalResult["incompleteReason"]>, string> = {
  missing_valid_answer: "A required member has no valid answer.",
  incomplete_review: "The required review is incomplete.",
  abnormal_stop: "The run stopped before normal completion.",
  discussion_continues: "Discussion has not reached a final decision.",
  round_limit_not_reached: "The configured round limit has not been reached.",
  constraint_failed: "A host constraint check failed."
};

/** Zod validates the contract; this also rejects inherited or non-JSON diagnostic channels. */
function assertDataTree(value: unknown, visiting = new WeakSet<object>()): void {
  if (value === null || value === undefined || ["string", "boolean", "number"].includes(typeof value)) return;
  if (typeof value !== "object" || visiting.has(value)) throw new Error("Invalid result");
  const array = Array.isArray(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    throw new Error("Invalid result");
  visiting.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor))
      throw new Error("Invalid result");
    if (array && !/^(0|[1-9]\d*)$/.test(key)) throw new Error("Invalid result");
    assertDataTree(descriptor.value, visiting);
  }
  visiting.delete(value);
}

function textResult(result: FinalResult, markdown: boolean): string {
  const section = (title: string) => (markdown ? `## ${title}` : title);
  const lines = [
    markdown ? "# CoThink result" : "CoThink result",
    `Outcome: ${result.outcome} — ${outcomes[result.outcome]}`,
    `Session: ${result.sessionId} | Segment: ${result.segmentId}`
  ];
  if (result.incompleteReason) {
    lines.push(`Reason: ${result.incompleteReason} — ${reasons[result.incompleteReason]}`);
    if (result.missingAnswerMemberIds?.length)
      lines.push(`Missing answer members: ${result.missingAnswerMemberIds.join(", ")}`);
    if (result.failedCheckIds?.length) lines.push(`Failed checks: ${result.failedCheckIds.join(", ")}`);
  }
  if (result.answer) lines.push("", section("Answer"), "", result.answer);
  for (const alternative of result.alternatives ?? []) {
    lines.push("", section(`Alternative: ${alternative.authorId}`), "", alternative.body);
    if (alternative.limitations.length)
      lines.push("", "Alternative limitations:", ...alternative.limitations.map((value) => `- ${value}`));
  }
  if (result.limitations.length)
    lines.push("", section("Limitations"), ...result.limitations.map((value) => `- ${value}`));
  if (result.importantDissent.length) lines.push("", section("Important dissent"));
  for (const dissent of result.importantDissent) {
    lines.push(
      "",
      `Author: ${dissent.authorId} | Severity: ${dissent.severity}`,
      `Summary: ${dissent.summary}`,
      `Impact: ${dissent.impact}`,
      `Evidence needed: ${dissent.evidenceNeeded}`
    );
  }
  return `${lines.join("\n")}\n`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!
  );
}

/** Render only the standalone public result, never session history or provider observations. */
export function renderFinalResult(result: FinalResult, format: "txt" | "md" | "json" | "html"): string {
  let parsed: FinalResult;
  try {
    assertDataTree(result);
    parsed = FinalResultSchema.parse(result);
    if (!["txt", "md", "json", "html"].includes(format)) throw new Error("Invalid format");
  } catch {
    throw new Error("Cannot render invalid FinalResult or output format");
  }
  if (format === "json") return `${JSON.stringify(parsed, null, 2)}\n`;
  if (format === "txt" || format === "md") return textResult(parsed, format === "md");
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>CoThink result</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; padding: 2rem 1rem; font-family: system-ui, sans-serif; line-height: 1.6; }
main { max-width: 54rem; margin: auto; }
pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
</style></head>
<body><main><pre>${escapeHtml(textResult(parsed, false))}</pre></main></body>
</html>\n`;
}
