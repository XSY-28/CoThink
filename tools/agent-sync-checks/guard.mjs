import * as moduleApi from "node:module";
import { readFileSync, realpathSync, lstatSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath, URL } from "node:url";
import { isAbsolute } from "node:path";
const installed = new Map();
const sha = (bytes) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
function readPolicy(path) {
  const bytes = readFileSync(path),
    p = JSON.parse(bytes);
  if (
    p.version !== "agent-sync-host-closure-v1" ||
    !p.files ||
    Array.isArray(p.files) ||
    typeof p.failurePath !== "string" ||
    !isAbsolute(p.failurePath) ||
    Object.keys(p).sort().join() !== "failurePath,files,version" ||
    Object.entries(p.files).some(
      ([name, hash]) => !isAbsolute(name) || typeof hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(hash)
    )
  )
    throw new Error("AGENT_SYNC_GUARD_POLICY");
  return { policy: p, hash: sha(bytes) };
}
export function installGuard(policyPath) {
  if (typeof moduleApi.registerHooks !== "function") throw new Error("AGENT_SYNC_GUARD_UNAVAILABLE");
  policyPath = realpathSync(policyPath);
  const { policy, hash } = readPolicy(policyPath);
  const prior = installed.get(policyPath);
  if (prior) {
    if (prior.hash !== hash) throw new Error("AGENT_SYNC_GUARD_POLICY_CHANGED");
    return prior;
  }
  const fail = (id, code = "AGENT_SYNC_MODULE_UNDECLARED", boundary = "native") => {
    writeFileSync(policy.failurePath, JSON.stringify({ code, id, boundary }));
    throw new Error(code);
  };
  function file(id, boundary = "native") {
    if (typeof id !== "string") return fail(String(id), undefined, boundary);
    if (moduleApi.isBuiltin(id)) return null;
    let path;
    try {
      if (id.startsWith("file:")) path = fileURLToPath(new URL(id));
      else if (id.startsWith("/@fs/")) path = decodeURIComponent(id.slice(4).split("?")[0]);
      else if (isAbsolute(id) && !id.includes("\0")) path = id.split("?")[0];
      else return fail(id, undefined, boundary);
      const actual = realpathSync(path),
        stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile() || !Object.hasOwn(policy.files, actual))
        return fail(id, undefined, boundary);
      if (sha(readFileSync(actual)) !== policy.files[actual]) return fail(id, "AGENT_SYNC_MODULE_CHANGED", boundary);
      return actual;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("AGENT_SYNC_")) throw error;
      return fail(id, undefined, boundary);
    }
  }
  moduleApi.registerHooks({
    resolve(specifier, context, next) {
      const result = next(specifier, context);
      file(result.url);
      return result;
    },
    load(url, context, next) {
      file(url);
      return next(url, context);
    }
  });
  const guard = { hash, file };
  installed.set(policyPath, guard);
  return guard;
}
/** Vite evaluates transformed TS itself; native Node hooks alone cannot cover that path. */
export function viteGuard(policyPath, markerPath) {
  const guard = installGuard(policyPath);
  return {
    name: "agent-sync-measured-closure",
    enforce: "pre",
    configResolved() {
      writeFileSync(markerPath, guard.hash);
    },
    async resolveId(source, importer, options) {
      if (moduleApi.isBuiltin(source)) return null;
      if (source.startsWith("file:") || source.startsWith("/@fs/") || isAbsolute(source)) guard.file(source, "vite");
      const result = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (result) guard.file(result.id, "vite");
      return result;
    },
    load(id) {
      guard.file(id, "vite");
      return null;
    },
    transform(_code, id) {
      guard.file(id, "vite");
      return null;
    }
  };
}
