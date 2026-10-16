import { readFile, mkdir, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
// Reference modules are copied into src/, so their original test/oracle import is rebased.
export async function todoReferenceText(sample, name) {
  return (await readFile(join(sample, "test/oracle", name + ".ts"), "utf8")).replaceAll(
    "../../src/types.js",
    "./types.js"
  );
}
/** Preparation only: the actual neutral worker receives frozen JSON/texts, never this legacy adapter. */
export async function prepareTodo({ repositoryRoot, sourceRoot, trustedRoot, imageMetadata }) {
  const sample = join(repositoryRoot, "examples/todo-stats");
  const original = JSON.parse(await readFile(join(sample, "build-plan.json"), "utf8"));
  const { createTodoTrustedChecks } = await import(
    pathToFileURL(join(repositoryRoot, "packages/argue-cli/dist/agent-sync/adapters/todo-checks.js")).href
  );
  const profiles = [
    { profileId: "status-cases", checkIds: ["common", "state-format"] },
    { profileId: "line-cases", checkIds: ["common", "report"] },
    { profileId: "identity-cases", checkIds: ["common", "identity"] },
    { profileId: "joint-cases", checkIds: ["common", "state-format", "report", "identity", "final"] }
  ];
  const config = await createTodoTrustedChecks({
    repositoryRoot,
    trustedRoot,
    imageMetadata,
    profiles,
    finalProfileId: "joint-cases"
  });
  for (const entry of original.manifest) {
    const output = join(sourceRoot, entry.path);
    await mkdir(dirname(output), { recursive: true });
    await copyFile(join(sample, entry.path), output);
  }
  const ids = ["normalize-status", "report-lines", "normalize-identity"],
    members = ["state-owner", "report-owner", "report-owner"],
    profileIds = ["status-cases", "line-cases", "identity-cases"];
  const tasks = original.tasks.map((t, i) => ({
    taskId: ids[i],
    workerId: members[i],
    scope: t.scope,
    dependsOn: [],
    checkProfileId: profileIds[i]
  }));
  const texts = {};
  for (const [name, file] of [
    ["amount-basic", "correct-state"],
    ["amount-guards", "correct-final"],
    ["receipt-lines", "correct-report"]
  ])
    texts[name] = await todoReferenceText(sample, file);
  return {
    project: {
      projectVersion: "agent-sync-project-v1",
      projectKey: "todo-neutral",
      memberIds: ["state-owner", "report-owner"],
      manifest: original.manifest,
      tasks,
      profiles,
      finalProfileId: "joint-cases"
    },
    config,
    texts
  };
}
