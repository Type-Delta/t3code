import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as NodeOS from "node:os";

export const HostProcessPlatform = Context.Reference<NodeJS.Platform>(
  "@t3tools/shared/hostProcess/HostProcessPlatform",
  {
    defaultValue: () => process.platform,
  },
);

export const HostProcessArchitecture = Context.Reference<NodeJS.Architecture>(
  "@t3tools/shared/hostProcess/HostProcessArchitecture",
  {
    defaultValue: () => process.arch,
  },
);

export const HostProcessHostname = Context.Reference<string>(
  "@t3tools/shared/hostProcess/HostProcessHostname",
  {
    defaultValue: () => NodeOS.hostname(),
  },
);

export const resolveHostProcessUsername = (input: {
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
  readonly userInfo: () => { readonly username: string };
}): string | undefined => {
  let username: string;
  try {
    username = input.userInfo().username.trim();
  } catch {
    return undefined;
  }
  if (username.length === 0) {
    return undefined;
  }

  // OpenSSH on Windows accepts DOMAIN\\user for AD domain accounts. Require
  // the DNS-domain signal so local/workgroup accounts do not accidentally get
  // a COMPUTERNAME\\user or WORKGROUP\\user principal.
  if (input.platform === "win32") {
    const domain = input.environment.USERDOMAIN?.trim();
    const dnsDomain = input.environment.USERDNSDOMAIN?.trim();
    const computerName = input.environment.COMPUTERNAME?.trim();
    if (
      domain !== undefined &&
      domain.length > 0 &&
      dnsDomain !== undefined &&
      dnsDomain.length > 0 &&
      domain.toLowerCase() !== "workgroup" &&
      (computerName === undefined ||
        computerName.length === 0 ||
        domain.toLowerCase() !== computerName.toLowerCase()) &&
      !username.includes("\\") &&
      !username.includes("@")
    ) {
      return `${domain}\\${username}`;
    }
  }
  return username;
};

export const HostProcessUsername = Context.Reference<string | undefined>(
  "@t3tools/shared/hostProcess/HostProcessUsername",
  {
    defaultValue: () =>
      resolveHostProcessUsername({
        platform: process.platform,
        environment: process.env,
        userInfo: NodeOS.userInfo,
      }),
  },
);

export const HostProcessEnvironment = Context.Reference<NodeJS.ProcessEnv>(
  "@t3tools/shared/hostProcess/HostProcessEnvironment",
  {
    defaultValue: () => process.env,
  },
);

export const HostProcessWorkingDirectory = Context.Reference<string>(
  "@t3tools/shared/hostProcess/HostProcessWorkingDirectory",
  {
    defaultValue: () => process.cwd(),
  },
);

export const HostProcessExecutablePath = Context.Reference<string>(
  "@t3tools/shared/hostProcess/HostProcessExecutablePath",
  {
    defaultValue: () => process.execPath,
  },
);

export const HostProcessArguments = Context.Reference<ReadonlyArray<string>>(
  "@t3tools/shared/hostProcess/HostProcessArguments",
  {
    defaultValue: () => process.argv,
  },
);

/** Undefined on platforms without POSIX uids (Windows). */
export const HostProcessUserId = Context.Reference<number | undefined>(
  "@t3tools/shared/hostProcess/HostProcessUserId",
  {
    defaultValue: () => process.getuid?.(),
  },
);

export const isHostWindows = Effect.map(HostProcessPlatform, (platform) => platform === "win32");
