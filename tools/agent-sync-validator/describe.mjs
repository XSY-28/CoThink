import process from "node:process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
const sha = (bytes) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
function tree(root) {
  const entries = [];
  function visit(path) {
    for (const name of readdirSync(root + (path ? "/" + path : "")).sort()) {
      const relative = path ? path + "/" + name : name;
      const info = lstatSync(root + "/" + relative);
      if (info.isDirectory()) visit(relative);
      // donor contains package bin links; commit their target spelling as well as all target bytes.
      else if (info.isSymbolicLink()) entries.push([relative, "link", readlinkSync(root + "/" + relative)]);
      else if (info.isFile()) entries.push([relative, sha(readFileSync(root + "/" + relative))]);
      else throw new Error("AGENT_SYNC_TOOLCHAIN_FILE");
    }
  }
  visit("");
  return sha(JSON.stringify(entries));
}
import { readlinkSync } from "node:fs";
const files = Object.fromEntries(
  readdirSync("/opt/validator")
    .sort()
    .map((name) => ["/opt/validator/" + name, sha(readFileSync("/opt/validator/" + name))])
);
process.stdout.write(
  JSON.stringify({
    profile: "agent-sync-validator-v1",
    node: process.versions.node,
    files,
    toolchainTreeHash: tree("/opt/toolchain"),
    nodeBinaryHash: sha(readFileSync(process.execPath))
  })
);
