import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { GatewayConfig } from "../GatewayConfig.ts";
import type * as ProcessRunner from "../../processRunner.ts";

/** Services adapter methods may use. Adapters run OS tools only through ProcessRunner; HostProcess values are references. */
export type GatewayPlatformServices =
  | FileSystem.FileSystem
  | Path.Path
  | ProcessRunner.ProcessRunner;

/** A POSIX uid, or a Windows SID such as `S-1-5-21-...-1001`. */
export type GatewayAccountId = number | string;

export class GatewayPlatformError extends Schema.TaggedError<
  GatewayPlatformError,
  { readonly brand: unique symbol }
>()("GatewayPlatformError", { message: Schema.String }) {}

type Op<A> = Effect.Effect<A, GatewayPlatformError, GatewayPlatformServices>;

export interface GatewayUserRecord {
  readonly name: string;
  readonly accountId: GatewayAccountId;
  readonly home: string;
}

export interface GatewayLayout {
  /** Versioned runtimes, plus the `current` and `previous` links. */
  readonly installRoot: string;
  /** The `t3` command users run, pointing at `<installRoot>/current`. */
  readonly launcher: string;
  readonly configPath: string;
  /** Holds one `<user>` folder per enrolled user. */
  readonly pairingDir: string;
  /** `t3` or `t3.exe`, beside the runtime directories. */
  readonly executableName: string;
  /** Entries the extracted CLI archive must have beside the executable. */
  readonly runtimeEntries: ReadonlyArray<readonly [name: string, type: "File" | "Directory"]>;
}

export type ConnectionOwner = (
  backendPort: number,
  clientPort: number,
) => Promise<GatewayAccountId | undefined>;

/** What `services.activate` needs to define and start everything for one runtime. */
export interface GatewayActivation {
  /** `<installRoot>/current/<executableName>`; service definitions point here, not at a version. */
  readonly executable: string;
  readonly config: GatewayConfig;
  readonly gatewayAccount: GatewayAccountId;
  /** Enrolled users that resolve to an OS account now; their backends are (re)defined. */
  readonly users: ReadonlyArray<GatewayUserRecord>;
  /** Puts the previous runtime back under `current`. Absent on a first install. */
  readonly restorePreviousRuntime:
    | Effect.Effect<void, GatewayPlatformError, GatewayPlatformServices>
    | undefined;
}

/**
 * OS-specific operations behind the multi-user gateway. Everything else (routing, proxying,
 * config, pairing markers, runtime staging, links, pruning) is shared and calls only these.
 */
export interface GatewayPlatform {
  readonly name: "linux" | "darwin" | "win32";
  readonly layout: GatewayLayout;

  /** The account this process runs as. */
  readonly currentAccount: Op<GatewayAccountId>;
  /** root on POSIX, an elevated Administrator (or LocalSystem) on Windows. */
  readonly isAdmin: Op<boolean>;
  /** An existing, non-system OS user with a home directory; fails with a message otherwise. */
  readonly lookupUser: (name: string) => Op<GatewayUserRecord>;
  /** The OS login name of an account id (for the helper's caller); fails when there is none. */
  readonly accountName: (accountId: GatewayAccountId) => Op<string>;

  /**
   * False when nothing exists at `path`. True when it is a `kind` entry that only admins can
   * modify. Fails when it exists but is the wrong kind or others could modify it.
   * `ancestor`: a parent of something trusted (POSIX allows a sticky shared parent).
   */
  readonly checkAdminOwned: (
    path: string,
    kind: "File" | "Directory",
    options?: { readonly ancestor?: boolean },
  ) => Op<boolean>;
  /**
   * Like checkAdminOwned, for the extracted CLI archive being installed: the admin who extracted
   * it may own it too (on POSIX the `SUDO_UID` user). Fails when untrusted.
   */
  readonly checkRuntimeSource: (
    path: string,
    kind: "File" | "Directory",
    options?: { readonly ancestor?: boolean },
  ) => Op<void>;
  /**
   * Creates `path` (and missing parents) or fixes an existing directory so only admins can write
   * it (`owner: "admin"`), or so only that user and admins can write it. Everyone can read it.
   */
  readonly secureDirectory: (path: string, owner: "admin" | GatewayUserRecord) => Op<void>;
  /**
   * Makes an installed runtime file, or a folder below a secured runtime root, readable by
   * everyone and executable when `executable`. Windows leaves both to the inherited root grants.
   */
  readonly secureRuntimeFile: (path: string, executable: boolean) => Op<void>;
  /** Removes a user's pairing folder without following links out of it. Absent is fine. */
  readonly removeTree: (path: string) => Op<void>;
  /** Atomically points `link` at `target` (a directory or the executable); creates or replaces. */
  readonly replaceLink: (target: string, link: string) => Op<void>;

  /** TCP listeners on this host, for port allocation and the post-install listen wait. */
  readonly listeners: Op<
    ReadonlyArray<{ readonly port: number; readonly owner: GatewayAccountId }>
  >;
  /**
   * Builds the per-connection owner check once, at gateway start. The returned function names the
   * account behind the accepting end of the gateway's loopback connection from `clientPort` to
   * `backendPort`, or undefined when unknown. It runs on the request path: fast, never rejects.
   */
  readonly makeConnectionOwner: Op<ConnectionOwner>;
  /**
   * How a pending-pairing marker is attributed to its user: "file-owner" compares the opened
   * file's owner with the user's account id; "folder" trusts the per-user folder, which only that
   * user and admins can write (Windows, where owner lookup is expensive).
   */
  readonly markerAttribution: "file-owner" | "folder";
  /**
   * Where the privileged helper (127.0.0.1:GATEWAY_HELPER_PORT) runs: "service" is an
   * inetd-style admin service running `t3 gateway helper` once per connection, with the accepted
   * socket as stdin; "gateway" is the gateway process itself, which already runs as an admin.
   */
  readonly helperHost: "service" | "gateway";
  /** Windows: registering a user's backend needs their password, so self-service join asks for it. */
  readonly joinNeedsPassword: boolean;

  readonly services: {
    /** The unprivileged account the gateway runs as (created when missing). */
    readonly ensureGatewayAccount: Op<GatewayAccountId>;
    /** Refuses before any change when unmanaged service definitions would be overwritten. */
    readonly preflight: Op<void>;
    /**
     * Writes the gateway's, the helper's (when `helperHost` is "service") and users' definitions
     * for `executable`, (re)starts the gateway, waits for it to listen, then restarts running
     * backends. On failure it restores the previous runtime and definitions and fails saying
     * whether rollback worked.
     */
    readonly activate: (activation: GatewayActivation) => Op<void>;
    /**
     * Defines (if needed), enables and starts one user's backend. `password` is the user's own
     * account password where `joinNeedsPassword`; without it the adapter asks on the terminal.
     */
    readonly enableUser: (
      user: GatewayUserRecord,
      executable: string,
      options?: { readonly password?: string },
    ) => Op<void>;
    /** Stops, disables and removes one user's backend definition. Absent is fine. */
    readonly disableUser: (user: string) => Op<void>;
    /** A short state for `t3 gateway list`, such as `active`, `running`, `stopped`, `unavailable`. */
    readonly userState: (user: string) => Op<string>;
    /**
     * Starts `argv` as an admin outside every gateway service under the managed name `label`, so
     * it survives the gateway and helper restarting; returns once it has started. Self-service
     * updates run the staged runtime's `gateway install` this way.
     */
    readonly runDetached: (label: string, argv: ReadonlyArray<string>) => Op<void>;
    /** Stops and removes every managed definition, the helper's included; keeps config, pairing data and accounts. */
    readonly uninstall: Op<void>;
    /** Where to look when the gateway fails, for error messages. */
    readonly logHint: string;
  };
}

const unsupportedPlatformMessage = (platform: string) =>
  `The T3 Code gateway is not supported on ${platform}.`;

export const currentGatewayPlatform = Effect.fn("GatewayPlatform.current")(function* () {
  const platform = yield* HostProcess.Platform;
  switch (platform) {
    case "linux":
      return (yield* Effect.promise(() => import("./linux.ts"))).linuxGatewayPlatform;
    case "darwin":
      return (yield* Effect.promise(() => import("./darwin.ts"))).darwinGatewayPlatform;
    case "win32":
      return (yield* Effect.promise(() => import("./win32.ts"))).win32GatewayPlatform;
    default:
      return yield* new GatewayPlatformError({ message: unsupportedPlatformMessage(platform) });
  }
});
