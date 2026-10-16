import { appendFileSync } from "node:fs";

let trace;
export function initialize(options) {
  trace = options.trace;
}
const forbidden = (specifier, url) =>
  /^(?:ai(?:\/|$)|@ai-sdk\/|dotenv(?:\/|$)|@onevcat\/argue(?:-cli)?$)/.test(specifier) ||
  /\/(?:argue|argue-cli)\/dist\/(?:index\.js$|cli\.js$|build\/|core\/|discussion\/|transport\/|runtime\/|model-api\/|peer\/(?!hash\.js$)|config\.js$|env[^/]*\.js$)/.test(
    url
  ) ||
  /\/agent-sync\/(?:legacy-v1\/|adapters\/|(?:index|service|local|initialize)\.js$)/.test(url) ||
  /\/node_modules\/(?:ai\/|@ai-sdk\/|dotenv\/)/.test(url) ||
  /\/(?:credentials?|model-transport)\.[cm]?js$/.test(url);

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  const denied = forbidden(specifier, result.url);
  appendFileSync(trace, JSON.stringify({ url: result.url, decision: denied ? "denied" : "allowed" }) + "\n");
  if (denied) {
    const error = new Error("AGENT_SYNC_PROJECT_IMPORT_DENIED");
    error.code = "AGENT_SYNC_PROJECT_IMPORT_DENIED";
    throw error;
  }
  return result;
}
