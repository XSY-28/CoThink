import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseEnv } from "node:util";

export const DEFAULT_PEER_CONFIG = ".cothink/config.json";
export const DEFAULT_PEER_ENV = ".cothink/keys.env";

export async function readPeerEnvironment(
  path: string | undefined,
  base: Record<string, string | undefined> = process.env
): Promise<Record<string, string | undefined>> {
  if (!path) return { ...base };
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    throw new Error(`Cannot read environment file: ${path}`);
  }
  let parsed: Record<string, string | undefined>;
  try {
    parsed = parseEnv(content);
  } catch {
    throw new Error("Cannot parse environment file");
  }
  return { ...parsed, ...Object.fromEntries(Object.entries(base).filter(([, value]) => value !== undefined)) };
}

async function requireAbsent(path: string) {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`File already exists; edit it explicitly or choose a new path: ${path}`);
}

function encodeKeys(keys: Record<string, string>): string {
  return (
    Object.entries(keys)
      .map(([name, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !value || /[\r\n\0]/.test(value))
          throw new Error("Invalid key name or single-line credential");
        // Node's dotenv parser does not decode JSON escapes. Verify the chosen
        // literal encoding instead of silently changing quotes or backslashes.
        for (const literal of [`'${value}'`, `"${value}"`, `\`${value}\``, value]) {
          const line = `${name}=${literal}`;
          if (parseEnv(line)[name] === value) return line;
        }
        throw new Error("Credential cannot be represented safely in the environment file");
      })
      .join("\n") + "\n"
  );
}

/** Exclusive creation: never replace existing config or credentials. */
export async function writeSetupFiles(
  configPath: string,
  envPath: string,
  config: unknown,
  keys: Record<string, string>
): Promise<void> {
  const hasKeys = Object.keys(keys).length > 0;
  const encoded = hasKeys ? encodeKeys(keys) : undefined;
  await requireAbsent(configPath);
  if (hasKeys) await requireAbsent(envPath);
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  if (hasKeys) await mkdir(dirname(envPath), { recursive: true, mode: 0o700 });
  let createdKey = false;
  try {
    if (encoded !== undefined) {
      await writeFile(envPath, encoded, { flag: "wx", mode: 0o600 });
      createdKey = true;
    }
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    // There is no atomic path-and-inode conditional unlink. Keep private
    // credentials for recovery rather than risk deleting another writer's file.
    if (createdKey)
      throw new Error(
        `Configuration save failed (${(error as NodeJS.ErrnoException).code ?? "write error"}); the private key file was retained for recovery: ${envPath}`
      );
    throw error;
  }
}
