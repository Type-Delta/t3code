// Fork-only (FORK.md DL066): where a machine-wide gateway lives. Desktop apps trust the helper port
// only when an administrator installed one; the server platform layouts must match these paths.

export interface GatewayHostFiles {
  /** The runtime link `gateway install` creates, where only an administrator can. */
  readonly currentLink: string;
  /** The shared runtime's CLI, which matches the backends it runs. */
  readonly runtimeExecutable: string;
  /** Windows: the public key the gateway encrypts join passwords to, written by that process. */
  readonly helperKeyFile?: string;
}

export const gatewayHostFiles = (
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): GatewayHostFiles | undefined => {
  if (platform === "linux") {
    return { currentLink: "/opt/t3code/current", runtimeExecutable: "/opt/t3code/current/t3" };
  }
  if (platform === "darwin") {
    return {
      currentLink: "/usr/local/t3code/current",
      runtimeExecutable: "/usr/local/t3code/current/t3",
    };
  }
  if (platform !== "win32") return undefined;
  const programFiles = env["ProgramFiles"] ?? "C:\\Program Files";
  const programData = env["ProgramData"] ?? "C:\\ProgramData";
  return {
    currentLink: `${programFiles}\\T3Code\\current`,
    runtimeExecutable: `${programFiles}\\T3Code\\current\\t3.exe`,
    helperKeyFile: `${programData}\\T3Code\\.t3code-gateway-helper\\helper-key.pem`,
  };
};
