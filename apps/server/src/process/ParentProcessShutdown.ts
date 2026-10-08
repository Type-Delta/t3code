// @effect-diagnostics-next-line nodeBuiltinImport:off -- this type describes Node's stdin boundary.
import type * as NodeStream from "node:stream";

import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../config.ts";
import {
  decodeServiceLauncherParentMessage,
  SERVICE_LAUNCHER_CONTEXT_ENV,
} from "../cloud/serviceProtocol.ts";

interface ShutdownHost {
  readonly onMessage: (listener: (message: unknown) => void) => void;
  readonly offMessage: (listener: (message: unknown) => void) => void;
  readonly stdin: Pick<NodeStream.Readable, "on" | "off" | "resume" | "pause" | "readableEnded">;
}

export const ParentProcessShutdownHost = Context.Reference<ShutdownHost>(
  "t3/process/ParentProcessShutdownHost",
  {
    defaultValue: () => ({
      onMessage: (listener) => {
        process.on("message", listener);
      },
      offMessage: (listener) => {
        process.off("message", listener);
      },
      stdin: process.stdin,
    }),
  },
);

export class ParentProcessShutdown extends Context.Service<
  ParentProcessShutdown,
  { readonly awaitRequest: Effect.Effect<void> }
>()("t3/process/ParentProcessShutdown") {}

const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  if (platform !== "win32") return ParentProcessShutdown.of({ awaitRequest: Effect.never });
  const config = yield* ServerConfig;
  const environment = yield* HostProcessEnvironment;
  const host = yield* ParentProcessShutdownHost;
  const requested = yield* Deferred.make<void>();
  const request = () => Deferred.doneUnsafe(requested, Effect.void);

  if (environment[SERVICE_LAUNCHER_CONTEXT_ENV] !== undefined) {
    const onMessage = (value: unknown) => {
      if (decodeServiceLauncherParentMessage(value)?.type === "shutdown") request();
    };
    host.onMessage(onMessage);
    yield* Effect.addFinalizer(() => Effect.sync(() => host.offMessage(onMessage)));
  } else if (config.mode === "desktop" && config.desktopBootstrapToken !== undefined) {
    // Native desktop bootstrap uses fd3, leaving stdin as a shutdown pipe.
    // WSL bootstraps through stdin and retains its existing Linux signal path.
    host.stdin.on("end", request);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        host.stdin.off("end", request);
        host.stdin.pause();
      }),
    );
    host.stdin.resume();
    if (host.stdin.readableEnded) request();
  }
  return ParentProcessShutdown.of({ awaitRequest: Deferred.await(requested) });
});

export const layer = Layer.effect(ParentProcessShutdown, make);
