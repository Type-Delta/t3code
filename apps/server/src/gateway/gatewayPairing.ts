import { isWildcardHost } from "@t3tools/shared/hostClassification";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { buildPairingAppLink } from "@t3tools/shared/remote";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command } from "effect/cli";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { FetchHttpClient } from "effect/http";

import packageJson from "../../package.json" with { type: "json" };
import { DurationFromString } from "../cli/config.ts";
import { pairCommand } from "../cli/pair.ts";
import { resolveBaseDir } from "../os-jank.ts";
import {
  buildPairingUrl,
  isLoopbackHost,
  resolveHeadlessConnectionString,
} from "../startupAccess.ts";
import {
  GatewayCliError,
  gatewayPaths,
  lockGatewayPath,
  readGatewayConfig,
} from "./gatewayCliAdmin.ts";
import {
  type GatewayConfig,
  GATEWAY_PENDING_MAX_MS,
  GatewayPendingPairing,
  GATEWAY_USER_QUERY_PARAM,
} from "./GatewayConfig.ts";
import { MAX_PENDING_FILES_PER_USER, PENDING_FILE_NAME } from "./GatewayPending.ts";
import type { GatewayAccountId, GatewayPlatform } from "./platform/GatewayPlatform.ts";

const pendingJson = Schema.fromJsonString(GatewayPendingPairing);
const decodePending = Schema.decodeOption(
  Schema.fromJsonString(
    Schema.Struct({
      version: GatewayPendingPairing.fields.version,
      expiresAt: GatewayPendingPairing.fields.expiresAt,
    }),
  ),
);
const encodePending = Schema.encodeEffect(pendingJson);
const decodeTtl = Schema.decodeEffect(DurationFromString);
const maxPairingTtl = Duration.millis(GATEWAY_PENDING_MAX_MS);

export const gatewayPairingOrigin = Effect.fn("gatewayPairing.origin")(function* (
  config: GatewayConfig,
  interfaces?: Parameters<typeof resolveHeadlessConnectionString>[2]["interfaces"],
) {
  const platform = yield* HostProcess.Platform;
  const baseUrl =
    config.publicUrl ??
    resolveHeadlessConnectionString(config.listen.host, config.listen.port, {
      privateNetworkOnly: true,
      platform,
      ...(interfaces === undefined ? {} : { interfaces }),
    });
  const url = URL.parse(baseUrl);
  if (url?.protocol === "https:") {
    return yield* new GatewayCliError({
      message:
        "HTTPS is unsupported because the gateway does not terminate TLS. Use an HTTP publicUrl.",
    });
  }
  if (
    url === null ||
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    (config.publicUrl === undefined &&
      isWildcardHost(config.listen.host) &&
      isLoopbackHost(url.hostname))
  ) {
    return yield* new GatewayCliError({
      message: "Set publicUrl in the gateway config to a reachable HTTP origin.",
    });
  }
  return url;
});

export const buildGatewayPairingLinks = (origin: URL, user: string, token: string) => {
  const taggedOrigin = new URL(origin);
  taggedOrigin.searchParams.set(GATEWAY_USER_QUERY_PARAM, user);
  const pairingUrl = buildPairingUrl(taggedOrigin.href, token);
  return { pairingUrl, appLink: buildPairingAppLink(pairingUrl) };
};

const cleanExpiredPending = Effect.fn("gatewayPairing.cleanExpired")(function* (
  platform: GatewayPlatform,
  directory: string,
  account: GatewayAccountId,
  now: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let remaining = 0;
  for (const name of yield* fs.readDirectory(directory)) {
    if (!PENDING_FILE_NAME.test(name)) continue;
    const pendingPath = path.join(directory, name);
    const info = yield* fs.lstat(pendingPath).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.undefined,
      ),
    );
    if (info?.type !== "File") continue;
    if (
      platform.markerAttribution === "file-owner" &&
      Option.getOrUndefined(info.uid) !== account
    ) {
      remaining++;
      continue;
    }
    const contents = yield* fs.readFileString(pendingPath).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(""),
      ),
    );
    const entry = decodePending(contents);
    if (Option.isSome(entry) && entry.value.expiresAt <= now) {
      yield* fs.remove(pendingPath, { force: true });
    } else {
      remaining++;
    }
  }
  return remaining;
});

export const registerPendingPairing = Effect.fn("gatewayPairing.registerPending")(
  function* (
    platform: GatewayPlatform,
    input: {
      readonly directory: string;
      readonly account: GatewayAccountId;
      readonly expiresAt: number;
      readonly token: string;
    },
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const random = yield* SecureRandom.SecureRandom;
    yield* lockGatewayPath(path.join(input.directory, ".pending"));
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (input.expiresAt <= now) {
      return yield* new GatewayCliError({
        message: "The pairing token expired before registration.",
      });
    }
    const remaining = yield* cleanExpiredPending(platform, input.directory, input.account, now);
    if (remaining >= MAX_PENDING_FILES_PER_USER) {
      return yield* new GatewayCliError({
        message: `Your pairing folder already has ${MAX_PENDING_FILES_PER_USER} pending pairings. Wait for a pairing code to expire and retry.`,
      });
    }

    const name = `${yield* random.uuidV4()}.json`;
    const digest = yield* Digest.Digest;
    const tokenSha256 = yield* digest.digestHex(
      Digest.sha256,
      new TextEncoder().encode(input.token),
    );
    const contents = yield* encodePending({
      version: 1,
      expiresAt: input.expiresAt,
      tokenSha256,
    });
    const staging = yield* fs.makeTempFileScoped({
      directory: input.directory,
      prefix: ".pending-",
    });
    yield* fs.writeFileString(staging, contents);
    yield* platform.secureRuntimeFile(staging, false);
    yield* fs.rename(staging, path.join(input.directory, name));
  },
  Effect.provide(Digest.layerWebCrypto),
  Effect.scoped,
);

const mintGatewayPairingToken = Effect.fn("gatewayPairing.mintToken")(function* (
  baseDir: string,
  port: number,
  ttl: string | undefined,
) {
  const expectedOrigin = new URL(`http://127.0.0.1:${port}`).origin;
  const fetch = yield* FetchHttpClient.Fetch;
  const loopbackFetch: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== expectedOrigin) {
      return Promise.reject(
        new GatewayCliError({ message: "The backend is on a different port." }),
      );
    }
    return fetch(input, { ...init, redirect: "error" });
  };

  // The stock command owns target discovery, protocol checking and token issuance.
  let output = "";
  yield* Command.runWith(pairCommand, { version: packageJson.version, renderErrors: false })([
    "--base-dir",
    baseDir,
    "--label",
    "t3 gateway pair",
    ...(ttl === undefined ? [] : ["--ttl", ttl]),
  ]).pipe(
    Effect.provideService(FetchHttpClient.Fetch, loopbackFetch),
    Effect.updateService(Console.Console, (console) => ({
      ...console,
      log: (...args: ReadonlyArray<unknown>) => {
        output += args.join(" ") + "\n";
      },
    })),
  );
  const token = /^Token: (\S+)$/m.exec(output)?.[1];
  const expiry = /^Expires: (\S+)$/m.exec(output)?.[1];
  const expiresAt = expiry === undefined ? Option.none() : DateTime.make(expiry);
  if (!token || Option.isNone(expiresAt)) {
    return yield* new GatewayCliError({
      message: "Could not read the token and expiry from t3 pair.",
    });
  }
  return { token, expiresAt: expiresAt.value };
});

export const pairThroughGateway = Effect.fn("gatewayPairing.pair")(function* (
  platform: GatewayPlatform,
  ttl?: string,
) {
  if (yield* platform.isAdmin) {
    return yield* new GatewayCliError({
      message: "Run t3 gateway pair as the enrolled user, not as an administrator.",
    });
  }
  const account = yield* platform.currentAccount;
  const { configPath, pairingDir } = yield* gatewayPaths(platform);
  const config = yield* readGatewayConfig(configPath);
  // Match by account id, not login name: Windows names are case-insensitive and keys are lowercase.
  const enrolled = Object.entries(config.users).find(([, candidate]) => candidate.uid === account);
  if (enrolled === undefined) {
    return yield* new GatewayCliError({
      message: "Your account is not enrolled in this gateway.",
    });
  }
  const [user, entry] = enrolled;
  if (ttl !== undefined) {
    const duration = yield* decodeTtl(ttl);
    if (Duration.isGreaterThan(duration, maxPairingTtl)) {
      return yield* new GatewayCliError({
        message: `Gateway pairing TTL cannot exceed ${Duration.format(maxPairingTtl)}.`,
      });
    }
  }
  const origin = yield* gatewayPairingOrigin(config);

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(pairingDir, user);
  const missingDirectory = () =>
    new GatewayCliError({
      message: `Your pairing folder is missing. Please ask an admin to run t3 gateway add ${user}.`,
    });
  yield* fs
    .access(directory, { writable: true })
    .pipe(Effect.catchIf((error) => error.reason._tag === "NotFound", missingDirectory));
  const baseDir = yield* resolveBaseDir(undefined);
  const { token, expiresAt } = yield* mintGatewayPairingToken(baseDir, entry.port, ttl);
  yield* registerPendingPairing(platform, {
    directory,
    account,
    token,
    expiresAt: DateTime.toEpochMillis(expiresAt),
  }).pipe(
    Effect.catchIf(
      (error) => error._tag === "PlatformError" && error.reason._tag === "NotFound",
      missingDirectory,
    ),
  );
  return { ...buildGatewayPairingLinks(origin, user, token), expiresAt };
});
