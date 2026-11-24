// Fork-only (FORK.md DL066): where a machine-wide gateway lives. Desktop apps trust the helper port
// only when an administrator installed one; the server platform layouts must match these paths.

export interface GatewayHostFiles {
  /** The runtime link `gateway install` creates, where only an administrator can. */
  readonly currentLink: string;
  /** Windows: the PID of the gateway process serving the helper, written by that process. */
  readonly helperPidFile?: string;
}

export const gatewayHostFiles = (
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): GatewayHostFiles | undefined => {
  if (platform === "linux") return { currentLink: "/opt/t3code/current" };
  if (platform === "darwin") return { currentLink: "/usr/local/t3code/current" };
  if (platform !== "win32") return undefined;
  const programFiles = env["ProgramFiles"] ?? "C:\\Program Files";
  const programData = env["ProgramData"] ?? "C:\\ProgramData";
  return {
    currentLink: `${programFiles}\\T3Code\\current`,
    helperPidFile: `${programData}\\T3Code\\.t3code-gateway-helper\\helper.pid`,
  };
};

export interface Endpoint {
  readonly address: string;
  readonly port: number;
}
export interface NetstatRow {
  readonly local: Endpoint;
  readonly remote: Endpoint;
  readonly pid: number;
}

const parseEndpoint = (text: string): Endpoint | undefined => {
  const colon = text.lastIndexOf(":");
  const port = Number(text.slice(colon + 1));
  if (colon < 1 || !Number.isInteger(port) || port < 0 || port > 65535) return undefined;
  return {
    address: text
      .slice(0, colon)
      .replace(/^\[(.*)\]$/, "$1")
      .replace(/%\d+$/, "")
      .toLowerCase(),
    port,
  };
};

/**
 * TCP rows of `netstat -ano`. The state column is localized and may hold spaces, so it is skipped:
 * a listener is the row whose remote port is 0.
 */
export const parseNetstat = (text: string): ReadonlyArray<NetstatRow> =>
  text.split(/\r?\n/).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    const pid = fields.at(-1) ?? "";
    if (fields[0] !== "TCP" || fields.length < 4 || !/^\d+$/.test(pid)) return [];
    const local = parseEndpoint(fields[1] ?? "");
    const remote = parseEndpoint(fields[2] ?? "");
    return local === undefined || remote === undefined ? [] : [{ local, remote, pid: Number(pid) }];
  });
