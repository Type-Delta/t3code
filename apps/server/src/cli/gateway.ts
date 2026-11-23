import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as References from "effect/References";
import { Argument, Command, Flag } from "effect/cli";

import packageJson from "../../package.json" with { type: "json" };
import { GatewayUserName } from "../gateway/GatewayConfig.ts";
import {
  enrollGatewayUser,
  GatewayCliError,
  gatewayPaths,
  listGatewayUsers,
  readGatewayConfig,
  unenrollGatewayUser,
} from "../gateway/gatewayCliAdmin.ts";
import { currentGatewayPlatform } from "../gateway/platform/GatewayPlatform.ts";
import { installGateway, uninstallGateway } from "../gateway/gatewayInstall.ts";
import * as ProcessRunner from "../processRunner.ts";
import { renderTerminalQrCode } from "../startupAccess.ts";
import { serveCommand } from "./server.ts";

const userArgument = Argument.String("user").pipe(Argument.withSchema(GatewayUserName));

const gatewayInstall = Command.make("install").pipe(
  Command.withDescription(
    "Install or update the system-wide gateway from this CLI archive. Requires an administrator.",
  ),
  Command.withHandler(() =>
    currentGatewayPlatform().pipe(
      Effect.flatMap(installGateway),
      Effect.provide(ProcessRunner.layer),
    ),
  ),
);

const gatewayUninstall = Command.make("uninstall").pipe(
  Command.withDescription(
    "Remove the gateway services and runtime while keeping user data and config. Requires an administrator.",
  ),
  Command.withHandler(() =>
    currentGatewayPlatform().pipe(
      Effect.flatMap(uninstallGateway),
      Effect.provide(ProcessRunner.layer),
    ),
  ),
);

const gatewayRun = Command.make("run", {
  config: Flag.String("config").pipe(
    Flag.withDescription("Path to the gateway config."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Run the multi-user gateway."),
  Command.withHandler(({ config }) =>
    Effect.gen(function* () {
      const paths = yield* gatewayPaths(yield* currentGatewayPlatform());
      const { runGateway } = yield* Effect.promise(() => import("../gateway/GatewayServer.ts"));
      return yield* runGateway({
        configPath: Option.getOrElse(config, () => paths.configPath),
        pairingDir: paths.pairingDir,
      });
    }).pipe(Effect.provide(ProcessRunner.layer)),
  ),
);

const backendPort = Effect.gen(function* () {
  const platform = yield* currentGatewayPlatform();
  const paths = yield* gatewayPaths(platform);
  const config = yield* readGatewayConfig(paths.configPath);
  const account = yield* platform.currentAccount.pipe(Effect.provide(ProcessRunner.layer));
  const entry = Object.values(config.users).find((candidate) => candidate.uid === account);
  if (entry === undefined) {
    return yield* new GatewayCliError({ message: "This account is not enrolled in the gateway." });
  }
  return entry.port;
});

// Flags, not environment: serve reads T3CODE_PORT through Config from the real process env.
const backendServeArguments = (port: number) => ["--host", "127.0.0.1", "--port", String(port)];

const gatewayRunBackend = Command.make("run-backend").pipe(
  Command.unlisted,
  Command.withHandler(() =>
    backendPort.pipe(
      Effect.flatMap((port) =>
        Command.runWith(serveCommand, { version: packageJson.version, renderErrors: false })(
          backendServeArguments(port),
        ).pipe(
          // Discard stock serve's stdout because it prints a one-time admin pairing link.
          Effect.updateService(Console.Console, (console) => ({ ...console, log: () => {} })),
          Effect.provideService(References.LogToStderr, true),
        ),
      ),
    ),
  ),
);

const gatewayAdd = Command.make("add", {
  user: userArgument,
  port: Flag.Int("port").pipe(
    Flag.withDescription("Backend port. Defaults to the first unused gateway port."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Enroll a user and start their backend. Requires an administrator."),
  Command.withHandler(({ user, port }) =>
    currentGatewayPlatform().pipe(
      Effect.flatMap((platform) => enrollGatewayUser(platform, user, Option.getOrUndefined(port))),
      Effect.provide(ProcessRunner.layer),
      Effect.flatMap((assignedPort) => Console.log(`${user} is enrolled on port ${assignedPort}.`)),
    ),
  ),
);

const gatewayRemove = Command.make("remove", { user: userArgument }).pipe(
  Command.withDescription("Stop and unenroll a user's backend. Requires an administrator."),
  Command.withHandler(({ user }) =>
    currentGatewayPlatform().pipe(
      Effect.flatMap((platform) => unenrollGatewayUser(platform, user)),
      Effect.provide(ProcessRunner.layer),
      Effect.andThen(Console.log(`${user} is no longer enrolled.`)),
    ),
  ),
);

const gatewayList = Command.make("list").pipe(
  Command.withDescription("List enrolled users and backend service states."),
  Command.withHandler(() =>
    currentGatewayPlatform().pipe(
      Effect.flatMap(listGatewayUsers),
      Effect.provide(ProcessRunner.layer),
      Effect.flatMap((users) =>
        Console.log(
          [
            "USER\tUID\tPORT\tSTATE",
            ...users.map(({ user, uid, port, state }) => `${user}\t${uid}\t${port}\t${state}`),
          ].join("\n"),
        ),
      ),
    ),
  ),
);

const gatewayPair = Command.make("pair", {
  ttl: Flag.String("ttl").pipe(
    Flag.withDescription(
      "Token TTL, for example 5m, 1h, or 15 minutes. Defaults to 5 minutes, with a maximum of 1 hour.",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Mint a pairing token for your backend and print its links and QR code."),
  Command.withHandler(({ ttl }) =>
    Effect.gen(function* () {
      const { pairThroughGateway } = yield* Effect.promise(
        () => import("../gateway/gatewayPairing.ts"),
      );
      const { pairingUrl, appLink, expiresAt } = yield* pairThroughGateway(
        yield* currentGatewayPlatform(),
        Option.getOrUndefined(ttl),
      ).pipe(Effect.provide(ProcessRunner.layer));
      yield* Console.log(
        [
          renderTerminalQrCode(appLink),
          "",
          `Pairing URL: ${pairingUrl}`,
          `App link: ${appLink}`,
          `Expires: ${DateTime.formatIso(expiresAt)}`,
        ].join("\n"),
      );
    }),
  ),
);

export const gatewayCommand = Command.make("gateway").pipe(
  Command.withDescription("Run and manage a shared T3 Code gateway."),
  Command.withSubcommands([
    gatewayInstall,
    gatewayUninstall,
    gatewayRun,
    gatewayRunBackend,
    gatewayAdd,
    gatewayRemove,
    gatewayList,
    gatewayPair,
  ]),
);
