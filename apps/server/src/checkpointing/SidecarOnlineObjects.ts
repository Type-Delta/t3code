/**
 * Pure helpers for Online Snapshots: sidecar blobs that the project's remote
 * already holds are evicted and fetched back on demand.
 */
import type { CheckpointObjectsUnavailableReason } from "./Errors.ts";

/**
 * Lets one sidecar Git command read the project's objects without persisting
 * an alternate. Git C-unquotes an entry that starts with a double quote, so a
 * path holding the list delimiter stays one entry.
 */
export const alternateObjectDirectories = (objectsDirectory: string, platform: string) => {
  const delimiter = platform === "win32" ? ";" : ":";
  return objectsDirectory.includes(delimiter) || objectsDirectory.startsWith('"')
    ? `"${objectsDirectory.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : objectsDirectory;
};

/** Non-interactive Git network access that still uses configured credential helpers. */
export const nonInteractiveNetworkEnvironment = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
} as const;

/** Config keys that decide how a fetch reaches and authenticates to a remote. */
export const TRANSPORT_CONFIG_PATTERN = "^(credential|http)\\.|^core\\.sshcommand$|^ssh\\.variant$";

/**
 * Turns `git config -z --get-regexp` entries the project sees but the sidecar
 * does not (project-local config, a global `includeIf "gitdir:..."`) into
 * `GIT_CONFIG_*` variables that apply them to one sidecar command.
 */
export const transportConfigEnvironment = (project: string, sidecar: string) => {
  const sidecarEntries = new Map<string, number>();
  for (const entry of sidecar.split("\0")) {
    sidecarEntries.set(entry, (sidecarEntries.get(entry) ?? 0) + 1);
  }
  const environment: Record<string, string> = {};
  let count = 0;
  for (const entry of project.split("\0")) {
    const shared = sidecarEntries.get(entry) ?? 0;
    if (entry === "" || shared > 0) {
      sidecarEntries.set(entry, shared - 1);
      continue;
    }
    // A key listed without "\n" is a valueless boolean entry.
    const newline = entry.indexOf("\n");
    environment[`GIT_CONFIG_KEY_${count}`] = newline === -1 ? entry : entry.slice(0, newline);
    environment[`GIT_CONFIG_VALUE_${count}`] = newline === -1 ? "true" : entry.slice(newline + 1);
    count += 1;
  }
  if (count > 0) environment.GIT_CONFIG_COUNT = String(count);
  return environment;
};

const SCHEME_URL = /^([a-z][a-z0-9+.-]*):\/\/(?:([^/@]*)@)?(.*)$/i;
// `user@host:path`; a one-letter host is a Windows drive letter, not scp syntax.
const SCP_URL = /^(?:[^@/\\]+@)?([^/\\:]{2,}):(.*)$/;

/** Drops HTTP credentials; an SSH user is kept because connecting needs it. */
export const credentialFreeUrl = (url: string) => {
  const match = SCHEME_URL.exec(url);
  if (!match?.[2]) return url;
  const [, scheme = "", userInfo = "", rest = ""] = match;
  return /ssh/i.test(scheme)
    ? `${scheme}://${userInfo.split(":")[0]}@${rest}`
    : `${scheme}://${rest}`;
};

/** A short remote location for messages, such as `github.com/acme/app`. */
export const remoteDisplayUrl = (url: string) => {
  const scheme = SCHEME_URL.exec(url);
  const scp = scheme ? undefined : SCP_URL.exec(url);
  const location = scheme ? (scheme[3] ?? "") : scp ? `${scp[1]}/${scp[2]}` : url;
  return location.replace(/\/+$/, "").replace(/\.git$/, "");
};

/** Hides credentials Git may echo back in a URL before stderr reaches a log. */
export const redactUrlCredentials = (text: string) => text.replace(/:\/\/[^/@\s]+@/g, "://");

/** Classifies `git fetch` or `git ls-remote` stderr for a user-facing reason. */
export const classifyRemoteFailure = (stderr: string): CheckpointObjectsUnavailableReason => {
  const text = stderr.toLowerCase();
  const matches = (pattern: RegExp) => pattern.test(text);
  if (
    matches(
      /repository not found|repository '[^']*' not found|does not appear to be a git repository/,
    )
  ) {
    return "repository-unavailable";
  }
  if (
    matches(
      /authentication failed|permission denied \(publickey|returned error: 40[13]|could not read (username|password)|terminal prompts disabled|invalid username or password/,
    )
  ) {
    return "auth";
  }
  if (
    matches(/not our ref|no such object|did not send all necessary objects|unadvertised object/)
  ) {
    return "not-on-remote";
  }
  if (matches(/operation too slow|operation timed out/)) return "timeout";
  if (
    matches(
      /could not resolve host|timed out|connection refused|failed to connect|network is unreachable|no route to host|connection reset/,
    )
  ) {
    return "network";
  }
  return "unknown";
};

export interface RawDiffRecord {
  readonly fromMode: string;
  readonly toMode: string;
  readonly fromOid: string;
  readonly toOid: string;
  readonly path: string;
}

/**
 * Parses `git diff-tree -r -z --raw --no-renames`: each header is followed by
 * exactly one path, so a path starting with `:` is never read as a header.
 */
export const parseRawDiff = (output: string): ReadonlyArray<RawDiffRecord> => {
  const fields = output.split("\0");
  const records: Array<RawDiffRecord> = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const header = fields[index]!;
    if (!header.startsWith(":")) break;
    const [fromMode = "", toMode = "", fromOid = "", toOid = ""] = header.slice(1).split(" ");
    records.push({ fromMode, toMode, fromOid, toOid, path: fields[index + 1]! });
  }
  return records;
};

/** Blob ids a diff of these records reads; gitlinks and absent sides read nothing. */
export const rawDiffBlobs = (records: ReadonlyArray<RawDiffRecord>) =>
  records.flatMap((record) =>
    [
      [record.fromMode, record.fromOid],
      [record.toMode, record.toOid],
    ]
      .filter(([mode, oid]) => mode !== "160000" && /[1-9a-f]/.test(oid ?? ""))
      .map(([, oid]) => oid!),
  );

/** Parses `git count-objects -v`. */
export const parseCountObjects = (output: string) => {
  const values = new Map(
    output
      .split("\n")
      .map((line) => line.split(": "))
      .filter((pair): pair is [string, string] => pair.length === 2)
      .map(([key, value]) => [key.trim(), Number.parseInt(value, 10)] as const),
  );
  return { looseObjects: values.get("count") ?? 0, packs: values.get("packs") ?? 0 };
};

/** Picks the remote whose history decides which blobs count as stored online. */
export const selectPrimaryRemote = (input: {
  readonly remotes: ReadonlyArray<string>;
  readonly upstreamRemote: string | undefined;
  readonly defaultRemote: string | undefined;
}) => {
  const known = new Set(input.remotes);
  for (const candidate of [input.upstreamRemote, input.defaultRemote, "origin"]) {
    if (candidate !== undefined && known.has(candidate)) return candidate;
  }
  return input.remotes.length === 1 ? input.remotes[0] : undefined;
};
