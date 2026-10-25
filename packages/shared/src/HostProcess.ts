import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as NodeDns from "node:dns";
import * as NodeOS from "node:os";
import * as NodeSea from "node:sea";

export const Platform = Context.Reference<NodeJS.Platform>("@t3tools/shared/HostProcess/Platform", {
  defaultValue: () => process.platform,
});

export const Architecture = Context.Reference<NodeJS.Architecture>(
  "@t3tools/shared/HostProcess/Architecture",
  {
    defaultValue: () => process.arch,
  },
);

export const Hostname = Context.Reference<string>("@t3tools/shared/HostProcess/Hostname", {
  defaultValue: () => NodeOS.hostname(),
});

export const HomeDirectory = Context.Reference<string>(
  "@t3tools/shared/HostProcess/HomeDirectory",
  {
    defaultValue: () => NodeOS.homedir(),
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

export const Username = Context.Reference<string | null | undefined>(
  "@t3tools/shared/HostProcess/Username",
  {
    defaultValue: () =>
      resolveHostProcessUsername({
        platform: process.platform,
        environment: process.env,
        userInfo: NodeOS.userInfo,
      }),
  },
);

export const Environment = Context.Reference<NodeJS.ProcessEnv>(
  "@t3tools/shared/HostProcess/Environment",
  {
    defaultValue: () => process.env,
  },
);

export const WorkingDirectory = Context.Reference<string>(
  "@t3tools/shared/HostProcess/WorkingDirectory",
  {
    defaultValue: () => process.cwd(),
  },
);

export const ExecutablePath = Context.Reference<string>(
  "@t3tools/shared/HostProcess/ExecutablePath",
  {
    defaultValue: () => process.execPath,
  },
);

export const Arguments = Context.Reference<ReadonlyArray<string>>(
  "@t3tools/shared/HostProcess/Arguments",
  {
    defaultValue: () => process.argv,
  },
);

/** Original shell command spelling; argv[0] and execPath instead identify the resolved binary. */
export const InvokedAs = Context.Reference<string>("@t3tools/shared/HostProcess/InvokedAs", {
  defaultValue: () => process.argv0,
});

export const IsExecutable = Context.Reference<boolean>("@t3tools/shared/HostProcess/IsExecutable", {
  defaultValue: () => NodeSea.isSea(),
});

/** Includes hostname-resolved addresses absent from interfaces, such as Debian's 127.0.1.1 used by Firefox locks. */
export const Addresses = Context.Reference<Effect.Effect<ReadonlySet<string>>>(
  "@t3tools/shared/HostProcess/Addresses",
  {
    defaultValue: () =>
      Effect.gen(function* () {
        const interfaces = Object.values(NodeOS.networkInterfaces())
          .flat()
          .flatMap((entry) => (entry ? [entry.address] : []));
        const resolved = yield* Effect.tryPromise(() =>
          NodeDns.promises.lookup(NodeOS.hostname(), { all: true }),
        ).pipe(
          Effect.map((entries) => entries.map((entry) => entry.address)),
          Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
        );
        return new Set([...interfaces, ...resolved]);
      }),
  },
);

export const UserId = Context.Reference<number | undefined>("@t3tools/shared/HostProcess/UserId", {
  defaultValue: () => process.getuid?.(),
});

export const isWindows = Effect.map(Platform, (platform) => platform === "win32");
export const isHostWindows = isWindows;
