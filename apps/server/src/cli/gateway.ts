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
  gatewayPaths,
  listGatewayUsers,
  requireLinux,
  unenrollGatewayUser,
} from "../gateway/gatewayCliAdmin.ts";
import { installGateway, uninstallGateway } from "../gateway/gatewayInstall.ts";
import * as ProcessRunner from "../processRunner.ts";
import { renderTerminalQrCode } from "../startupAccess.ts";
import { serveCommand } from "./server.ts";

const userArgument = Argument.String("user").pipe(Argument.withSchema(GatewayUserName));

const gatewayInstall = Command.make("install").pipe(
  Command.withDescription(
    "Install or update the system-wide gateway from this Linux CLI archive. Requires root.",
  ),
  Command.withHandler(() => installGateway().pipe(Effect.provide(ProcessRunner.layer))),
);

const gatewayUninstall = Command.make("uninstall").pipe(
  Command.withDescription(
    "Remove the gateway services and runtime while keeping user data and config. Requires root.",
  ),
  Command.withHandler(() => uninstallGateway().pipe(Effect.provide(ProcessRunner.layer))),
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
      yield* requireLinux;
      const paths = yield* gatewayPaths;
      const { runGateway } = yield* Effect.promise(() => import("../gateway/GatewayServer.ts"));
      return yield* runGateway({
        configPath: Option.getOrElse(config, () => paths.configPath),
        pairingDir: paths.pairingDir,
      });
    }),
  ),
);

const gatewayRunBackend = Command.make("run-backend").pipe(
  Command.unlisted,
  Command.withHandler(() =>
    Command.runWith(serveCommand, { version: packageJson.version, renderErrors: false })([]).pipe(
      // Discard stock serve's stdout because it prints a one-time admin pairing link.
      Effect.updateService(Console.Console, (console) => ({ ...console, log: () => {} })),
      Effect.provideService(References.LogToStderr, true),
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
  Command.withDescription("Enroll a Linux user and start their backend. Requires root."),
  Command.withHandler(({ user, port }) =>
    enrollGatewayUser(user, Option.getOrUndefined(port)).pipe(
      Effect.provide(ProcessRunner.layer),
      Effect.flatMap((assignedPort) => Console.log(`${user} is enrolled on port ${assignedPort}.`)),
    ),
  ),
);

const gatewayRemove = Command.make("remove", { user: userArgument }).pipe(
  Command.withDescription("Stop and unenroll a Linux user's backend. Requires root."),
  Command.withHandler(({ user }) =>
    unenrollGatewayUser(user).pipe(
      Effect.provide(ProcessRunner.layer),
      Effect.andThen(Console.log(`${user} is no longer enrolled.`)),
    ),
  ),
);

const gatewayList = Command.make("list").pipe(
  Command.withDescription("List enrolled users and backend service states."),
  Command.withHandler(() =>
    listGatewayUsers().pipe(
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
        Option.getOrUndefined(ttl),
      );
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
  Command.withDescription("Run and manage a shared T3 Code gateway on Linux."),
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
